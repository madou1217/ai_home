package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	connectorclient "github.com/madou1217/ai_home/internal/adapters/workspaceconnector"
	connectorapi "github.com/madou1217/ai_home/internal/adapters/workspaceconnectorapi"
	"github.com/madou1217/ai_home/internal/remoteconnector"
	"github.com/madou1217/ai_home/internal/transport/http/webuicontrolplaneapi"
)

// runWorkspaceCommand owns the local Workspace Connector command surface. The
// connector runs no provider or model; it only exposes one selected root.
func runWorkspaceCommand(ctx context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	if len(arguments) == 0 || arguments[0] != "workspace" {
		return false, nil
	}
	if len(arguments) < 2 || arguments[1] == "--help" || arguments[1] == "-h" {
		writeWorkspaceUsage(runtime.stdout)
		return true, nil
	}
	action := strings.ToLower(strings.TrimSpace(arguments[1]))
	switch action {
	case "connect", "ls", "list", "revoke", "enroll", "status":
	default:
		return true, fmt.Errorf("unknown workspace command: %s", action)
	}
	options, positionals, err := parseWorkspaceOptions(arguments[2:])
	if err != nil {
		return true, err
	}
	if options.help {
		writeWorkspaceUsage(runtime.stdout)
		return true, nil
	}
	client, profile, profileID, err := newWorkspaceClient(ctx, runtime, options.server)
	if err != nil {
		return true, err
	}
	switch action {
	case "connect":
		return true, runWorkspaceConnect(ctx, client, profile, profileID, options, runtime)
	case "ls", "list", "status":
		return true, runWorkspaceList(ctx, client, options, runtime)
	case "revoke":
		if len(positionals) != 1 || strings.TrimSpace(positionals[0]) == "" {
			return true, errors.New("用法: aih workspace revoke <workspaceId>")
		}
		return true, runWorkspaceRevoke(ctx, client, positionals[0], runtime)
	case "enroll":
		return true, runWorkspaceEnroll(ctx, client, options, runtime)
	default:
		return true, fmt.Errorf("unknown workspace command: %s", action)
	}
}

type workspaceOptions struct {
	server      string
	root        string
	label       string
	code        string
	jsonOutput  bool
	noReconnect bool
	noCommand   bool
	help        bool
}

func parseWorkspaceOptions(args []string) (workspaceOptions, []string, error) {
	options := workspaceOptions{}
	positionals := make([]string, 0)
	for index := 0; index < len(args); index++ {
		token := strings.TrimSpace(args[index])
		switch {
		case token == "--json":
			options.jsonOutput = true
		case token == "--no-reconnect":
			options.noReconnect = true
		case token == "--no-command":
			options.noCommand = true
		case token == "--help" || token == "-h":
			options.help = true
		case strings.HasPrefix(token, "--"):
			name, value, consumed, err := parseWorkspaceOption(args, index)
			if err != nil {
				return workspaceOptions{}, nil, err
			}
			index += consumed - 1
			switch name {
			case "--server":
				options.server = value
			case "--root":
				options.root = value
			case "--label":
				options.label = value
			case "--code":
				options.code = value
			default:
				return workspaceOptions{}, nil, fmt.Errorf("unknown option: %s", name)
			}
		default:
			positionals = append(positionals, token)
		}
	}
	return options, positionals, nil
}

// parseWorkspaceOption accepts a token that begins with '-' for --code because
// base64url enrollment codes and session tokens may legitimately start with '-'.
func parseWorkspaceOption(args []string, index int) (string, string, int, error) {
	token := strings.TrimSpace(args[index])
	if equal := strings.IndexByte(token, '='); equal > 0 {
		name := token[:equal]
		value := strings.TrimSpace(token[equal+1:])
		if value == "" {
			return "", "", 0, fmt.Errorf("%s requires a value", name)
		}
		return name, value, 1, nil
	}
	if index+1 >= len(args) {
		return "", "", 0, fmt.Errorf("%s requires a value", token)
	}
	value := strings.TrimSpace(args[index+1])
	if value == "" {
		return "", "", 0, fmt.Errorf("%s requires a value", token)
	}
	if token != "--code" && strings.HasPrefix(value, "-") {
		return "", "", 0, fmt.Errorf("%s requires a value", token)
	}
	return token, value, 2, nil
}

func newWorkspaceClient(ctx context.Context, runtime commandRuntime, requestedServer string) (*connectorapi.Client, map[string]any, string, error) {
	home, err := resolveAIHome(runtime)
	if err != nil {
		return nil, nil, "", err
	}
	store, err := webuicontrolplaneapi.ListProfiles(ctx, home)
	if err != nil {
		return nil, nil, "", fmt.Errorf("read server profiles: %w", err)
	}
	profile, profileID, err := selectRemoteProfile(store, requestedServer)
	if err != nil {
		return nil, nil, "", err
	}
	client, err := connectorapi.New(runtime.managementAPI, connectorapi.Config{
		BaseURL:       textValueFromMap(profile, "endpoint"),
		ManagementKey: textValueFromMap(profile, "managementKey"),
	})
	if err != nil {
		return nil, nil, "", errors.New("selected Server profile has no usable management connection")
	}
	return client, profile, profileID, nil
}

func runWorkspaceConnect(ctx context.Context, client *connectorapi.Client, profile map[string]any, profileID string, options workspaceOptions, runtime commandRuntime) error {
	connectCtx, stop := signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
	defer stop()
	root := strings.TrimSpace(options.root)
	if root == "" {
		root = "."
	}
	absoluteRoot, err := filepath.Abs(root)
	if err != nil {
		return errors.New("workspace root is invalid")
	}
	label := strings.TrimSpace(options.label)
	if label == "" {
		label = filepath.Base(absoluteRoot)
	}
	endpoint := textValueFromMap(profile, "endpoint")
	home, err := resolveAIHome(runtime)
	if err != nil {
		return err
	}
	sessions, err := openWorkspaceSessionStore(home)
	if err != nil {
		return err
	}
	token := strings.TrimSpace(options.code)
	workspaceID := ""
	connectorID := ""
	if token == "" {
		if saved, found := sessions.Find(profileID, endpoint, absoluteRoot); found {
			token, workspaceID, connectorID = saved.Token, saved.WorkspaceID, saved.ConnectorID
		}
	}
	if token == "" {
		enrollment, enrollErr := client.CreateEnrollment(connectCtx, label, 0)
		if enrollErr != nil {
			return workspaceCLIError(enrollErr)
		}
		token = enrollment.Code
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] workspace enrollment created for %s (expires %s)\n",
			label, time.UnixMilli(enrollment.ExpiresAt).Format(time.RFC3339))
	}
	config := connectorclient.Config{
		Endpoint: endpoint, Root: absoluteRoot, Label: label,
		Token: token, WorkspaceID: workspaceID, ConnectorID: connectorID,
		DisableCommand: options.noCommand,
		OnSession: func(session connectorclient.Session) error {
			return sessions.Save(workspaceSession{
				ServerProfileID: profileID, Endpoint: endpoint, Root: absoluteRoot,
				Label: session.Label, WorkspaceID: session.WorkspaceID,
				ConnectorID: session.ConnectorID, Token: session.SessionToken,
				UpdatedAt: time.Now().UnixMilli(),
			})
		},
	}
	dial := func() (*connectorclient.Connector, error) {
		return connectorclient.Dial(connectCtx, config)
	}
	connector, err := dial()
	if err != nil {
		if connectCtx.Err() != nil {
			return cliExitCode{code: 130}
		}
		return workspaceCLIError(err)
	}
	defer func() {
		if connector != nil {
			connector.Close()
		}
	}()
	printWorkspaceConnected(runtime.stdout, connector.Session())
	attempts := 0
	for {
		serveErr := connector.Serve(connectCtx)
		if connectCtx.Err() != nil {
			return cliExitCode{code: 130}
		}
		connector.Close()
		if workspacePermanent(serveErr) {
			return workspaceCLIError(serveErr)
		}
		if options.noReconnect {
			return workspaceCLIError(serveErr)
		}
		attempts++
		delay := workspaceBackoff(attempts)
		_, _ = fmt.Fprintf(runtime.stderr, "[aih] workspace disconnected: %v; reconnecting in %s\n", serveErr, delay.Round(time.Second))
		select {
		case <-connectCtx.Done():
			return cliExitCode{code: 130}
		case <-time.After(delay):
		}
		config.Token = connector.Session().SessionToken
		config.WorkspaceID = connector.Session().WorkspaceID
		config.ConnectorID = connector.Session().ConnectorID
		next, dialErr := dial()
		if dialErr != nil {
			if connectCtx.Err() != nil {
				return cliExitCode{code: 130}
			}
			if workspacePermanent(dialErr) {
				return workspaceCLIError(dialErr)
			}
			_, _ = fmt.Fprintf(runtime.stderr, "[aih] reconnect failed: %v\n", dialErr)
			continue
		}
		connector = next
		attempts = 0
		printWorkspaceConnected(runtime.stdout, connector.Session())
	}
}

func runWorkspaceList(ctx context.Context, client *connectorapi.Client, options workspaceOptions, runtime commandRuntime) error {
	response, err := client.List(ctx)
	if err != nil {
		return workspaceCLIError(err)
	}
	if options.jsonOutput {
		return writeWorkspaceJSON(runtime, response)
	}
	if len(response.Workspaces) == 0 {
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] no workspace connectors enrolled")
		return nil
	}
	for _, workspace := range response.Workspaces {
		lastSeen := ""
		if workspace.LiveLastSeenAt > 0 {
			lastSeen = " lastSeen=" + time.UnixMilli(workspace.LiveLastSeenAt).Format(time.RFC3339)
		} else if workspace.LastSeenAt > 0 {
			lastSeen = " lastSeen=" + time.UnixMilli(workspace.LastSeenAt).Format(time.RFC3339)
		}
		_, _ = fmt.Fprintf(runtime.stdout, "%s  state=%s  label=%s  root=%s  platform=%s%s\n",
			workspace.ID, workspace.State, workspace.Label, workspace.RootLabel, workspace.Platform, lastSeen)
	}
	return nil
}

func runWorkspaceRevoke(ctx context.Context, client *connectorapi.Client, workspaceID string, runtime commandRuntime) error {
	workspaceID = strings.TrimSpace(workspaceID)
	if err := client.Revoke(ctx, workspaceID); err != nil {
		return workspaceCLIError(err)
	}
	if home, err := resolveAIHome(runtime); err == nil {
		if sessions, storeErr := openWorkspaceSessionStore(home); storeErr == nil {
			_, _ = sessions.RemoveByWorkspaceID(workspaceID)
		}
	}
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] workspace revoked: %s\n", workspaceID)
	return nil
}

func runWorkspaceEnroll(ctx context.Context, client *connectorapi.Client, options workspaceOptions, runtime commandRuntime) error {
	label := strings.TrimSpace(options.label)
	if label == "" {
		label = "workspace"
	}
	enrollment, err := client.CreateEnrollment(ctx, label, 0)
	if err != nil {
		return workspaceCLIError(err)
	}
	if options.jsonOutput {
		return writeWorkspaceJSON(runtime, map[string]any{"ok": true, "enrollment": enrollment})
	}
	_, _ = fmt.Fprintf(runtime.stdout, "workspace enrollment: %s\n", enrollment.ID)
	_, _ = fmt.Fprintf(runtime.stdout, "code: %s\n", enrollment.Code)
	_, _ = fmt.Fprintf(runtime.stdout, "expires: %s\n", time.UnixMilli(enrollment.ExpiresAt).Format(time.RFC3339))
	_, _ = fmt.Fprintln(runtime.stdout, "code 只显示一次；在目标机器上运行 aih workspace connect --server <profile> --code <code>")
	return nil
}

func printWorkspaceConnected(output io.Writer, session connectorclient.Session) {
	command := "off"
	if remoteconnector.NormalizeCapabilities(session.Capabilities).RunCommand {
		command = "on"
	}
	_, _ = fmt.Fprintf(output, "[aih] workspace connected: %s connector=%s root=%s platform=%s command=%s\n",
		session.WorkspaceID, session.ConnectorID, session.Root, session.Platform, command)
}

func workspaceCLIError(err error) error {
	if err == nil {
		return nil
	}
	var protocolErr *remoteconnector.ProtocolError
	if errors.As(err, &protocolErr) {
		hint := ""
		if remoteconnector.IsPermanent(protocolErr.Code) {
			hint = "; 重新运行 aih workspace connect，或先用 aih workspace enroll 生成新的 enrollment code"
		}
		return fmt.Errorf("%s: %s%s", protocolErr.Code, protocolErr.Message, hint)
	}
	var remoteErr connectorapi.RemoteError
	if errors.As(err, &remoteErr) {
		return fmt.Errorf("%s: %s", remoteErr.Code, remoteErr.Message)
	}
	return fmt.Errorf("workspace_connector_unavailable: %w", err)
}

func workspacePermanent(err error) bool {
	var protocolErr *remoteconnector.ProtocolError
	if errors.As(err, &protocolErr) {
		return remoteconnector.IsPermanent(protocolErr.Code)
	}
	var remoteErr connectorapi.RemoteError
	if errors.As(err, &remoteErr) {
		return remoteErr.StatusCode == 401 || remoteErr.StatusCode == 403 || remoteErr.StatusCode == 409
	}
	return false
}

func workspaceBackoff(attempts int) time.Duration {
	delay := time.Second
	for index := 1; index < attempts && delay < 30*time.Second; index++ {
		delay *= 2
	}
	if delay > 30*time.Second {
		delay = 30 * time.Second
	}
	return delay
}

func writeWorkspaceJSON(runtime commandRuntime, payload any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintln(runtime.stdout, string(encoded))
	return nil
}

func writeWorkspaceUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih workspace connect [--server <profile>] [--root <dir>] [--label <name>] [--code <code>] [--no-reconnect] [--no-command]")
	_, _ = fmt.Fprintln(output, "  aih workspace ls [--server <profile>] [--json]")
	_, _ = fmt.Fprintln(output, "  aih workspace enroll [--server <profile>] [--label <name>] [--json]")
	_, _ = fmt.Fprintln(output, "  aih workspace revoke <workspaceId> [--server <profile>]")
	_, _ = fmt.Fprintln(output, "说明:")
	_, _ = fmt.Fprintln(output, "  connect 只暴露显式选中的本地目录；不启动任何 Provider、模型或 Agent。")
	_, _ = fmt.Fprintln(output, "  --code 使用一次性 enrollment code；不传时复用本机保存的会话，首次运行自动创建 enrollment。")
	_, _ = fmt.Fprintln(output, "  --no-command 关闭 run_command：Agent 只能读写文件，不能在本机执行命令。")
}
