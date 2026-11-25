package acpclient

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"

	acp "github.com/coder/acp-go-sdk"
)

const defaultHandshakeTimeout = 30 * time.Second

// Config describes one ACP agent process and the capabilities exposed to it.
type Config struct {
	Command string
	Args    []string
	Dir     string
	Env     []string

	Files       FileSystem
	Terminals   TerminalHost
	Permissions PermissionBroker
	Events      EventSink

	// Model selects the agent's advertised model config option and Effort the
	// thinking-level option after session/new. Empty leaves the agent default
	// untouched; a value the agent does not advertise fails the handshake
	// instead of silently running a different model.
	Model  string
	Effort string

	ClientName    string
	ClientVersion string
	Handshake     time.Duration
}

// Transport lets the ACP JSON-RPC stream come from a remote connector instead
// of a child process while keeping the same session lifecycle.
type Transport interface {
	Reader() io.Reader
	Writer() io.Writer
	Close() error
	Stderr() string
}

// Session is one initialized ACP session. It is safe for one active Prompt;
// concurrent prompts are rejected by the ACP SDK/session and should be
// serialized by the owner.
type Session struct {
	conn      *acp.ClientSideConnection
	command   *exec.Cmd
	sessionID string
	stderr    *boundedBuffer
	transport Transport

	closeOnce sync.Once
	closeErr  error
}

// Start launches the agent, negotiates ACP and creates a session.
func Start(ctx context.Context, config Config) (*Session, error) {
	if strings.TrimSpace(config.Command) == "" {
		return nil, fmt.Errorf("ACP command is required")
	}
	command := exec.Command(config.Command, config.Args...)
	if config.Dir != "" {
		command.Dir = config.Dir
	}
	command.Env = agentEnvironment(config.Env)
	configureCommand(command)
	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("ACP stdin: %w", err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("ACP stdout: %w", err)
	}
	stderr := newBoundedBuffer(64 * 1024)
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		return nil, fmt.Errorf("start ACP agent: %w", err)
	}

	client := NewClient(config.Files, config.Terminals, config.Permissions, config.Events)
	conn := acp.NewClientSideConnection(client, stdin, stdout)
	session := &Session{conn: conn, command: command, stderr: stderr}
	if err := initializeSession(ctx, config, session, conn); err != nil {
		_ = session.Close()
		return nil, err
	}
	return session, nil
}

// StartTransport initializes the same ACP session over an injected stream.
// The remote connector owns the agent process; this process only speaks ACP.
func StartTransport(ctx context.Context, config Config, transport Transport) (*Session, error) {
	if transport == nil {
		return nil, fmt.Errorf("ACP transport is required")
	}
	if strings.TrimSpace(config.Dir) == "" {
		return nil, fmt.Errorf("ACP session cwd is required")
	}
	client := NewClient(config.Files, config.Terminals, config.Permissions, config.Events)
	conn := acp.NewClientSideConnection(client, transport.Writer(), transport.Reader())
	session := &Session{conn: conn, transport: transport}
	if err := initializeSession(ctx, config, session, conn); err != nil {
		_ = session.Close()
		return nil, err
	}
	return session, nil
}

func initializeSession(ctx context.Context, config Config, session *Session, conn *acp.ClientSideConnection) error {
	handshake := config.Handshake
	if handshake <= 0 {
		handshake = defaultHandshakeTimeout
	}
	handshakeCtx, cancel := context.WithTimeout(ctx, handshake)
	defer cancel()
	if _, err := conn.Initialize(handshakeCtx, acp.InitializeRequest{
		ProtocolVersion: acp.ProtocolVersionNumber,
		ClientCapabilities: acp.ClientCapabilities{
			Fs:       acp.FileSystemCapabilities{ReadTextFile: config.Files != nil, WriteTextFile: config.Files != nil},
			Terminal: config.Terminals != nil,
		},
		ClientInfo: &acp.Implementation{
			Name:    firstNonEmpty(config.ClientName, "aih-acp-client"),
			Version: firstNonEmpty(config.ClientVersion, "1"),
		},
	}); err != nil {
		return fmt.Errorf("ACP initialize: %w%s", err, session.errorSuffix())
	}
	created, err := conn.NewSession(handshakeCtx, acp.NewSessionRequest{
		Cwd:        config.Dir,
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		return fmt.Errorf("ACP session/new: %w%s", err, session.errorSuffix())
	}
	if strings.TrimSpace(string(created.SessionId)) == "" {
		return fmt.Errorf("ACP session/new returned an empty session id")
	}
	session.sessionID = string(created.SessionId)
	if err := applyModelSelection(handshakeCtx, conn, session.sessionID, created.ConfigOptions, config.Model, config.Effort); err != nil {
		return fmt.Errorf("%w%s", err, session.errorSuffix())
	}
	return nil
}

func (session *Session) SessionID() string { return session.sessionID }

// Prompt sends one user turn. ACP intentionally has no client-side prompt
// timeout: the owner decides how long a model turn may take.
func (session *Session) Prompt(ctx context.Context, text string) (string, error) {
	if session == nil || session.conn == nil {
		return "", fmt.Errorf("ACP session is not initialized")
	}
	if strings.TrimSpace(text) == "" {
		return "", fmt.Errorf("prompt is required")
	}
	response, err := session.conn.Prompt(ctx, acp.PromptRequest{
		SessionId: acp.SessionId(session.sessionID),
		Prompt:    []acp.ContentBlock{acp.TextBlock(text)},
	})
	if err != nil {
		return "", fmt.Errorf("ACP session/prompt: %w%s", err, session.errorSuffix())
	}
	return string(response.StopReason), nil
}

func (session *Session) Cancel(ctx context.Context) error {
	if session == nil || session.conn == nil {
		return nil
	}
	return session.conn.Cancel(ctx, acp.CancelNotification{SessionId: acp.SessionId(session.sessionID)})
}

// Close terminates the agent and its process group. It is idempotent.
func (session *Session) Close() error {
	if session == nil {
		return nil
	}
	session.closeOnce.Do(func() {
		if session.transport != nil {
			session.closeErr = session.transport.Close()
			return
		}
		session.closeErr = terminateCommand(session.command)
	})
	return session.closeErr
}

func (session *Session) errorSuffix() string {
	if session == nil {
		return ""
	}
	if session.transport != nil {
		text := strings.TrimSpace(session.transport.Stderr())
		if text == "" {
			return ""
		}
		if len(text) > 2000 {
			text = text[len(text)-2000:]
		}
		return ": " + text
	}
	return stderrSuffix(session.stderr)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func stderrSuffix(stderr *boundedBuffer) string {
	if stderr == nil {
		return ""
	}
	text, _ := stderr.snapshot()
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	if len(text) > 2000 {
		text = text[len(text)-2000:]
	}
	return ": " + text
}
