package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/agy/acpclient"
)

const agyACPUsage = "aih agy acp [--cwd <目录>] [--command <agy>] [--model <模型>] [--effort low|medium|high|xhigh]\n" +
	"            [--timeout <时长>] [--auto-approve] \"<提示词>\"\n" +
	"远程 Connector: --connector-url <url> --workspace-root <shadow> [--connector-token-env AIH_REMOTE_TOOLS_TOKEN]\n"

func runAGYACPCommand(ctx context.Context, args []string, runtime commandRuntime) error {
	for _, arg := range args {
		if arg == "-h" || arg == "--help" {
			_, _ = io.WriteString(runtime.stdout, agyACPUsage)
			return nil
		}
	}
	options, err := parseAGYACPArgs(args)
	if err != nil {
		return err
	}
	if strings.TrimSpace(options.prompt) == "" {
		return fmt.Errorf("用法：%s", agyACPUsage)
	}
	sink := &agyACPEventSink{stdout: runtime.stdout, stderr: runtime.stderr}
	broker := &agyACPPermissionBroker{input: runtime.stdin, output: runtime.stderr, auto: options.autoApprove}
	files, terminals, root, err := resolveAGYACPHost(options)
	if err != nil {
		return err
	}
	config := acpclient.Config{
		Command:       options.command,
		Args:          []string{"acp"},
		Dir:           root,
		Files:         files,
		Terminals:     terminals,
		Permissions:   broker,
		Events:        sink,
		Model:         options.model,
		Effort:        options.effort,
		ClientName:    "aih",
		ClientVersion: "1",
	}
	session, err := acpclient.Start(ctx, config)
	if err != nil {
		return err
	}
	defer func() { _ = session.Close() }()

	promptCtx := ctx
	if options.timeout > 0 {
		var cancel context.CancelFunc
		promptCtx, cancel = context.WithTimeout(ctx, options.timeout)
		defer cancel()
	}
	stopReason, err := session.Prompt(promptCtx, options.prompt)
	sink.Finish()
	if err != nil {
		return err
	}
	_, _ = fmt.Fprintf(runtime.stderr, "\n[acp] session=%s stop=%s\n", session.SessionID(), stopReason)
	return nil
}

type agyACPOptions struct {
	cwd               string
	prompt            string
	command           string
	model             string
	effort            string
	timeout           time.Duration
	autoApprove       bool
	connectorURL      string
	connectorTokenEnv string
	workspaceRoot     string
}

func parseAGYACPArgs(args []string) (agyACPOptions, error) {
	options := agyACPOptions{cwd: ".", command: "agy", connectorTokenEnv: "AIH_REMOTE_TOOLS_TOKEN"}
	positionals := make([]string, 0, len(args))
	for index := 0; index < len(args); index++ {
		arg := args[index]
		next := func() (string, error) {
			if index+1 >= len(args) {
				return "", fmt.Errorf("%s 缺少值", arg)
			}
			index++
			return args[index], nil
		}
		switch arg {
		case "--cwd":
			value, err := next()
			if err != nil {
				return agyACPOptions{}, err
			}
			options.cwd = value
		case "--prompt":
			value, err := next()
			if err != nil {
				return agyACPOptions{}, err
			}
			options.prompt = value
		case "--command":
			value, err := next()
			if err != nil {
				return agyACPOptions{}, err
			}
			options.command = value
		case "--model":
			value, err := next()
			if err != nil {
				return agyACPOptions{}, err
			}
			options.model = value
		case "--effort":
			value, err := next()
			if err != nil {
				return agyACPOptions{}, err
			}
			options.effort = value
		case "--timeout":
			value, err := next()
			if err != nil {
				return agyACPOptions{}, err
			}
			duration, parseErr := time.ParseDuration(value)
			if parseErr != nil || duration <= 0 {
				return agyACPOptions{}, fmt.Errorf("--timeout 需要正时长，例如 10m")
			}
			options.timeout = duration
		case "--auto-approve":
			options.autoApprove = true
		case "--connector-url":
			value, err := next()
			if err != nil {
				return agyACPOptions{}, err
			}
			options.connectorURL = value
		case "--connector-token-env":
			value, err := next()
			if err != nil {
				return agyACPOptions{}, err
			}
			options.connectorTokenEnv = value
		case "--workspace-root":
			value, err := next()
			if err != nil {
				return agyACPOptions{}, err
			}
			options.workspaceRoot = value
		case "-h", "--help":
			return agyACPOptions{}, nil
		default:
			if strings.HasPrefix(arg, "-") {
				return agyACPOptions{}, fmt.Errorf("未知选项：%s", arg)
			}
			positionals = append(positionals, arg)
		}
	}
	if options.prompt == "" {
		options.prompt = strings.Join(positionals, " ")
	}
	return options, nil
}

type agyACPPermissionBroker struct {
	input  io.Reader
	output io.Writer
	auto   bool

	reader *bufio.Reader
}

func (broker *agyACPPermissionBroker) Authorize(_ context.Context, request acpclient.PermissionRequest) (acpclient.PermissionDecision, error) {
	if broker.auto {
		if option := preferredAllowOption(request.Options); option != "" {
			return acpclient.PermissionDecision{OptionID: option}, nil
		}
		return acpclient.PermissionDecision{Cancelled: true}, nil
	}
	if broker.output != nil {
		_, _ = fmt.Fprintf(broker.output, "\n[需审批] %s\n", request.ToolCall.Title)
		for index, option := range request.Options {
			_, _ = fmt.Fprintf(broker.output, "  %d. %s (%s)\n", index+1, option.Name, option.Kind)
		}
		_, _ = fmt.Fprint(broker.output, "选择（回车取消）：")
	}
	if broker.input == nil {
		return acpclient.PermissionDecision{Cancelled: true}, nil
	}
	if broker.reader == nil {
		broker.reader = bufio.NewReader(broker.input)
	}
	line, err := broker.reader.ReadString('\n')
	if err != nil && len(strings.TrimSpace(line)) == 0 {
		return acpclient.PermissionDecision{Cancelled: true}, nil
	}
	var choice int
	if _, scanErr := fmt.Sscan(strings.TrimSpace(line), &choice); scanErr != nil || choice < 1 || choice > len(request.Options) {
		return acpclient.PermissionDecision{Cancelled: true}, nil
	}
	return acpclient.PermissionDecision{OptionID: request.Options[choice-1].ID}, nil
}

func preferredAllowOption(options []acpclient.PermissionOption) string {
	for _, kind := range []string{"allow_once", "allow_always"} {
		for _, option := range options {
			if option.Kind == kind {
				return option.ID
			}
		}
	}
	return ""
}

type agyACPEventSink struct {
	stdout io.Writer
	stderr io.Writer
}

func (sink *agyACPEventSink) Publish(_ context.Context, event acpclient.Event) error {
	switch event.Kind {
	case acpclient.EventMessageDelta:
		if sink.stdout != nil {
			_, _ = io.WriteString(sink.stdout, event.Text)
		}
	case acpclient.EventThoughtDelta:
		// Thinking is intentionally not streamed to the terminal; AGY emits
		// long reasoning chunks that would drown the assistant answer.
	case acpclient.EventToolCall:
		if event.ToolCall != nil && sink.stderr != nil {
			_, _ = fmt.Fprintf(sink.stderr, "\n[tool] %s (%s)\n", event.ToolCall.Title, event.ToolCall.Status)
		}
	case acpclient.EventToolUpdate:
		if event.ToolCall != nil && sink.stderr != nil {
			_, _ = fmt.Fprintf(sink.stderr, "[tool] %s -> %s\n", event.ToolCall.ID, event.ToolCall.Status)
		}
	case acpclient.EventPlan:
		if sink.stderr != nil {
			_, _ = fmt.Fprintf(sink.stderr, "\n[plan] %d entries\n", len(event.Plan))
		}
	case acpclient.EventNotice:
		if event.Notice != nil && sink.stderr != nil {
			_, _ = fmt.Fprintf(sink.stderr, "\n[notice] %s: %s\n", event.Notice.Severity, event.Notice.Title)
		}
	}
	return nil
}

func (sink *agyACPEventSink) Finish() {
	if sink != nil && sink.stdout != nil {
		_, _ = io.WriteString(sink.stdout, "\n")
	}
}

func resolveAGYACPHost(options agyACPOptions) (acpclient.FileSystem, acpclient.TerminalHost, string, error) {
	if strings.TrimSpace(options.connectorURL) == "" {
		host, err := acpclient.NewLocalWorkspaceHost(options.cwd)
		if err != nil {
			return nil, nil, "", err
		}
		return host, host, host.Root(), nil
	}
	if strings.TrimSpace(options.workspaceRoot) == "" {
		return nil, nil, "", fmt.Errorf("--connector-url 需要同时指定 --workspace-root（Server 侧的 shadow 目录）")
	}
	token := ""
	if options.connectorTokenEnv != "" {
		token = os.Getenv(options.connectorTokenEnv)
	}
	if token == "" {
		return nil, nil, "", fmt.Errorf("远程 Connector 需要工具令牌：请在 %s 中提供", options.connectorTokenEnv)
	}
	client := acpclient.NewHTTPToolClient(options.connectorURL, token, nil)
	host, err := acpclient.NewConnectorHost(options.workspaceRoot, client)
	if err != nil {
		return nil, nil, "", err
	}
	return host, host, host.Root(), nil
}
