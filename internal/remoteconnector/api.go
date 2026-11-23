package remoteconnector

import "net/url"

// Management surface shared by the Server handler and every client. Keeping
// these paths here prevents the CLI from drifting from the route table.
const (
	ManagementPath    = "/v1/management/webui/workspace-connectors"
	EnrollmentsPath   = ManagementPath + "/enrollments"
	ConnectPath       = ManagementPath + "/connect"
	WorkspacePath     = ManagementPath + "/{workspaceId}"
	EntriesPath       = ManagementPath + "/{workspaceId}/entries"
	RPCPath           = ManagementPath + "/{workspaceId}/rpc"
	ToolPath          = ManagementPath + "/{workspaceId}/tools"
	ApprovalsPath     = ManagementPath + "/{workspaceId}/approvals"
	AgentTerminalPath = ManagementPath + "/{workspaceId}/agent-terminal"
)

// ToolTokenHeader authenticates a provider tool bridge. The token is scoped to
// one workspace and is never the connector session token or the management key.
const ToolTokenHeader = "X-AIH-Remote-Tools-Token"

// ToolPathFor builds the concrete tool endpoint for one workspace.
func ToolPathFor(workspaceID string) string {
	return ManagementPath + "/" + url.PathEscape(workspaceID) + "/tools"
}
