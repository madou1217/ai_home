package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/remoteexecutionapi"
	"github.com/madou1217/ai_home/internal/remoteexecution"
	"github.com/madou1217/ai_home/internal/transport/http/webuicontrolplaneapi"
)

const remoteTargetHTTPTimeout = 10 * time.Second

// runRemoteCommand owns only the CLI grammar. It delegates transport, target
// selection and preflight semantics to the remote execution API adapter/domain.
func runRemoteCommand(ctx context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	if len(arguments) == 0 || arguments[0] != "remote" {
		return false, nil
	}
	if len(arguments) < 2 || arguments[1] == "--help" || arguments[1] == "-h" {
		writeRemoteUsage(runtime.stdout)
		return true, nil
	}
	if arguments[1] != "target" {
		return true, fmt.Errorf("unknown remote command: %s", arguments[1])
	}
	if len(arguments) < 3 || arguments[2] == "--help" || arguments[2] == "-h" {
		writeRemoteUsage(runtime.stdout)
		return true, nil
	}
	action := strings.ToLower(strings.TrimSpace(arguments[2]))
	options, err := parseRemoteTargetOptions(arguments[3:])
	if err != nil {
		return true, err
	}
	if options.help {
		writeRemoteUsage(runtime.stdout)
		return true, nil
	}
	client, selector, err := newRemoteTargetClient(ctx, runtime, options)
	if err != nil {
		return true, err
	}
	switch action {
	case "ls", "list":
		return true, runRemoteTargetList(ctx, client, selector, options, runtime)
	case "resolve":
		return true, runRemoteTargetResolve(ctx, client, selector, options, runtime, false)
	case "doctor", "preflight":
		return true, runRemoteTargetResolve(ctx, client, selector, options, runtime, true)
	default:
		return true, fmt.Errorf("unknown remote target command: %s", action)
	}
}

type remoteTargetOptions struct {
	server     string
	workspace  string
	connection string
	harness    string
	provider   string
	account    string
	model      string
	serverID   string
	jsonOutput bool
	help       bool
}

func parseRemoteTargetOptions(args []string) (remoteTargetOptions, error) {
	options := remoteTargetOptions{}
	for index := 0; index < len(args); index++ {
		token := strings.TrimSpace(args[index])
		switch {
		case token == "--json":
			options.jsonOutput = true
		case token == "--help" || token == "-h":
			options.help = true
		case strings.HasPrefix(token, "--"):
			name, value, consumed, err := parseRemoteOption(args, index)
			if err != nil {
				return remoteTargetOptions{}, err
			}
			index += consumed - 1
			switch name {
			case "--server":
				options.server = value
			case "--workspace":
				options.workspace = value
			case "--connection":
				options.connection = value
			case "--harness":
				options.harness = value
			case "--provider":
				options.provider = value
			case "--account":
				options.account = value
			case "--model":
				options.model = value
			case "--server-id":
				options.serverID = value
			default:
				return remoteTargetOptions{}, fmt.Errorf("unknown option: %s", name)
			}
		default:
			return remoteTargetOptions{}, fmt.Errorf("unexpected argument: %s", token)
		}
	}
	return options, nil
}

func parseRemoteOption(args []string, index int) (string, string, int, error) {
	token := strings.TrimSpace(args[index])
	if equal := strings.IndexByte(token, '='); equal > 0 {
		name := token[:equal]
		value := strings.TrimSpace(token[equal+1:])
		if value == "" {
			return "", "", 0, fmt.Errorf("%s requires a value", name)
		}
		return name, value, 1, nil
	}
	if index+1 >= len(args) || strings.HasPrefix(strings.TrimSpace(args[index+1]), "-") {
		return "", "", 0, fmt.Errorf("%s requires a value", token)
	}
	return token, strings.TrimSpace(args[index+1]), 2, nil
}

func newRemoteTargetClient(ctx context.Context, runtime commandRuntime, options remoteTargetOptions) (*remoteexecutionapi.Client, remoteexecution.TargetSelector, error) {
	home, err := resolveAIHome(runtime)
	if err != nil {
		return nil, remoteexecution.TargetSelector{}, err
	}
	store, err := webuicontrolplaneapi.ListProfiles(ctx, home)
	if err != nil {
		return nil, remoteexecution.TargetSelector{}, fmt.Errorf("read server profiles: %w", err)
	}
	profile, profileID, err := selectRemoteProfile(store, options.server)
	if err != nil {
		return nil, remoteexecution.TargetSelector{}, err
	}
	client, err := remoteexecutionapi.New(runtime.managementAPI, remoteexecutionapi.Config{
		BaseURL:       textValueFromMap(profile, "endpoint"),
		ManagementKey: textValueFromMap(profile, "managementKey"),
	})
	if err != nil {
		return nil, remoteexecution.TargetSelector{}, errors.New("selected Server profile has no usable management connection")
	}
	selector := remoteexecution.TargetSelector{
		ServerProfileID: profileID,
		ServerID:        options.serverID,
		WorkspaceID:     options.workspace,
		ConnectionID:    options.connection,
		Harness:         options.harness,
		Provider:        options.provider,
		AccountRef:      options.account,
		Model:           options.model,
	}
	return client, selector, nil
}

func selectRemoteProfile(store map[string]any, requested string) (map[string]any, string, error) {
	requested = strings.TrimSpace(requested)
	activeID := textValueFromMap(store, "activeProfileId")
	if requested == "" {
		requested = activeID
	}
	if requested == "" {
		return nil, "", errors.New("no active Server profile; use --server or aih server use")
	}
	profile := findServerProfile(store, requested)
	if profile == nil {
		return nil, "", fmt.Errorf("server profile not found: %s", requested)
	}
	id := textValueFromMap(profile, "id")
	if id == "" {
		return nil, "", errors.New("selected Server profile has no stable id")
	}
	return profile, id, nil
}

func runRemoteTargetList(ctx context.Context, client *remoteexecutionapi.Client, selector remoteexecution.TargetSelector, options remoteTargetOptions, runtime commandRuntime) error {
	response, err := client.List(ctx, selector)
	if err != nil {
		return remoteTargetCLIError(err)
	}
	if options.jsonOutput {
		return writeRemoteJSON(runtime, response)
	}
	if len(response.Candidates) == 0 {
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] no remote execution targets")
		return nil
	}
	for _, candidate := range response.Candidates {
		status := candidate.Preflight.Status()
		failed := strings.Join(candidate.Preflight.FailedStages(), ",")
		if failed != "" {
			failed = " blocked=" + failed
		}
		_, _ = fmt.Fprintf(runtime.stdout, "%s  workspace=%s  harness=%s  provider=%s  account=%s  model=%s  status=%s%s\n",
			candidate.ID, candidate.Workspace.ID, candidate.Runner.ID, candidate.Model.Provider,
			candidate.Account.AccountRef, displayRemoteModel(candidate.Model), status, failed)
	}
	return nil
}

func runRemoteTargetResolve(ctx context.Context, client *remoteexecutionapi.Client, selector remoteexecution.TargetSelector, options remoteTargetOptions, runtime commandRuntime, preflight bool) error {
	response, err := client.Resolve(ctx, selector)
	if preflight {
		response, err = client.Preflight(ctx, selector)
	}
	if err != nil {
		return remoteTargetCLIError(err)
	}
	if options.jsonOutput {
		return writeRemoteJSON(runtime, response)
	}
	target := response.Resolution.Target
	_, _ = fmt.Fprintf(runtime.stdout, "target=%s server=%s workspace=%s harness=%s provider=%s account=%s model=%s\n",
		target.ID, target.ServerID, target.WorkspaceID, target.Harness, target.Provider,
		target.AccountRef, displayTargetModel(target))
	_, _ = fmt.Fprintf(runtime.stdout, "preflight=%s\n", response.Resolution.Preflight.Status())
	for _, stage := range response.Resolution.Preflight.Stages {
		if stage.Status == remoteexecution.StatusOK {
			_, _ = fmt.Fprintf(runtime.stdout, "  %s: ok\n", stage.Name)
			continue
		}
		_, _ = fmt.Fprintf(runtime.stdout, "  %s: %s (%s) %s\n", stage.Name, stage.Status, stage.Code, stage.Detail)
	}
	return nil
}

func remoteTargetCLIError(err error) error {
	var remoteErr remoteexecutionapi.RemoteError
	if errors.As(err, &remoteErr) {
		if remoteErr.Code == "" {
			return errors.New("remote_catalog_unavailable")
		}
		return fmt.Errorf("%s: %s", remoteErr.Code, remoteErr.Message)
	}
	return fmt.Errorf("remote_catalog_unavailable: %w", err)
}

func writeRemoteJSON(runtime commandRuntime, payload any) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintln(runtime.stdout, string(encoded))
	return nil
}

func displayRemoteModel(model remoteexecution.ModelFact) string {
	if model.CLIModelName != "" && model.CLIModelName != model.CatalogModelID {
		return model.CatalogModelID + " (cli=" + model.CLIModelName + ")"
	}
	return model.CatalogModelID
}

func displayTargetModel(target remoteexecution.ExecutionTarget) string {
	if target.CLIModelName != "" && target.CLIModelName != target.CatalogModelID {
		return target.CatalogModelID + " (cli=" + target.CLIModelName + ")"
	}
	return target.CatalogModelID
}

func writeRemoteUsage(output interface{ Write([]byte) (int, error) }) {
	_, _ = fmt.Fprintln(output, "用法:")
	_, _ = fmt.Fprintln(output, "  aih remote target ls [--server <profile>] [--json]")
	_, _ = fmt.Fprintln(output, "  aih remote target resolve [selectors]")
	_, _ = fmt.Fprintln(output, "  aih remote target doctor [selectors]")
	_, _ = fmt.Fprintln(output, "选择器:")
	_, _ = fmt.Fprintln(output, "  --server <profile>      本地 Server Profile；默认当前 active profile")
	_, _ = fmt.Fprintln(output, "  --server-id <id>        远端 AIH Server durable identity")
	_, _ = fmt.Fprintln(output, "  --workspace <id>        SSH workspace identity")
	_, _ = fmt.Fprintln(output, "  --connection <id>       SSH connection identity")
	_, _ = fmt.Fprintln(output, "  --harness <id>          远端 Agent/Harness")
	_, _ = fmt.Fprintln(output, "  --provider <id>         远端 Provider")
	_, _ = fmt.Fprintln(output, "  --account <ref>         远端 account ref")
	_, _ = fmt.Fprintln(output, "  --model <id|cli-name>   远端 catalog/runtime model")
	_, _ = fmt.Fprintln(output, "  --json                  输出机器可读 JSON")
}
