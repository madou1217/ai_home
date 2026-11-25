package acpclient

import (
	"context"
	"fmt"
	"os"
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

	ClientName    string
	ClientVersion string
	Handshake     time.Duration
}

// Session is one initialized ACP session. It is safe for one active Prompt;
// concurrent prompts are rejected by the ACP SDK/session and should be
// serialized by the owner.
type Session struct {
	conn      *acp.ClientSideConnection
	command   *exec.Cmd
	sessionID string
	stderr    *boundedBuffer

	closeOnce sync.Once
	closeErr  error
}

// Start launches the agent, negotiates ACP and creates a session.
func Start(ctx context.Context, config Config) (*Session, error) {
	if strings.TrimSpace(config.Command) == "" {
		return nil, fmt.Errorf("ACP command is required")
	}
	handshake := config.Handshake
	if handshake <= 0 {
		handshake = defaultHandshakeTimeout
	}

	command := exec.Command(config.Command, config.Args...)
	if config.Dir != "" {
		command.Dir = config.Dir
	}
	command.Env = append(os.Environ(), config.Env...)
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
		_ = session.Close()
		return nil, fmt.Errorf("ACP initialize: %w%s", err, stderrSuffix(stderr))
	}

	created, err := conn.NewSession(handshakeCtx, acp.NewSessionRequest{
		Cwd:        config.Dir,
		McpServers: []acp.McpServer{},
	})
	if err != nil {
		_ = session.Close()
		return nil, fmt.Errorf("ACP session/new: %w%s", err, stderrSuffix(stderr))
	}
	if strings.TrimSpace(string(created.SessionId)) == "" {
		_ = session.Close()
		return nil, fmt.Errorf("ACP session/new returned an empty session id")
	}
	session.sessionID = string(created.SessionId)
	return session, nil
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
		return "", fmt.Errorf("ACP session/prompt: %w%s", err, stderrSuffix(session.stderr))
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
		session.closeErr = terminateCommand(session.command)
	})
	return session.closeErr
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
