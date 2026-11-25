package acpclient

import (
	"context"
	"encoding/json"
)

// EventKind is the small, stable event vocabulary exposed to callers.
// It intentionally does not leak ACP wire type names.
type EventKind string

const (
	EventMessageDelta EventKind = "message_delta"
	EventThoughtDelta EventKind = "thought_delta"
	EventToolCall     EventKind = "tool_call"
	EventToolUpdate   EventKind = "tool_update"
	EventPlan         EventKind = "plan"
	EventNotice       EventKind = "notice"
)

// Event is a normalized ACP session update.
type Event struct {
	Kind      EventKind
	SessionID string
	Text      string
	ToolCall  *ToolCall
	Plan      []PlanEntry
	Notice    *Notice
}

type ToolCall struct {
	ID        string
	Title     string
	Name      string
	Kind      string
	Status    string
	RawInput  json.RawMessage
	RawOutput json.RawMessage
}

type PlanEntry struct {
	Content  string
	Priority string
	Status   string
}

type Notice struct {
	Title       string
	Description string
	Severity    string
}

type PermissionOption struct {
	ID   string
	Name string
	Kind string
}

type PermissionRequest struct {
	SessionID string
	ToolCall  ToolCall
	Options   []PermissionOption
}

type PermissionDecision struct {
	OptionID  string
	Cancelled bool
}

// FileSystem and TerminalHost are the capabilities the agent may use.
// Implementations are responsible for workspace confinement; the ACP client
// only translates protocol calls.
type FileSystem interface {
	ReadTextFile(ctx context.Context, path string, line, limit *int64) (string, error)
	WriteTextFile(ctx context.Context, path, content string) error
}

type TerminalSpec struct {
	Command         string
	Args            []string
	Cwd             string
	Env             []string
	OutputByteLimit *int64
}

type TerminalOutput struct {
	Output    string
	Truncated bool
	ExitCode  *int64
	Signal    string
}

type TerminalExit struct {
	ExitCode *int64
	Signal   string
}

type TerminalHost interface {
	Create(ctx context.Context, spec TerminalSpec) (string, error)
	Output(ctx context.Context, terminalID string) (TerminalOutput, error)
	Wait(ctx context.Context, terminalID string) (TerminalExit, error)
	Kill(ctx context.Context, terminalID string) error
	Release(ctx context.Context, terminalID string) error
}

type PermissionBroker interface {
	Authorize(ctx context.Context, request PermissionRequest) (PermissionDecision, error)
}

type EventSink interface {
	Publish(ctx context.Context, event Event) error
}

// FuncSink and FuncBroker keep call sites small without forcing test doubles
// to implement a struct for a one-method dependency.
type FuncSink func(context.Context, Event) error

func (f FuncSink) Publish(ctx context.Context, event Event) error {
	if f == nil {
		return nil
	}
	return f(ctx, event)
}

type FuncBroker func(context.Context, PermissionRequest) (PermissionDecision, error)

func (f FuncBroker) Authorize(ctx context.Context, request PermissionRequest) (PermissionDecision, error) {
	if f == nil {
		return PermissionDecision{Cancelled: true}, nil
	}
	return f(ctx, request)
}
