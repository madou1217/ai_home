package remoteconnector

// Management surface shared by the Server handler and every client. Keeping
// these paths here prevents the CLI from drifting from the route table.
const (
	ManagementPath  = "/v1/management/webui/workspace-connectors"
	EnrollmentsPath = ManagementPath + "/enrollments"
	ConnectPath     = ManagementPath + "/connect"
	WorkspacePath   = ManagementPath + "/{workspaceId}"
	EntriesPath     = ManagementPath + "/{workspaceId}/entries"
	RPCPath         = ManagementPath + "/{workspaceId}/rpc"
)
