package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/nativeresources"
)

type skillOptions struct {
	positional   []string
	provider     string
	allSupported bool
	jsonOutput   bool
}

func runSkill(ctx context.Context, arguments []string, runtime commandRuntime) error {
	args := append([]string(nil), arguments...)
	if len(args) == 0 || hasHelpToken(args) {
		writeSkillUsage(runtime.stdout)
		return nil
	}
	command := strings.ToLower(strings.TrimSpace(args[0]))
	rest := args[1:]
	switch command {
	case "list", "doctor", "install", "enable", "disable", "remove":
	default:
		writeSkillUsage(runtime.stdout)
		return nil
	}
	options, err := parseSkillOptions(rest)
	if err != nil {
		writeSkillUsage(runtime.stderr)
		return err
	}
	service, err := newNativeResourcesService(runtime)
	if err != nil {
		return err
	}
	switch command {
	case "list":
		revision, resources, listErr := service.SkillList(ctx, options.provider)
		if listErr != nil {
			return printNativeResourceError(runtime, "skill", listErr)
		}
		if options.jsonOutput {
			views := make([]map[string]any, 0, len(resources))
			for _, record := range resources {
				views = append(views, skillRecordView(record, "", nil))
			}
			return writeJSONDocument(runtime.stdout, map[string]any{"revision": revision, "resources": views})
		}
		_, _ = fmt.Fprintf(runtime.stdout, "Skills · revision %d\n", revision)
		for _, record := range resources {
			state := "disabled"
			if record.Enabled {
				state = "enabled"
			}
			projection := record.Projection
			if strings.TrimSpace(projection) == "" {
				projection = record.Mode
			}
			_, _ = fmt.Fprintf(runtime.stdout, "%s  %s  %s  %s  %s\n", record.Provider, record.ID, state, projection, record.Target)
		}
		if len(resources) == 0 {
			_, _ = fmt.Fprintln(runtime.stdout, "(no managed skills)")
		}
		writeSkillProviderStates(ctx, runtime, service, options.provider)
		return nil
	case "doctor":
		report, doctorErr := service.SkillDoctor(ctx, options.provider)
		if doctorErr != nil {
			return printNativeResourceError(runtime, "skill", doctorErr)
		}
		providerRows, _ := service.SkillProviderReport(ctx)
		providers := make([]map[string]any, 0, len(providerRows))
		for _, row := range providerRows {
			capability := row.Resources["skill"]
			encoded, _ := json.Marshal(capability.ResourceCapability)
			var view map[string]any
			_ = json.Unmarshal(encoded, &view)
			if view == nil {
				view = map[string]any{}
			}
			view["provider"] = row.Provider
			if stringValue(view["state"]) != "unsupported" {
				if _, ok := view["commands"]; !ok {
					view["commands"] = []any{}
				}
				if _, ok := view["paths"]; !ok {
					view["paths"] = []any{}
				}
			}
			providers = append(providers, view)
		}
		if options.jsonOutput {
			views := make([]map[string]any, 0, len(report.Resources))
			for _, record := range report.Resources {
				healthy := record.Healthy
				views = append(views, skillRecordView(record.ManagedRecord, record.Projection, &healthy))
			}
			_ = writeJSONDocument(runtime.stdout, map[string]any{"revision": report.Revision, "healthy": report.Healthy, "resources": views, "providers": providers})
			if !report.Healthy {
				return &cliExitCode{code: 1}
			}
			return nil
		}
		state := "healthy"
		if !report.Healthy {
			state = "needs attention"
		}
		_, _ = fmt.Fprintf(runtime.stdout, "Skills · revision %d · %s\n", report.Revision, state)
		for _, record := range report.Resources {
			health := "unhealthy"
			if record.Healthy {
				health = "healthy"
			}
			_, _ = fmt.Fprintf(runtime.stdout, "%s  %s  %s  %s\n", record.Provider, record.ID, health, record.Target)
		}
		if len(report.Resources) == 0 {
			_, _ = fmt.Fprintln(runtime.stdout, "(no managed skills)")
		}
		for _, provider := range providers {
			_, _ = fmt.Fprintf(runtime.stdout, "%s  %s  %s\n", stringValue(provider["provider"]), stringValue(provider["state"]), stringValue(provider["reason"]))
		}
		if !report.Healthy {
			return &cliExitCode{code: 1}
		}
		return nil
	case "install":
		if len(options.positional) != 1 {
			return fmt.Errorf("skill_argument_required")
		}
		providers, selectionErr := skillInstallProviders(ctx, service, options)
		if selectionErr != nil {
			return selectionErr
		}
		return runSkillOperation(ctx, runtime, service, options, "install", providers, options.positional[0])
	default:
		if len(options.positional) != 1 {
			return fmt.Errorf("skill_argument_required")
		}
		id := options.positional[0]
		providers, selectionErr := skillChangeProviders(ctx, service, options, id)
		if selectionErr != nil {
			return selectionErr
		}
		return runSkillOperation(ctx, runtime, service, options, command, providers, id)
	}
}

func newNativeResourcesService(runtime commandRuntime) (*nativeresources.Service, error) {
	aiHomeDir, err := resolveAIHomeDir(runtime)
	if err != nil {
		return nil, err
	}
	hostHome, err := runtime.userHomeDir()
	if err != nil {
		return nil, err
	}
	return nativeresources.NewService(nativeresources.Config{AIHomeDir: aiHomeDir, HostHomeDir: hostHome})
}

func parseSkillOptions(arguments []string) (skillOptions, error) {
	options := skillOptions{}
	for index := 0; index < len(arguments); index++ {
		token := strings.TrimSpace(arguments[index])
		switch token {
		case "":
			continue
		case "--json":
			options.jsonOutput = true
		case "--all-supported":
			options.allSupported = true
		case "--provider":
			if index+1 >= len(arguments) || strings.HasPrefix(arguments[index+1], "-") || options.provider != "" {
				return options, fmt.Errorf("skill_provider_required")
			}
			index++
			options.provider = strings.ToLower(strings.TrimSpace(arguments[index]))
		default:
			if strings.HasPrefix(token, "-") {
				return options, fmt.Errorf("skill_option_unknown")
			}
			options.positional = append(options.positional, token)
		}
	}
	if options.provider != "" && options.allSupported {
		return options, fmt.Errorf("skill_selector_conflict")
	}
	return options, nil
}

func skillInstallProviders(ctx context.Context, service *nativeresources.Service, options skillOptions) ([]string, error) {
	if options.provider != "" {
		return []string{options.provider}, nil
	}
	if !options.allSupported {
		return nil, fmt.Errorf("skill_provider_required")
	}
	states, err := service.SkillProviderStates(ctx)
	if err != nil {
		return nil, err
	}
	providers := make([]string, 0, len(states))
	for provider := range states {
		providers = append(providers, provider)
	}
	sortStrings(providers)
	if len(providers) == 0 {
		return nil, fmt.Errorf("skill_provider_unsupported")
	}
	return providers, nil
}

func skillChangeProviders(ctx context.Context, service *nativeresources.Service, options skillOptions, id string) ([]string, error) {
	if options.provider != "" {
		return []string{options.provider}, nil
	}
	if options.allSupported {
		return nil, fmt.Errorf("skill_selector_invalid")
	}
	_, resources, err := service.SkillList(ctx, "")
	if err != nil {
		return nil, err
	}
	providers := make([]string, 0)
	for _, record := range resources {
		if record.ID == id {
			providers = append(providers, record.Provider)
		}
	}
	if len(providers) == 0 {
		return nil, fmt.Errorf("skill_not_installed")
	}
	sortStrings(providers)
	return providers, nil
}

func runSkillOperation(
	ctx context.Context,
	runtime commandRuntime,
	service *nativeresources.Service,
	options skillOptions,
	action string,
	providers []string,
	id string,
) error {
	results := make([]map[string]any, 0, len(providers))
	allOK := true
	for _, provider := range providers {
		input := nativeresources.OperateInput{Kind: "skill", Action: action, Provider: provider, ID: id}
		if action == "install" {
			input.Source = id
			input.ID = ""
		}
		response, err := service.Operate(ctx, input)
		if err != nil {
			allOK = false
			results = append(results, map[string]any{"ok": false, "provider": provider, "error": nativeResourceErrorCode(err)})
			continue
		}
		results = append(results, map[string]any{"ok": true, "provider": provider, "result": response.Result})
	}
	if options.jsonOutput {
		_ = writeJSONDocument(runtime.stdout, map[string]any{"ok": allOK, "results": results})
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

func writeSkillProviderStates(ctx context.Context, runtime commandRuntime, service *nativeresources.Service, provider string) {
	states, err := service.SkillProviderStates(ctx)
	if err != nil {
		return
	}
	keys := make([]string, 0, len(states))
	for key := range states {
		if provider == "" || key == provider {
			keys = append(keys, key)
		}
	}
	sortStrings(keys)
	for _, key := range keys {
		capability := states[key]
		_, _ = fmt.Fprintf(runtime.stdout, "%s  %s  %s\n", key, capability.State, capability.Reason)
	}
}

func printNativeResourceError(runtime commandRuntime, prefix string, err error) error {
	_, _ = fmt.Fprintf(runtime.stderr, "[aih %s] %s\n", prefix, nativeResourceErrorCode(err))
	return &cliExitCode{code: 1}
}

func nativeResourceErrorCode(err error) string {
	var domain *nativeresources.DomainError
	if errors.As(err, &domain) && domain.Code != "" {
		return domain.Code
	}
	return err.Error()
}

func writeSkillUsage(output io.Writer) {
	_, _ = fmt.Fprintln(output, "Usage: aih skill <command> [options]")
	_, _ = fmt.Fprintln(output)
	_, _ = fmt.Fprintln(output, "  list [--provider <id>] [--json]")
	_, _ = fmt.Fprintln(output, "  install <skillDir> (--provider <id>|--all-supported) [--json]")
	_, _ = fmt.Fprintln(output, "  enable <skillId> [--provider <id>] [--json]")
	_, _ = fmt.Fprintln(output, "  disable <skillId> [--provider <id>] [--json]")
	_, _ = fmt.Fprintln(output, "  remove <skillId> [--provider <id>] [--json]")
	_, _ = fmt.Fprintln(output, "  doctor [--provider <id>] [--json]")
}

func skillRecordView(record nativeresources.ManagedRecord, projection string, healthy *bool) map[string]any {
	encoded, _ := json.Marshal(record)
	var view map[string]any
	_ = json.Unmarshal(encoded, &view)
	if view == nil {
		view = map[string]any{}
	}
	if projection != "" {
		view["projection"] = projection
	}
	if healthy != nil {
		view["healthy"] = *healthy
	}
	return view
}

func hasHelpToken(arguments []string) bool {
	for _, argument := range arguments {
		if argument == "--help" || argument == "-h" || argument == "help" {
			return true
		}
	}
	return false
}

func sortStrings(values []string) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && values[j] < values[j-1]; j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
