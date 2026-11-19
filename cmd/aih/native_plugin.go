package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/nativeresources"
)

type nativePluginOptions struct {
	positional []string
	provider   string
	host       string
	out        string
	jsonOutput bool
}

func runNativePlugin(ctx context.Context, arguments []string, runtime commandRuntime) error {
	args := append([]string(nil), arguments...)
	if len(args) == 0 || hasHelpToken(args) {
		writeNativePluginUsage(runtime.stdout)
		return nil
	}
	command := strings.ToLower(strings.TrimSpace(args[0]))
	switch command {
	case "list", "install", "enable", "disable", "remove", "inspect", "project", "doctor":
	default:
		writeNativePluginUsage(runtime.stdout)
		return nil
	}
	options, err := parseNativePluginOptions(args[1:])
	if err != nil {
		return printNativeResourceError(runtime, "native plugin", err)
	}
	service, err := newNativeResourcesService(runtime)
	if err != nil {
		return printNativeResourceError(runtime, "native plugin", err)
	}
	switch command {
	case "list":
		revision, resources, listErr := service.NativePluginList(ctx, options.provider, options.host)
		if listErr != nil {
			return printNativeResourceError(runtime, "native plugin", listErr)
		}
		views := nativePluginViews(resources, nil)
		if options.jsonOutput {
			return writeJSONDocument(runtime.stdout, map[string]any{"revision": revision, "resources": views})
		}
		_, _ = fmt.Fprintf(runtime.stdout, "Native Plugins · revision %d\n", revision)
		for _, record := range resources {
			state := "disabled"
			if record.Enabled {
				state = "enabled"
			}
			_, _ = fmt.Fprintf(runtime.stdout, "%s  %s  %s  %s\n", record.Provider, record.ID, state, record.Target)
		}
		if len(resources) == 0 {
			_, _ = fmt.Fprintln(runtime.stdout, "(no managed native plugins)")
		}
		return nil
	case "doctor":
		report, doctorErr := service.NativePluginDoctor(ctx, options.provider, options.host)
		if doctorErr != nil {
			return printNativeResourceError(runtime, "native plugin", doctorErr)
		}
		views := make([]map[string]any, 0, len(report.Resources))
		for _, record := range report.Resources {
			healthy := record.Healthy
			views = append(views, nativePluginView(record.ManagedRecord, record.Projection, &healthy))
		}
		if options.jsonOutput {
			_ = writeJSONDocument(runtime.stdout, map[string]any{"revision": report.Revision, "healthy": report.Healthy, "resources": views})
		} else {
			state := "healthy"
			if !report.Healthy {
				state = "needs attention"
			}
			_, _ = fmt.Fprintf(runtime.stdout, "Native Plugins · revision %d · %s\n", report.Revision, state)
			for _, record := range report.Resources {
				health := "unhealthy"
				if record.Healthy {
					health = "healthy"
				}
				_, _ = fmt.Fprintf(runtime.stdout, "%s  %s  %s  %s\n", record.Provider, record.ID, health, record.Projection)
			}
		}
		if !report.Healthy {
			return &cliExitCode{code: 1}
		}
		return nil
	case "inspect":
		if len(options.positional) != 1 {
			return printNativeResourceError(runtime, "native plugin", fmt.Errorf("native_plugin_argument_required"))
		}
		result, inspectErr := service.InspectPortablePlugin(options.positional[0])
		if inspectErr != nil {
			return printNativeResourceError(runtime, "native plugin", inspectErr)
		}
		return writeJSONDocument(runtime.stdout, result)
	case "project":
		if len(options.positional) != 1 || options.host == "" || options.out == "" {
			return printNativeResourceError(runtime, "native plugin", fmt.Errorf("native_plugin_projection_required"))
		}
		result, projectErr := service.ProjectPortablePlugin(options.positional[0], options.host, options.out)
		if projectErr != nil {
			return printNativeResourceError(runtime, "native plugin", projectErr)
		}
		return writeJSONDocument(runtime.stdout, result)
	case "install":
		if len(options.positional) != 1 {
			return printNativeResourceError(runtime, "native plugin", fmt.Errorf("native_plugin_argument_required"))
		}
		if options.provider == "" && options.host == "" {
			return printNativeResourceError(runtime, "native plugin", fmt.Errorf("native_plugin_provider_required"))
		}
		result, installErr := service.NativePluginInstall(ctx, options.positional[0], options.provider, options.host)
		if installErr != nil {
			return printNativeResourceError(runtime, "native plugin", installErr)
		}
		return writeJSONDocument(runtime.stdout, map[string]any{"ok": true, "results": []any{map[string]any{"ok": true, "provider": options.provider, "host": options.host, "result": result}}})
	case "enable", "disable", "remove":
		if len(options.positional) != 1 {
			return printNativeResourceError(runtime, "native plugin", fmt.Errorf("native_plugin_argument_required"))
		}
		if options.provider == "" && options.host == "" {
			return printNativeResourceError(runtime, "native plugin", fmt.Errorf("native_plugin_provider_required"))
		}
		result, changeErr := service.NativePluginChange(ctx, options.positional[0], options.provider, options.host, command)
		if changeErr != nil {
			return printNativeResourceError(runtime, "native plugin", changeErr)
		}
		return writeJSONDocument(runtime.stdout, map[string]any{"ok": true, "results": []any{map[string]any{"ok": true, "provider": options.provider, "host": options.host, "result": result}}})
	}
	return nil
}

func parseNativePluginOptions(arguments []string) (nativePluginOptions, error) {
	options := nativePluginOptions{}
	for index := 0; index < len(arguments); index++ {
		token := strings.TrimSpace(arguments[index])
		next := func() (string, bool) {
			if index+1 >= len(arguments) || strings.HasPrefix(arguments[index+1], "-") {
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
		case "--provider":
			value, ok := next()
			if !ok || options.provider != "" {
				return options, fmt.Errorf("native_plugin_provider_required")
			}
			options.provider = strings.ToLower(value)
		case "--host":
			value, ok := next()
			if !ok || options.host != "" {
				return options, fmt.Errorf("native_plugin_host_required")
			}
			options.host = strings.ToLower(value)
		case "--out":
			value, ok := next()
			if !ok || options.out != "" {
				return options, fmt.Errorf("native_plugin_output_required")
			}
			options.out = value
		default:
			if strings.HasPrefix(token, "-") {
				return options, fmt.Errorf("native_plugin_option_unknown")
			}
			options.positional = append(options.positional, token)
		}
	}
	if options.provider != "" && options.host != "" {
		return options, fmt.Errorf("native_plugin_selector_conflict")
	}
	return options, nil
}

func nativePluginViews(records []nativeresources.ManagedRecord, health map[string]bool) []map[string]any {
	views := make([]map[string]any, 0, len(records))
	for _, record := range records {
		var healthy *bool
		if health != nil {
			if value, ok := health[record.ID+"|"+record.Provider+"|"+record.Host]; ok {
				healthy = &value
			}
		}
		views = append(views, nativePluginView(record, record.Projection, healthy))
	}
	return views
}

func nativePluginView(record nativeresources.ManagedRecord, projection string, healthy *bool) map[string]any {
	encoded, _ := json.Marshal(record)
	var view map[string]any
	_ = json.Unmarshal(encoded, &view)
	if view == nil {
		view = map[string]any{}
	}
	view["removed"] = record.Removed
	if projection != "" {
		view["projection"] = projection
	}
	if healthy != nil {
		view["healthy"] = *healthy
	}
	return view
}

func writeNativePluginUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "Usage: aih native plugin <command> [options]")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "  list [--provider <id>|--host <id>] [--json]")
	_, _ = fmt.Fprintln(output, "  install <package-dir> (--provider <id>|--host pi|deepseek) [--json]")
	_, _ = fmt.Fprintln(output, "  enable|disable|remove <pluginId> (--provider <id>|--host pi|deepseek) [--json]")
	_, _ = fmt.Fprintln(output, "  inspect <package-dir> [--host deepseek|opencode|pi|aih] [--json]")
	_, _ = fmt.Fprintln(output, "  project <package-dir> --host <host> --out <dir> [--json]")
	_, _ = fmt.Fprintln(output, "  doctor [--provider <id>|--host <id>] [--json]")
}
