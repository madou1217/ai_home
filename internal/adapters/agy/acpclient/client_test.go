package acpclient

import (
	"context"
	"strings"
	"testing"

	acp "github.com/coder/acp-go-sdk"
)

type fakeFiles struct {
	content string
	wrote   string
}

func (fake *fakeFiles) ReadTextFile(context.Context, string, *int64, *int64) (string, error) {
	return fake.content, nil
}

func (fake *fakeFiles) WriteTextFile(_ context.Context, _, content string) error {
	fake.wrote = content
	return nil
}

func TestClientFileMethodsDelegate(t *testing.T) {
	files := &fakeFiles{content: "hello"}
	client := NewClient(files, nil, nil, nil)
	read, err := client.ReadTextFile(context.Background(), acp.ReadTextFileRequest{Path: "/work/a.txt", SessionId: "s"})
	if err != nil || read.Content != "hello" {
		t.Fatalf("ReadTextFile() = %+v, %v", read, err)
	}
	if _, err := client.WriteTextFile(context.Background(), acp.WriteTextFileRequest{Path: "/work/a.txt", Content: "next", SessionId: "s"}); err != nil {
		t.Fatalf("WriteTextFile() error = %v", err)
	}
	if files.wrote != "next" {
		t.Fatalf("wrote = %q, want next", files.wrote)
	}
}

func TestClientPermissionSelectsBrokerOption(t *testing.T) {
	client := NewClient(nil, nil, FuncBroker(func(context.Context, PermissionRequest) (PermissionDecision, error) {
		return PermissionDecision{OptionID: "allow"}, nil
	}), nil)
	response, err := client.RequestPermission(context.Background(), acp.RequestPermissionRequest{
		SessionId: "s",
		Options: []acp.PermissionOption{
			{OptionId: "allow", Name: "Allow once", Kind: acp.PermissionOptionKindAllowOnce},
			{OptionId: "reject", Name: "Reject", Kind: acp.PermissionOptionKindRejectOnce},
		},
	})
	if err != nil {
		t.Fatalf("RequestPermission() error = %v", err)
	}
	if response.Outcome.Selected == nil || string(response.Outcome.Selected.OptionId) != "allow" {
		t.Fatalf("outcome = %+v, want allow", response.Outcome)
	}
}

func TestClientPermissionFailsClosed(t *testing.T) {
	client := NewClient(nil, nil, FuncBroker(func(context.Context, PermissionRequest) (PermissionDecision, error) {
		return PermissionDecision{Cancelled: true}, nil
	}), nil)
	response, err := client.RequestPermission(context.Background(), acp.RequestPermissionRequest{
		SessionId: "s",
		Options:   []acp.PermissionOption{{OptionId: "allow", Name: "Allow", Kind: acp.PermissionOptionKindAllowOnce}},
	})
	if err != nil {
		t.Fatalf("RequestPermission() error = %v", err)
	}
	if response.Outcome.Cancelled == nil {
		t.Fatalf("outcome = %+v, want cancelled", response.Outcome)
	}
}

func TestClientSessionUpdateMapsEvents(t *testing.T) {
	var events []Event
	client := NewClient(nil, nil, nil, FuncSink(func(_ context.Context, event Event) error {
		events = append(events, event)
		return nil
	}))
	if err := client.SessionUpdate(context.Background(), acp.SessionNotification{
		SessionId: "s",
		Update: acp.SessionUpdate{
			AgentMessageChunk: &acp.SessionUpdateAgentMessageChunk{Content: acp.TextBlock("hello")},
		},
	}); err != nil {
		t.Fatalf("SessionUpdate() error = %v", err)
	}
	if len(events) != 1 || events[0].Kind != EventMessageDelta || events[0].Text != "hello" {
		t.Fatalf("events = %+v", events)
	}

	events = nil
	if err := client.SessionUpdate(context.Background(), acp.SessionNotification{
		SessionId: "s",
		Update: acp.SessionUpdate{
			ToolCall: &acp.SessionUpdateToolCall{
				ToolCallId: "call-1",
				Title:      "Run tests",
				Status:     acp.ToolCallStatusInProgress,
			},
		},
	}); err != nil {
		t.Fatalf("SessionUpdate(tool) error = %v", err)
	}
	if len(events) != 1 || events[0].Kind != EventToolCall || events[0].ToolCall == nil || events[0].ToolCall.ID != "call-1" {
		t.Fatalf("tool events = %+v", events)
	}
}

func TestLocalWorkspaceHostRejectsRelativePath(t *testing.T) {
	host, err := NewLocalWorkspaceHost(t.TempDir())
	if err != nil {
		t.Fatalf("NewLocalWorkspaceHost() error = %v", err)
	}
	_, err = host.ReadTextFile(context.Background(), "relative.txt", nil, nil)
	if err == nil || !strings.Contains(err.Error(), "absolute") {
		t.Fatalf("relative read error = %v", err)
	}
	if _, err := host.Output(context.Background(), "missing"); err == nil {
		t.Fatalf("unknown terminal should return an error")
	}
}
