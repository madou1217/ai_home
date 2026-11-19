package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/nativeresources"
)

type mcpOptions struct {
	positional   []string
	provider     string
	allSupported bool
	jsonOutput   bool
	command      string
	args         []string
	cwd          string
	envFile      string
	argsJSON     string
}

func runMCP(ctx context.Context, arguments []string, runtime commandRuntime) error {
	args := append([]string(nil), arguments...)
	if len(args) == 0 || hasHelpToken(args) {
		writeMCPUsage(runtime.stdout)
		return nil
	}
	command := strings.ToLower(strings.TrimSpace(args[0]))
	switch command {
	case "list", "add", "test", "tools", "call", "enable", "disable", "remove", "doctor":
	default:
		writeMCPUsage(runtime.stdout)
		return nil
	}
	options, err := parseMCPOptions(args[1:], command)
	if err != nil {
		return printNativeResourceError(runtime, "mcp", err)
	}
	service, err := newNativeResourcesService(runtime)
	if err != nil {
		return printNativeResourceError(runtime, "mcp", err)
	}
	switch command {
	case "list":
		revision, resources, listErr := service.MCPList(ctx, options.provider)
		if listErr != nil {
			return printNativeResourceError(runtime, "mcp", listErr)
		}
		if options.jsonOutput {
			return writeJSONDocument(runtime.stdout, map[string]any{"revision": revision, "resources": resources})
		}
		_, _ = fmt.Fprintf(runtime.stdout, "MCP · revision %d\n", revision)
		for _, record := range resources {
			state := "disabled"
			if record.Enabled {
				state = "enabled"
			}
			_, _ = fmt.Fprintf(runtime.stdout, "%s  %s  %s  %s  args=%d  env=%s  %s\n",
				record.Provider, record.ID, state, record.Command, record.ArgCount, strings.Join(record.EnvKeys, ","), strings.Join(record.Projections, ","))
		}
		if len(resources) == 0 {
			_, _ = fmt.Fprintln(runtime.stdout, "(no managed MCP servers)")
		}
		return nil
	case "doctor":
		report, doctorErr := service.MCPDoctor(ctx, options.provider)
		if doctorErr != nil {
			return printNativeResourceError(runtime, "mcp", doctorErr)
		}
		if options.jsonOutput {
			_ = writeJSONDocument(runtime.stdout, report)
		} else {
			state := "healthy"
			if !report.Healthy {
				state = "needs attention"
			}
			_, _ = fmt.Fprintf(runtime.stdout, "MCP · revision %d · %s\n", report.Revision, state)
			for _, record := range report.Resources {
				health := "unhealthy"
				if record.Healthy {
					health = "healthy"
				}
				_, _ = fmt.Fprintf(runtime.stdout, "%s  %s  %s\n", record.Provider, record.ID, health)
				for _, projection := range record.Projections {
					projectionState := "ok"
					if !projection.Healthy {
						projectionState = "bad"
					}
					_, _ = fmt.Fprintf(runtime.stdout, "  %s  %s  %s\n", projection.Target, projectionState, projection.Error)
				}
			}
		}
		if !report.Healthy {
			return &cliExitCode{code: 1}
		}
		return nil
	case "add":
		if len(options.positional) != 1 {
			return printNativeResourceError(runtime, "mcp", fmt.Errorf("mcp_argument_required"))
		}
		if options.command == "" {
			return printNativeResourceError(runtime, "mcp", fmt.Errorf("mcp_command_required"))
		}
		if options.provider == "" && !options.allSupported {
			return printNativeResourceError(runtime, "mcp", fmt.Errorf("mcp_provider_required"))
		}
		var env map[string]string
		if options.envFile != "" {
			raw, readErr := os.ReadFile(options.envFile)
			if readErr != nil || len(raw) > 65536 {
				return printNativeResourceError(runtime, "mcp", fmt.Errorf("mcp_env_invalid"))
			}
			if json.Unmarshal(raw, &env) != nil {
				return printNativeResourceError(runtime, "mcp", fmt.Errorf("mcp_env_invalid"))
			}
		}
		providers := []string{options.provider}
		if options.allSupported {
			providers, err = mcpAllSupportedProviders(ctx, service)
			if err != nil {
				return printNativeResourceError(runtime, "mcp", err)
			}
		}
		return runMCPOperation(ctx, runtime, options, "add", options.positional[0], func(provider string) (any, error) {
			return service.MCPAdd(ctx, options.positional[0], nativeresources.MCPServerSpec{
				Command: options.command, Args: options.args, Cwd: options.cwd, Env: env,
			}, provider)
		}, providers)
	case "test", "tools":
		if len(options.positional) != 1 {
			return printNativeResourceError(runtime, "mcp", fmt.Errorf("mcp_argument_required"))
		}
		return runMCPOperation(ctx, runtime, options, command, options.positional[0], func(provider string) (any, error) {
			if command == "test" {
				return service.MCPTest(ctx, options.positional[0], provider)
			}
			return service.MCPTools(ctx, options.positional[0], provider)
		}, []string{options.provider})
	case "call":
		if len(options.positional) != 2 {
			return printNativeResourceError(runtime, "mcp", fmt.Errorf("mcp_argument_required"))
		}
		var toolArgs map[string]any
		if strings.TrimSpace(options.argsJSON) != "" {
			if json.Unmarshal([]byte(options.argsJSON), &toolArgs) != nil {
				return printNativeResourceError(runtime, "mcp", fmt.Errorf("mcp_tool_arguments_invalid"))
			}
		}
		return runMCPOperation(ctx, runtime, options, command, options.positional[0], func(provider string) (any, error) {
			return service.MCPCall(ctx, options.positional[0], provider, options.positional[1], toolArgs)
		}, []string{options.provider})
	case "enable", "disable", "remove":
		if len(options.positional) != 1 {
			return printNativeResourceError(runtime, "mcp", fmt.Errorf("mcp_argument_required"))
		}
		providers, selectionErr := mcpChangeProviders(ctx, service, options, options.positional[0])
		if selectionErr != nil {
			return printNativeResourceError(runtime, "mcp", selectionErr)
		}
		return runMCPOperation(ctx, runtime, options, command, options.positional[0], func(provider string) (any, error) {
			return service.MCPChange(ctx, options.positional[0], provider, command)
		}, providers)
	}
	return nil
}

func parseMCPOptions(arguments []string, command string) (mcpOptions, error) {
	options := mcpOptions{}
	for index := 0; index < len(arguments); index++ {
		token := strings.TrimSpace(arguments[index])
		next := func() (string, bool) {
			if index+1 >= len(arguments) || strings.HasPrefix(arguments[index+1], "--") {
				return "", false
			}
			index++
			return strings.TrimSpace(arguments[index]), true
		}
		switch token {
		case "":
			continue
		case "--json":
			options.jsonOutput = true
		case "--all-supported":
			options.allSupported = true
		case "--provider":
			value, ok := next()
			if !ok || options.provider != "" {
				return options, fmt.Errorf("mcp_option_value_required")
			}
			options.provider = strings.ToLower(value)
		case "--command":
			value, ok := next()
			if !ok || options.command != "" {
				return options, fmt.Errorf("mcp_option_value_required")
			}
			options.command = value
		case "--arg":
			value, ok := next()
			if !ok {
				return options, fmt.Errorf("mcp_option_value_required")
			}
			options.args = append(options.args, value)
		case "--cwd":
			value, ok := next()
			if !ok || options.cwd != "" {
				return options, fmt.Errorf("mcp_option_value_required")
			}
			options.cwd = value
		case "--env-file":
			value, ok := next()
			if !ok || options.envFile != "" {
				return options, fmt.Errorf("mcp_option_value_required")
			}
			options.envFile = value
		case "--args-json":
			if command != "call" {
				return options, fmt.Errorf("mcp_option_unknown")
			}
			value, ok := next()
			if !ok || options.argsJSON != "" {
				return options, fmt.Errorf("mcp_option_value_required")
			}
			options.argsJSON = value
		default:
			if strings.HasPrefix(token, "-") {
				return options, fmt.Errorf("mcp_option_unknown")
			}
			options.positional = append(options.positional, token)
		}
	}
	if options.provider != "" && options.allSupported {
		return options, fmt.Errorf("mcp_selector_conflict")
	}
	return options, nil
}

func mcpAllSupportedProviders(ctx context.Context, service *nativeresources.Service) ([]string, error) {
	rows, err := service.MCPProviderReport(ctx)
	if err != nil {
		return nil, err
	}
	providers := make([]string, 0)
	for _, row := range rows {
		capability := row.Resources["mcp"]
		if capability.State != "unsupported" && capability.Projection != nil {
			providers = append(providers, row.Provider)
		}
	}
	sortStrings(providers)
	if len(providers) == 0 {
		return nil, fmt.Errorf("mcp_provider_required")
	}
	return providers, nil
}

func mcpChangeProviders(ctx context.Context, service *nativeresources.Service, options mcpOptions, name string) ([]string, error) {
	if options.provider != "" {
		return []string{options.provider}, nil
	}
	if options.allSupported {
		return nil, fmt.Errorf("mcp_selector_conflict")
	}
	_, resources, err := service.MCPList(ctx, "")
	if err != nil {
		return nil, err
	}
	providers := make([]string, 0)
	for _, record := range resources {
		if record.ID == name {
			providers = append(providers, record.Provider)
		}
	}
	if len(providers) == 0 {
		return nil, fmt.Errorf("mcp_not_installed")
	}
	sortStrings(providers)
	return providers, nil
}

func runMCPOperation(
	ctx context.Context,
	runtime commandRuntime,
	options mcpOptions,
	action string,
	name string,
	operate func(provider string) (any, error),
	providers []string,
) error {
	results := make([]map[string]any, 0, len(providers))
	allOK := true
	for _, provider := range providers {
		if provider == "" {
			continue
		}
		value, err := operate(provider)
		if err != nil {
			allOK = false
			results = append(results, map[string]any{"ok": false, "provider": provider, "error": nativeResourceErrorCode(err)})
			continue
		}
		results = append(results, map[string]any{"ok": true, "provider": provider, "result": value})
	}
	if len(providers) == 1 {
		if options.jsonOutput {
			return writeJSONDocument(runtime.stdout, results[0])
		}
		if allOK {
			return nil
		}
	}
	payload := map[string]any{"ok": allOK, "results": results}
	if options.jsonOutput {
		_ = writeJSONDocument(runtime.stdout, payload)
	} else {
		for _, result := range results {
			provider := stringValue(result["provider"])
			if ok, _ := result["ok"].(bool); ok {
				_, _ = fmt.Fprintf(runtime.stdout, "%s  %s: ok\n", provider, action)
			} else {
				_, _ = fmt.Fprintf(runtime.stdout, "%s  %s\n", provider, stringValue(result["error"]))
			}
		}
	}
	if !allOK {
		return &cliExitCode{code: 1}
	}
	return nil
}

func writeMCPUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "Usage: aih mcp <command> [options]")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "  list [--provider <id>] [--json]")
	_, _ = fmt.Fprintln(output, "  add <name> --command <file> [--arg <value> ...] (--provider <id>|--all-supported)")
	_, _ = fmt.Fprintln(output, "             [--cwd <absolute-dir>] [--env-file <private.json>] [--json]")
	_, _ = fmt.Fprintln(output, "  test <name> [--provider <id>] [--json]")
	_, _ = fmt.Fprintln(output, "  tools <name> [--provider <id>] [--json]")
	_, _ = fmt.Fprintln(output, "  call <name> <tool> [--args-json <json>] [--provider <id>] [--json]")
	_, _ = fmt.Fprintln(output, "  enable|disable|remove <name> [--provider <id>] [--json]")
	_, _ = fmt.Fprintln(output, "  doctor [--provider <id>] [--json]")
}
