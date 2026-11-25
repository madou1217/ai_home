package workspaceconnector

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/madou1217/ai_home/internal/remoteconnector"
)

const (
	agentACPDefaultWait = 5 * time.Second
	agentACPMaxWait     = 30 * time.Second
	agentACPMaxBuffer   = 8 * 1024 * 1024
)

// agentACPManager runs ACP agents on the Connector host. The Server never
// supplies a command: the connector's owner opts in with --agent-acp and
// chooses the binary. The Server only selects a workspace-relative cwd.
type agentACPManager struct {
	root    string
	command string

	nextID atomic.Uint64
	mu     sync.Mutex
	items  map[string]*agentACPSession
}

type agentACPSession struct {
	id     string
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	waitMu sync.Mutex
	done   chan struct{}

	mu      sync.Mutex
	data    bytes.Buffer
	eof     bool
	errText string
	notify  chan struct{}
}

func newAgentACPManager(root, command string) *agentACPManager {
	return &agentACPManager{root: root, command: command, items: map[string]*agentACPSession{}}
}

func (manager *agentACPManager) start(ctx context.Context, raw json.RawMessage) (remoteconnector.StartAgentACPResult, error) {
	var request remoteconnector.StartAgentACPRequest
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &request); err != nil {
			return remoteconnector.StartAgentACPResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPayload, "invalid agent start request")
		}
	}
	cwd := strings.TrimSpace(request.Cwd)
	if cwd == "" {
		cwd = "."
	}
	target := manager.root
	if cwd != "." {
		target = filepath.Join(manager.root, filepath.FromSlash(cwd))
	}
	rel, err := filepath.Rel(manager.root, target)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return remoteconnector.StartAgentACPResult{}, remoteconnector.NewProtocolError(remoteconnector.CodePathOutsideWorkspace, "cwd escapes the workspace root")
	}
	resolved, err := filepath.EvalSymlinks(target)
	if err != nil {
		return remoteconnector.StartAgentACPResult{}, remoteconnector.NewProtocolError(remoteconnector.CodePathNotFound, "agent cwd does not exist")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return remoteconnector.StartAgentACPResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPath, "agent cwd must be a directory")
	}
	command := exec.CommandContext(context.Background(), manager.command, "acp")
	command.Dir = resolved
	command.Env = os.Environ()
	configureCommand(command)
	stdin, err := command.StdinPipe()
	if err != nil {
		return remoteconnector.StartAgentACPResult{}, err
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return remoteconnector.StartAgentACPResult{}, err
	}
	session := &agentACPSession{
		id:  fmt.Sprintf("agent-acp-%d", manager.nextID.Add(1)),
		cmd: command, stdin: stdin, done: make(chan struct{}), notify: make(chan struct{}, 1),
	}
	var stderr bytes.Buffer
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		_ = stdin.Close()
		return remoteconnector.StartAgentACPResult{}, err
	}
	manager.mu.Lock()
	manager.items[session.id] = session
	manager.mu.Unlock()
	go session.readLoop(stdout, &stderr)
	return remoteconnector.StartAgentACPResult{SessionID: session.id, Cwd: resolved}, nil
}

func (session *agentACPSession) readLoop(stdout io.Reader, stderr *bytes.Buffer) {
	defer close(session.done)
	buffer := make([]byte, 32*1024)
	for {
		n, err := stdout.Read(buffer)
		if n > 0 {
			session.mu.Lock()
			if session.data.Len() < agentACPMaxBuffer {
				_, _ = session.data.Write(buffer[:n])
			} else {
				session.errText = "agent output exceeded the buffer limit"
			}
			session.mu.Unlock()
			session.signal()
		}
		if err != nil {
			session.mu.Lock()
			session.eof = true
			if stderr.Len() > 0 {
				session.errText = strings.TrimSpace(stderr.String())
			}
			session.mu.Unlock()
			session.signal()
			return
		}
	}
}

func (session *agentACPSession) signal() {
	select {
	case session.notify <- struct{}{}:
	default:
	}
}

func (manager *agentACPManager) write(raw json.RawMessage) error {
	var request remoteconnector.WriteAgentACPRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPayload, "invalid agent write request")
	}
	session, err := manager.get(request.SessionID)
	if err != nil {
		return err
	}
	data, err := base64.StdEncoding.DecodeString(request.Data)
	if err != nil {
		return remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPayload, "agent data is not base64")
	}
	if len(data) == 0 {
		return nil
	}
	if _, err := session.stdin.Write(data); err != nil {
		return remoteconnector.NewProtocolError(remoteconnector.CodeConnectorDisconnected, "agent stdin is closed")
	}
	return nil
}

func (manager *agentACPManager) read(ctx context.Context, raw json.RawMessage) (remoteconnector.ReadAgentACPResult, error) {
	var request remoteconnector.ReadAgentACPRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return remoteconnector.ReadAgentACPResult{}, remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPayload, "invalid agent read request")
	}
	session, err := manager.get(request.SessionID)
	if err != nil {
		return remoteconnector.ReadAgentACPResult{}, err
	}
	wait := time.Duration(request.WaitMS) * time.Millisecond
	if wait <= 0 {
		wait = agentACPDefaultWait
	}
	if wait > agentACPMaxWait {
		wait = agentACPMaxWait
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	for {
		session.mu.Lock()
		if session.data.Len() > 0 {
			data := append([]byte(nil), session.data.Bytes()...)
			session.data.Reset()
			eof := session.eof
			errText := session.errText
			session.mu.Unlock()
			return remoteconnector.ReadAgentACPResult{Data: base64.StdEncoding.EncodeToString(data), EOF: eof, Error: errText}, nil
		}
		eof := session.eof
		errText := session.errText
		session.mu.Unlock()
		if eof {
			return remoteconnector.ReadAgentACPResult{EOF: true, Error: errText}, nil
		}
		select {
		case <-session.notify:
		case <-timer.C:
			return remoteconnector.ReadAgentACPResult{}, nil
		case <-ctx.Done():
			return remoteconnector.ReadAgentACPResult{}, ctx.Err()
		}
	}
}

func (manager *agentACPManager) close(raw json.RawMessage) error {
	var request remoteconnector.CloseAgentACPRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		return remoteconnector.NewProtocolError(remoteconnector.CodeInvalidPayload, "invalid agent close request")
	}
	manager.mu.Lock()
	session := manager.items[request.SessionID]
	delete(manager.items, request.SessionID)
	manager.mu.Unlock()
	if session == nil {
		return nil
	}
	session.close()
	return nil
}

func (manager *agentACPManager) get(id string) (*agentACPSession, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	session := manager.items[id]
	if session == nil {
		return nil, remoteconnector.NewProtocolError(remoteconnector.CodeWorkspaceNotFound, "agent session not found")
	}
	return session, nil
}

func (manager *agentACPManager) closeAll() {
	manager.mu.Lock()
	sessions := make([]*agentACPSession, 0, len(manager.items))
	for id, session := range manager.items {
		sessions = append(sessions, session)
		delete(manager.items, id)
	}
	manager.mu.Unlock()
	for _, session := range sessions {
		session.close()
	}
}

func (session *agentACPSession) close() {
	session.waitMu.Lock()
	defer session.waitMu.Unlock()
	_ = session.stdin.Close()
	_ = terminateCommand(session.cmd)
	select {
	case <-session.done:
	case <-time.After(3 * time.Second):
	}
}
