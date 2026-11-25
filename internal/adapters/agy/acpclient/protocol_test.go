package acpclient

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	acp "github.com/coder/acp-go-sdk"
)

// fakeAgent exercises the client over a real ACP JSON-RPC connection. It is
// intentionally in-process: the wire format is the same, but the test needs no
// external AGY binary.
type fakeAgent struct {
	conn *acp.AgentSideConnection
}

func (agent *fakeAgent) Authenticate(context.Context, acp.AuthenticateRequest) (acp.AuthenticateResponse, error) {
	return acp.AuthenticateResponse{}, nil
}

func (agent *fakeAgent) Initialize(context.Context, acp.InitializeRequest) (acp.InitializeResponse, error) {
	return acp.InitializeResponse{ProtocolVersion: acp.ProtocolVersionNumber}, nil
}

func (agent *fakeAgent) Logout(context.Context, acp.LogoutRequest) (acp.LogoutResponse, error) {
	return acp.LogoutResponse{}, nil
}

func (agent *fakeAgent) Cancel(context.Context, acp.CancelNotification) error { return nil }
func (agent *fakeAgent) CloseSession(context.Context, acp.CloseSessionRequest) (acp.CloseSessionResponse, error) {
	return acp.CloseSessionResponse{}, nil
}
func (agent *fakeAgent) DeleteSession(context.Context, acp.DeleteSessionRequest) (acp.DeleteSessionResponse, error) {
	return acp.DeleteSessionResponse{}, nil
}
func (agent *fakeAgent) ListSessions(context.Context, acp.ListSessionsRequest) (acp.ListSessionsResponse, error) {
	return acp.ListSessionsResponse{}, nil
}
func (agent *fakeAgent) NewSession(context.Context, acp.NewSessionRequest) (acp.NewSessionResponse, error) {
	return acp.NewSessionResponse{SessionId: "session-1"}, nil
}
func (agent *fakeAgent) ResumeSession(context.Context, acp.ResumeSessionRequest) (acp.ResumeSessionResponse, error) {
	return acp.ResumeSessionResponse{}, nil
}
func (agent *fakeAgent) SetSessionConfigOption(context.Context, acp.SetSessionConfigOptionRequest) (acp.SetSessionConfigOptionResponse, error) {
	return acp.SetSessionConfigOptionResponse{}, nil
}
func (agent *fakeAgent) SetSessionMode(context.Context, acp.SetSessionModeRequest) (acp.SetSessionModeResponse, error) {
	return acp.SetSessionModeResponse{}, nil
}

func (agent *fakeAgent) Prompt(ctx context.Context, params acp.PromptRequest) (acp.PromptResponse, error) {
	if _, err := agent.conn.ReadTextFile(ctx, acp.ReadTextFileRequest{
		SessionId: params.SessionId,
		Path:      testWorkspacePath("input.txt"),
	}); err != nil {
		return acp.PromptResponse{}, err
	}
	if _, err := agent.conn.WriteTextFile(ctx, acp.WriteTextFileRequest{
		SessionId: params.SessionId,
		Path:      testWorkspacePath("output.txt"),
		Content:   "written",
	}); err != nil {
		return acp.PromptResponse{}, err
	}
	permission, err := agent.conn.RequestPermission(ctx, acp.RequestPermissionRequest{
		SessionId: params.SessionId,
		ToolCall:  acp.ToolCallUpdate{ToolCallId: "call-1"},
		Options: []acp.PermissionOption{{
			OptionId: "allow", Name: "Allow once", Kind: acp.PermissionOptionKindAllowOnce,
		}},
	})
	if err != nil {
		return acp.PromptResponse{}, err
	}
	if permission.Outcome.Selected == nil || string(permission.Outcome.Selected.OptionId) != "allow" {
		return acp.PromptResponse{}, io.ErrUnexpectedEOF
	}
	if err := agent.conn.SessionUpdate(ctx, acp.SessionNotification{
		SessionId: params.SessionId,
		Update: acp.SessionUpdate{
			AgentMessageChunk: &acp.SessionUpdateAgentMessageChunk{Content: acp.TextBlock("done")},
		},
	}); err != nil {
		return acp.PromptResponse{}, err
	}
	return acp.PromptResponse{StopReason: acp.StopReasonEndTurn}, nil
}

func TestClientACPProtocolRoundTrip(t *testing.T) {
	clientToAgentReader, clientToAgentWriter := io.Pipe()
	agentToClientReader, agentToClientWriter := io.Pipe()
	defer clientToAgentWriter.Close()
	defer agentToClientWriter.Close()

	files := &fakeFiles{content: "input"}
	var events []Event
	client := NewClient(files, nil, FuncBroker(func(context.Context, PermissionRequest) (PermissionDecision, error) {
		return PermissionDecision{OptionID: "allow"}, nil
	}), FuncSink(func(_ context.Context, event Event) error {
		events = append(events, event)
		return nil
	}))
	agent := &fakeAgent{}
	clientConn := acp.NewClientSideConnection(client, clientToAgentWriter, agentToClientReader)
	agent.conn = acp.NewAgentSideConnection(agent, agentToClientWriter, clientToAgentReader)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := clientConn.Initialize(ctx, acp.InitializeRequest{ProtocolVersion: acp.ProtocolVersionNumber}); err != nil {
		t.Fatalf("Initialize() error = %v", err)
	}
	created, err := clientConn.NewSession(ctx, acp.NewSessionRequest{Cwd: "/work", McpServers: []acp.McpServer{}})
	if err != nil {
		t.Fatalf("NewSession() error = %v", err)
	}
	response, err := clientConn.Prompt(ctx, acp.PromptRequest{
		SessionId: created.SessionId,
		Prompt:    []acp.ContentBlock{acp.TextBlock("run")},
	})
	if err != nil {
		t.Fatalf("Prompt() error = %v", err)
	}
	if response.StopReason != acp.StopReasonEndTurn {
		t.Fatalf("stopReason = %q, want end_turn", response.StopReason)
	}
	if files.wrote != "written" {
		t.Fatalf("wrote = %q, want written", files.wrote)
	}
	if len(events) != 1 || events[0].Kind != EventMessageDelta || !strings.Contains(events[0].Text, "done") {
		t.Fatalf("events = %+v", events)
	}
}

func testWorkspacePath(name string) string {
	root := os.Getenv("ACP_TEST_ROOT")
	if root == "" {
		return "/work/" + name
	}
	return filepath.Join(root, name)
}

// TestACPHelperProcess is the child-process half of TestRunnerStartsAgent.
// It behaves as an ACP agent and exits without the testing package printing
// PASS to stdout, which would corrupt the NDJSON channel.
func TestACPHelperProcess(t *testing.T) {
	if os.Getenv("ACP_HELPER") != "1" {
		return
	}
	agent := &fakeAgent{}
	conn := acp.NewAgentSideConnection(agent, os.Stdout, os.Stdin)
	agent.conn = conn
	<-conn.Done()
	os.Exit(0)
}

func TestRunnerStartsAgentAndExchangesTools(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "input.txt"), []byte("input"), 0o644); err != nil {
		t.Fatalf("write input: %v", err)
	}
	host, err := NewLocalWorkspaceHost(root)
	if err != nil {
		t.Fatalf("NewLocalWorkspaceHost() error = %v", err)
	}
	var events []Event
	session, err := Start(context.Background(), Config{
		Command:   os.Args[0],
		Args:      []string{"-test.run=TestACPHelperProcess"},
		Dir:       root,
		Env:       []string{"ACP_HELPER=1", "ACP_TEST_ROOT=" + root},
		Files:     host,
		Terminals: host,
		Permissions: FuncBroker(func(context.Context, PermissionRequest) (PermissionDecision, error) {
			return PermissionDecision{OptionID: "allow"}, nil
		}),
		Events: FuncSink(func(_ context.Context, event Event) error {
			events = append(events, event)
			return nil
		}),
		Handshake: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer func() { _ = session.Close() }()
	if session.SessionID() != "session-1" {
		t.Fatalf("session id = %q", session.SessionID())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	stopReason, err := session.Prompt(ctx, "run")
	if err != nil {
		t.Fatalf("Prompt() error = %v", err)
	}
	if stopReason != string(acp.StopReasonEndTurn) {
		t.Fatalf("stop reason = %q", stopReason)
	}
	content, err := os.ReadFile(filepath.Join(root, "output.txt"))
	if err != nil || string(content) != "written" {
		t.Fatalf("output file = %q, %v", content, err)
	}
	if len(events) != 1 || events[0].Kind != EventMessageDelta || events[0].Text != "done" {
		t.Fatalf("events = %+v", events)
	}
}

func TestAgentEnvironmentStripsManagementSecrets(t *testing.T) {
	t.Setenv("AIH_MANAGEMENT_KEY", "secret")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "secret")
	env := agentEnvironment([]string{"ACP_TEST_ROOT=/tmp/work"})
	joined := strings.Join(env, "\n")
	if strings.Contains(joined, "AIH_MANAGEMENT_KEY") || strings.Contains(joined, "AWS_SECRET_ACCESS_KEY") {
		t.Fatalf("agent environment leaked secrets: %v", env)
	}
	if !strings.Contains(joined, "ACP_TEST_ROOT=/tmp/work") {
		t.Fatalf("explicit env was dropped: %v", env)
	}
}
