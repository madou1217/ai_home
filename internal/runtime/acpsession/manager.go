package acpsession

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/madou1217/ai_home/internal/adapters/agy/acpclient"
)

// Manager owns in-memory ACP sessions and their event/approval state.
// Persistence and restart are deliberately out of scope for the first UI slice.
type Manager struct {
	runner Runner

	nextID atomic.Uint64
	mu     sync.Mutex
	items  map[string]*Session
}

func NewManager(runner Runner) (*Manager, error) {
	if runner == nil {
		return nil, fmt.Errorf("acp session runner is required")
	}
	return &Manager{runner: runner, items: map[string]*Session{}}, nil
}

func (manager *Manager) Start(ctx context.Context, request StartRequest) (SessionView, error) {
	if strings.TrimSpace(request.WorkspaceID) == "" {
		return SessionView{}, fmt.Errorf("workspace id is required")
	}
	id := fmt.Sprintf("acp-%d", manager.nextID.Add(1))
	session := newSession(id, request.WorkspaceID)
	manager.mu.Lock()
	manager.items[id] = session
	manager.mu.Unlock()

	handle, err := manager.runner.Start(ctx, request, session, session)
	if err != nil {
		manager.mu.Lock()
		delete(manager.items, id)
		manager.mu.Unlock()
		return SessionView{}, err
	}
	session.setHandle(handle)
	session.publish(Event{Type: "status", Status: StatusReady})
	return session.View(), nil
}

func (manager *Manager) Get(id string) (*Session, bool) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	session, ok := manager.items[id]
	return session, ok
}

func (manager *Manager) Close(id string) error {
	session, ok := manager.Get(id)
	if !ok {
		return fmt.Errorf("acp session not found")
	}
	return session.Close()
}

func (manager *Manager) List() []SessionView {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	views := make([]SessionView, 0, len(manager.items))
	for _, session := range manager.items {
		views = append(views, session.View())
	}
	return views
}

// Session is both the event sink and permission broker for one ACP process.
type Session struct {
	id          string
	workspaceID string
	createdAt   int64

	mu           sync.Mutex
	status       string
	events       []Event
	seq          int64
	subs         map[chan Event]struct{}
	approvals    map[string]*pendingApproval
	handle       Handle
	closed       bool
	done         chan struct{}
	promptMu     sync.Mutex
	closeOnce    sync.Once
	nextApproval atomic.Uint64
}

type pendingApproval struct {
	approval Approval
	decision chan bool
}

func newSession(id, workspaceID string) *Session {
	return &Session{
		id:          id,
		workspaceID: workspaceID,
		createdAt:   nowMillis(),
		status:      StatusStarting,
		subs:        map[chan Event]struct{}{},
		approvals:   map[string]*pendingApproval{},
		done:        make(chan struct{}),
	}
}

func (session *Session) ID() string          { return session.id }
func (session *Session) WorkspaceID() string { return session.workspaceID }
func (session *Session) Status() string {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.status
}

func (session *Session) setHandle(handle Handle) {
	session.mu.Lock()
	session.handle = handle
	session.mu.Unlock()
}

func (session *Session) View() SessionView {
	session.mu.Lock()
	defer session.mu.Unlock()
	return SessionView{ID: session.id, WorkspaceID: session.workspaceID, Status: session.status, CreatedAt: session.createdAt}
}

func (session *Session) eventsAfter(after int64) []Event {
	session.mu.Lock()
	defer session.mu.Unlock()
	result := make([]Event, 0, len(session.events))
	for _, event := range session.events {
		if event.Seq > after {
			result = append(result, event)
		}
	}
	return result
}

func (session *Session) Subscribe(after int64) ([]Event, <-chan Event, func()) {
	session.mu.Lock()
	defer session.mu.Unlock()
	snapshot := make([]Event, 0, len(session.events))
	for _, event := range session.events {
		if event.Seq > after {
			snapshot = append(snapshot, event)
		}
	}
	channel := make(chan Event, 128)
	session.subs[channel] = struct{}{}
	cancel := func() {
		session.mu.Lock()
		delete(session.subs, channel)
		session.mu.Unlock()
	}
	return snapshot, channel, cancel
}

func (session *Session) publish(event Event) {
	session.mu.Lock()
	if event.Seq == 0 {
		session.seq++
		event.Seq = session.seq
	}
	if event.Status != "" {
		session.status = event.Status
	}
	session.events = append(session.events, event)
	if len(session.events) > 1000 {
		session.events = append([]Event(nil), session.events[len(session.events)-1000:]...)
	}
	subs := make([]chan Event, 0, len(session.subs))
	for channel := range session.subs {
		subs = append(subs, channel)
	}
	session.mu.Unlock()
	for _, channel := range subs {
		select {
		case channel <- event:
		default:
		}
	}
}

// Publish implements acpclient.EventSink.
func (session *Session) Publish(_ context.Context, event acpclient.Event) error {
	kind := "message"
	switch event.Kind {
	case acpclient.EventMessageDelta:
		kind = "message"
	case acpclient.EventThoughtDelta:
		kind = "thought"
	case acpclient.EventToolCall:
		kind = "tool_call"
	case acpclient.EventToolUpdate:
		kind = "tool_update"
	case acpclient.EventPlan:
		kind = "plan"
	case acpclient.EventNotice:
		kind = "notice"
	}
	session.publish(Event{
		Type:     kind,
		Text:     event.Text,
		ToolCall: event.ToolCall,
		Plan:     event.Plan,
		Notice:   event.Notice,
	})
	return nil
}

// Authorize implements acpclient.PermissionBroker. It blocks the agent until
// the WebUI approves or rejects the one-time request.
func (session *Session) Authorize(ctx context.Context, request acpclient.PermissionRequest) (acpclient.PermissionDecision, error) {
	id := fmt.Sprintf("%s-approval-%d", session.id, session.nextApproval.Add(1))
	approval := Approval{
		ID:         id,
		ToolCallID: request.ToolCall.ID,
		Title:      request.ToolCall.Title,
		Options:    request.Options,
		Status:     "pending",
	}
	pending := &pendingApproval{approval: approval, decision: make(chan bool, 1)}
	session.mu.Lock()
	session.approvals[id] = pending
	session.mu.Unlock()
	session.publish(Event{Type: "approval", Approval: &approval})

	select {
	case approve := <-pending.decision:
		session.mu.Lock()
		delete(session.approvals, id)
		session.mu.Unlock()
		status := "rejected"
		if approve {
			status = "approved"
		}
		updated := approval
		updated.Status = status
		session.publish(Event{Type: "approval", Approval: &updated})
		if !approve {
			return acpclient.PermissionDecision{Cancelled: true}, nil
		}
		if option := allowOption(request.Options); option != "" {
			return acpclient.PermissionDecision{OptionID: option}, nil
		}
		return acpclient.PermissionDecision{Cancelled: true}, nil
	case <-ctx.Done():
		session.mu.Lock()
		delete(session.approvals, id)
		session.mu.Unlock()
		updated := approval
		updated.Status = "cancelled"
		session.publish(Event{Type: "approval", Approval: &updated})
		return acpclient.PermissionDecision{Cancelled: true}, ctx.Err()
	case <-session.done:
		return acpclient.PermissionDecision{Cancelled: true}, fmt.Errorf("acp session closed")
	}
}

func allowOption(options []acpclient.PermissionOption) string {
	for _, kind := range []string{"allow_once", "allow_always"} {
		for _, option := range options {
			if option.Kind == kind {
				return option.ID
			}
		}
	}
	return ""
}

func (session *Session) Decide(approvalID string, approve bool) error {
	session.mu.Lock()
	pending, ok := session.approvals[approvalID]
	session.mu.Unlock()
	if !ok {
		return fmt.Errorf("approval not found or already decided")
	}
	select {
	case pending.decision <- approve:
		return nil
	default:
		return fmt.Errorf("approval is already being decided")
	}
}

func (session *Session) Prompt(ctx context.Context, text string) (string, error) {
	if strings.TrimSpace(text) == "" {
		return "", fmt.Errorf("prompt is required")
	}
	session.promptMu.Lock()
	defer session.promptMu.Unlock()

	session.mu.Lock()
	handle := session.handle
	closed := session.closed
	session.mu.Unlock()
	if closed || handle == nil {
		return "", fmt.Errorf("acp session is not available")
	}
	session.publish(Event{Type: "user", Text: text, Status: StatusPrompting})
	stopReason, err := handle.Prompt(ctx, text)
	if err != nil {
		session.publish(Event{Type: "error", Error: err.Error(), Status: StatusError})
		return "", err
	}
	session.publish(Event{Type: "status", Status: StatusReady})
	return stopReason, nil
}

func (session *Session) Close() error {
	session.closeOnce.Do(func() {
		session.mu.Lock()
		session.closed = true
		handle := session.handle
		session.mu.Unlock()
		close(session.done)
		if handle != nil {
			_ = handle.Close()
		}
		session.publish(Event{Type: "status", Status: StatusClosed})
	})
	return nil
}
