// Package remoteconnector defines the transport-neutral protocol shared by the
// AIH Server and a local Workspace Connector.
//
// The connector is intentionally not a Provider or Agent runtime. It owns only
// an explicitly selected local workspace and exposes capability-scoped RPC.
package remoteconnector

import "encoding/json"

const (
	MessageHello         = "hello"
	MessageHelloAccepted = "hello.accepted"
	MessageHeartbeat     = "heartbeat"
	MessageHeartbeatAck  = "heartbeat.ack"
	MessageStatus        = "status"
	MessageRequest       = "request"
	MessageResponse      = "response"
	MessageError         = "error"
	MessageGoodbye       = "goodbye"

	OperationReadFile       = "workspace.read_file"
	OperationWriteFile      = "workspace.write_file"
	OperationListDirectory  = "workspace.list_directory"
	OperationSearch         = "workspace.search"
	OperationRunCommand     = "workspace.run_command"
	OperationListApprovals  = "workspace.list_approvals"
	OperationDecideApproval = "workspace.decide_approval"
	OperationStartJob       = "workspace.start_job"
	OperationWatchJob       = "workspace.watch_job"
	OperationInterruptJob   = "workspace.interrupt_job"
	OperationStartAgentACP  = "workspace.agent_acp.start"
	OperationWriteAgentACP  = "workspace.agent_acp.write"
	OperationReadAgentACP   = "workspace.agent_acp.read"
	OperationCloseAgentACP  = "workspace.agent_acp.close"
)

const (
	CapabilityReadFile      = "workspace.read_file"
	CapabilityWriteFile     = "workspace.write_file"
	CapabilityListDirectory = "workspace.list_directory"
	CapabilitySearch        = "workspace.search"
	CapabilityRunCommand    = "workspace.run_command"
	CapabilityApproval      = "workspace.approval"
	CapabilityStartJob      = "workspace.start_job"
	CapabilityWatchJob      = "workspace.watch_job"
	CapabilityInterruptJob  = "workspace.interrupt_job"
	CapabilityAgentACP      = "workspace.agent_acp"
)

// Capabilities is a positive declaration. The server must still enforce the
// operation policy; this field is not an authorization grant by itself.
type Capabilities struct {
	ReadFile      bool     `json:"readFile"`
	WriteFile     bool     `json:"writeFile"`
	ListDirectory bool     `json:"listDirectory"`
	Search        bool     `json:"search"`
	RunCommand    bool     `json:"runCommand"`
	Approval      bool     `json:"approval"`
	StartJob      bool     `json:"startJob"`
	WatchJob      bool     `json:"watchJob"`
	InterruptJob  bool     `json:"interruptJob"`
	AgentACP      bool     `json:"agentAcp"`
	Names         []string `json:"names,omitempty"`
}

func (capabilities Capabilities) NamesOrDerived() []string {
	if len(capabilities.Names) > 0 {
		return append([]string(nil), capabilities.Names...)
	}
	result := make([]string, 0, 9)
	if capabilities.ReadFile {
		result = append(result, CapabilityReadFile)
	}
	if capabilities.WriteFile {
		result = append(result, CapabilityWriteFile)
	}
	if capabilities.ListDirectory {
		result = append(result, CapabilityListDirectory)
	}
	if capabilities.Search {
		result = append(result, CapabilitySearch)
	}
	if capabilities.RunCommand {
		result = append(result, CapabilityRunCommand)
	}
	if capabilities.Approval {
		result = append(result, CapabilityApproval)
	}
	if capabilities.StartJob {
		result = append(result, CapabilityStartJob)
	}
	if capabilities.WatchJob {
		result = append(result, CapabilityWatchJob)
	}
	if capabilities.InterruptJob {
		result = append(result, CapabilityInterruptJob)
	}
	if capabilities.AgentACP {
		result = append(result, CapabilityAgentACP)
	}
	return result
}

// Hello is the only message that may carry an enrollment or session token.
// Tokens must never be placed in URLs, command arguments or ordinary events.
type Hello struct {
	Type         string       `json:"type"`
	Token        string       `json:"token,omitempty"`
	SessionID    string       `json:"sessionId,omitempty"`
	WorkspaceID  string       `json:"workspaceId"`
	ConnectorID  string       `json:"connectorId,omitempty"`
	RootLabel    string       `json:"rootLabel,omitempty"`
	Platform     string       `json:"platform,omitempty"`
	Capabilities Capabilities `json:"capabilities"`
}

// Message is the framed WebSocket envelope. Payload is operation-specific JSON.
type Message struct {
	Type        string          `json:"type"`
	ID          string          `json:"id,omitempty"`
	Operation   string          `json:"operation,omitempty"`
	SessionID   string          `json:"sessionId,omitempty"`
	WorkspaceID string          `json:"workspaceId,omitempty"`
	State       string          `json:"state,omitempty"`
	Reason      string          `json:"reason,omitempty"`
	Payload     json.RawMessage `json:"payload,omitempty"`
	Error       *Error          `json:"error,omitempty"`
}

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message,omitempty"`
}

// ResponsePayload is used by connector RPC responses. Result is deliberately
// opaque at this layer so the runtime can evolve operations independently.
type ResponsePayload struct {
	Result json.RawMessage `json:"result,omitempty"`
	Error  *Error          `json:"error,omitempty"`
}

// HelloAccepted never returns a local absolute root path.
type HelloAccepted struct {
	Type         string       `json:"type"`
	SessionID    string       `json:"sessionId"`
	WorkspaceID  string       `json:"workspaceId"`
	ConnectorID  string       `json:"connectorId"`
	SessionToken string       `json:"sessionToken,omitempty"`
	Capabilities Capabilities `json:"capabilities"`
	HeartbeatSec int          `json:"heartbeatSec"`
}

// Status is a connector-owned liveness update. RootLabel is display-only.
type Status struct {
	Type         string       `json:"type"`
	State        string       `json:"state"`
	RootLabel    string       `json:"rootLabel,omitempty"`
	Platform     string       `json:"platform,omitempty"`
	Capabilities Capabilities `json:"capabilities"`
	Reason       string       `json:"reason,omitempty"`
}
