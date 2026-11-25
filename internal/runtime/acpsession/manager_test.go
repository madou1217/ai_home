package acpsession

import (
	"context"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/agy/acpclient"
)

type fakeRunner struct {
	sink        acpclient.EventSink
	permissions acpclient.PermissionBroker
	handle      *fakeHandle
}

func (runner *fakeRunner) Start(_ context.Context, _ StartRequest, sink acpclient.EventSink, permissions acpclient.PermissionBroker) (Handle, error) {
	runner.sink = sink
	runner.permissions = permissions
	runner.handle = &fakeHandle{}
	return runner.handle, nil
}

type fakeHandle struct {
	prompts []string
	closed  bool
}

func (handle *fakeHandle) Prompt(_ context.Context, text string) (string, error) {
	handle.prompts = append(handle.prompts, text)
	return "end_turn", nil
}

func (handle *fakeHandle) Close() error {
	handle.closed = true
	return nil
}

func TestManagerStartPromptAndEvents(t *testing.T) {
	runner := &fakeRunner{}
	manager, err := NewManager(runner)
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}
	view, err := manager.Start(context.Background(), StartRequest{WorkspaceID: "ws-1", Root: "/tmp/ws"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if view.Status != StatusReady || view.WorkspaceID != "ws-1" {
		t.Fatalf("view = %+v", view)
	}
	session, ok := manager.Get(view.ID)
	if !ok {
		t.Fatalf("session not found")
	}
	if err := runner.sink.Publish(context.Background(), acpclient.Event{Kind: acpclient.EventMessageDelta, Text: "hello"}); err != nil {
		t.Fatalf("Publish() error = %v", err)
	}
	snapshot, channel, cancel := session.Subscribe(0)
	defer cancel()
	if len(snapshot) < 2 {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	select {
	case event := <-channel:
		t.Fatalf("unexpected new event before prompt: %+v", event)
	default:
	}
	if _, err := session.Prompt(context.Background(), "run"); err != nil {
		t.Fatalf("Prompt() error = %v", err)
	}
	if len(runner.handle.prompts) != 1 || runner.handle.prompts[0] != "run" {
		t.Fatalf("prompts = %+v", runner.handle.prompts)
	}
	if err := session.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if !runner.handle.closed {
		t.Fatalf("handle was not closed")
	}
}

func TestManagerApprovalBlocksUntilDecision(t *testing.T) {
	runner := &fakeRunner{}
	manager, err := NewManager(runner)
	if err != nil {
		t.Fatalf("NewManager() error = %v", err)
	}
	view, err := manager.Start(context.Background(), StartRequest{WorkspaceID: "ws-1", Root: "/tmp/ws"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	session, _ := manager.Get(view.ID)
	decision := make(chan acpclient.PermissionDecision, 1)
	go func() {
		result, _ := runner.permissions.Authorize(context.Background(), acpclient.PermissionRequest{
			ToolCall: acpclient.ToolCall{ID: "call-1", Title: "Run tests"},
			Options:  []acpclient.PermissionOption{{ID: "allow", Kind: "allow_once"}, {ID: "reject", Kind: "reject_once"}},
		})
		decision <- result
	}()
	var approvalEvent Event
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		snapshot := session.eventsAfter(0)
		for _, event := range snapshot {
			if event.Type == "approval" && event.Approval != nil && event.Approval.Status == "pending" {
				approvalEvent = event
			}
		}
		if approvalEvent.Approval != nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if approvalEvent.Approval == nil {
		t.Fatalf("approval event not published")
	}
	if err := session.Decide(approvalEvent.Approval.ID, true); err != nil {
		t.Fatalf("Decide() error = %v", err)
	}
	select {
	case result := <-decision:
		if result.OptionID != "allow" {
			t.Fatalf("decision = %+v", result)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("approval did not unblock")
	}
}
