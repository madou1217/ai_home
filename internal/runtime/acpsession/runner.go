package acpsession

import (
	"context"
	"fmt"

	"github.com/madou1217/ai_home/internal/adapters/agy/acpclient"
)

// ConnectorRunner starts AGY's ACP server against a Workspace Connector host.
type ConnectorRunner struct {
	Command string
}

func NewConnectorRunner(command string) *ConnectorRunner {
	if command == "" {
		command = "agy"
	}
	return &ConnectorRunner{Command: command}
}

func (runner *ConnectorRunner) Start(ctx context.Context, request StartRequest, events acpclient.EventSink, permissions acpclient.PermissionBroker) (Handle, error) {
	if request.ToolsURL == "" || request.Token == "" {
		return nil, fmt.Errorf("workspace connector tool token is required")
	}
	client := acpclient.NewHTTPToolClient(request.ToolsURL, request.Token, nil)
	host, err := acpclient.NewConnectorHost(request.Root, client)
	if err != nil {
		return nil, err
	}
	command := request.Command
	if command == "" {
		command = runner.Command
	}
	args := request.Args
	if len(args) == 0 {
		args = []string{"acp"}
	}
	session, err := acpclient.Start(ctx, acpclient.Config{
		Command:       command,
		Args:          args,
		Dir:           host.Root(),
		Files:         host,
		Terminals:     host,
		Permissions:   permissions,
		Events:        events,
		ClientName:    "aih-webui",
		ClientVersion: "1",
	})
	if err != nil {
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
