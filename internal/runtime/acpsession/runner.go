package acpsession

import (
	"context"

	"github.com/madou1217/ai_home/internal/adapters/agy/acpclient"
	"github.com/madou1217/ai_home/internal/runtime/workspaceconnector"
)

// ConnectorRunner runs the ACP agent inside the Workspace Connector host.
// The agent therefore sees the real workspace; the Server only carries JSON-RPC
// and approval decisions.
type ConnectorRunner struct {
	hub *workspaceconnector.Hub
}

func NewConnectorRunner(hub *workspaceconnector.Hub) *ConnectorRunner {
	return &ConnectorRunner{hub: hub}
}

func (runner *ConnectorRunner) Start(ctx context.Context, request StartRequest, events acpclient.EventSink, permissions acpclient.PermissionBroker) (Handle, error) {
	transport, cwd, err := StartConnectorTransport(ctx, runner.hub, request.WorkspaceID)
	if err != nil {
		return nil, err
	}
	session, err := acpclient.StartTransport(ctx, acpclient.Config{
		Dir:           cwd,
		Permissions:   permissions,
		Events:        events,
		ClientName:    "aih-webui",
		ClientVersion: "1",
	}, transport)
	if err != nil {
		_ = transport.Close()
		return nil, err
	}
	return &acpHandle{session: session}, nil
}

type acpHandle struct {
	session *acpclient.Session
}

func (handle *acpHandle) Prompt(ctx context.Context, text string) (string, error) {
	return handle.session.Prompt(ctx, text)
}

func (handle *acpHandle) Close() error {
	return handle.session.Close()
}
