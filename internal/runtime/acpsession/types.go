package acpsession

import (
	"context"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/agy/acpclient"
)

const (
	StatusStarting        = "starting"
	StatusReady           = "ready"
	StatusPrompting       = "prompting"
	StatusWaitingApproval = "waiting_approval"
	StatusClosed          = "closed"
	StatusError           = "error"
)

// Event is the WebUI-facing event vocabulary. Wire-specific ACP types stay in
// acpclient; this package only depends on its normalized event types.
type Event struct {
	Seq      int64                 `json:"seq"`
	Type     string                `json:"type"`
	Text     string                `json:"text,omitempty"`
	ToolCall *acpclient.ToolCall   `json:"toolCall,omitempty"`
	Plan     []acpclient.PlanEntry `json:"plan,omitempty"`
	Notice   *acpclient.Notice     `json:"notice,omitempty"`
	Approval *Approval             `json:"approval,omitempty"`
	Status   string                `json:"status,omitempty"`
	Error    string                `json:"error,omitempty"`
}

type Approval struct {
	ID         string                       `json:"id"`
	ToolCallID string                       `json:"toolCallId"`
	Title      string                       `json:"title"`
	Options    []acpclient.PermissionOption `json:"options"`
	Status     string                       `json:"status"`
}

type SessionView struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspaceId"`
	Status      string `json:"status"`
	CreatedAt   int64  `json:"createdAt"`
}

type StartRequest struct {
	WorkspaceID string
	Root        string
	ToolsURL    string
	Token       string
	Command     string
	Args        []string
}

type Handle interface {
	Prompt(ctx context.Context, text string) (string, error)
	Close() error
}

// Runner separates the process/tool wiring from the session/event manager.
type Runner interface {
	Start(ctx context.Context, request StartRequest, events acpclient.EventSink, permissions acpclient.PermissionBroker) (Handle, error)
}

type EventSink = acpclient.EventSink
type PermissionBroker = acpclient.PermissionBroker
type PermissionRequest = acpclient.PermissionRequest
type PermissionDecision = acpclient.PermissionDecision

func nowMillis() int64 { return time.Now().UnixMilli() }
