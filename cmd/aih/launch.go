package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/launcher"
	"github.com/madou1217/ai_home/internal/adapters/launcherstore"
	"github.com/madou1217/ai_home/internal/runtime/aihhome"
	"github.com/madou1217/ai_home/internal/runtime/appcatalog"
	"github.com/madou1217/ai_home/internal/runtime/applaunch"
	"github.com/madou1217/ai_home/internal/transport/http/webuilauncherapi"
)

func runLaunch(ctx context.Context, arguments []string, runtime commandRuntime) error {
	if len(arguments) == 0 || isLaunchHelp(arguments[0]) {
		writeLaunchUsage(runtime.stdout)
		return nil
	}
	subcommand := strings.ToLower(strings.TrimSpace(arguments[0]))
	rest := arguments[1:]
	if hasHelpToken(rest) {
		writeLaunchUsage(runtime.stdout)
		return nil
	}
	if subcommand == "show" {
		return runLaunchShow(ctx, rest, runtime)
	}

	homeDir, err := resolveLauncherAIHomeDir(runtime)
	if err != nil {
		return err
	}
	store, err := launcherstore.New(homeDir)
	if err != nil {
		return err
	}
	service, err := launcher.NewService(appcatalog.New(), applaunch.New(), store, time.Now)
	if err != nil {
		return err
	}

	switch subcommand {
	case "apps":
		return runLaunchApps(ctx, service, rest, runtime)
	case "open":
		return runLaunchOpen(ctx, service, rest, runtime)
	case "catalog":
		return runLaunchCatalog(ctx, service, rest, runtime)
	case "status":
		return runLaunchStatus(ctx, service, rest, runtime)
	default:
		_, _ = fmt.Fprintf(runtime.stderr, "[aih launch] unknown subcommand: %s\n", subcommand)
		writeLaunchUsage(runtime.stderr)
		return cliExitCode{code: 1}
	}
}

func resolveLauncherAIHomeDir(runtime commandRuntime) (string, error) {
	home, err := resolveAIHomeDir(runtime)
	if err != nil {
		return "", err
	}
	if explicit, found := runtime.lookupEnv("AIH_HOME_DIR"); !found || strings.TrimSpace(explicit) == "" {
		if hostAIHome := aihhome.ProjectedHostAIHome(home); hostAIHome != "" {
			return hostAIHome, nil
		}
	}
	return home, nil
}

func runLaunchApps(ctx context.Context, service *launcher.Service, args []string, runtime commandRuntime) error {
	jsonOutput := false
	opts := launcher.ListOptions{}

	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--json":
			jsonOutput = true
		case arg == "--refresh":
			opts.Refresh = true
		case (arg == "--q" || arg == "--query") && i+1 < len(args):
			i++
			opts.Query = args[i]
		case strings.HasPrefix(arg, "--q="):
			opts.Query = strings.TrimPrefix(arg, "--q=")
		case strings.HasPrefix(arg, "--query="):
			opts.Query = strings.TrimPrefix(arg, "--query=")
		case arg == "--limit" && i+1 < len(args):
			i++
			parsed, err := strconv.Atoi(strings.TrimSpace(args[i]))
			if err != nil || parsed <= 0 {
				return fmt.Errorf("invalid --limit: %s", args[i])
			}
			opts.Limit = parsed
		case strings.HasPrefix(arg, "--limit="):
			parsed, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(arg, "--limit=")))
			if err != nil || parsed <= 0 {
				return fmt.Errorf("invalid --limit: %s", arg)
			}
			opts.Limit = parsed
		default:
			return fmt.Errorf("unknown flag for `aih launch apps`: %s", arg)
		}
	}

	result, err := service.List(ctx, opts)
	if err != nil {
		return err
	}
	if jsonOutput {
		return writeLaunchJSON(runtime.stdout, result)
	}
	if len(result.Apps) == 0 {
		_, _ = fmt.Fprintln(runtime.stdout, "(no applications found)")
		return nil
	}
	for i, app := range result.Apps {
		shortID := app.ID
		if len(shortID) > 8 {
			shortID = shortID[:8]
		}
		label := "#" + strconv.Itoa(i+1)
		_, _ = fmt.Fprintf(
			runtime.stdout,
			"%-5s %-8s %-8s %-28s %s\n",
			label,
			shortID,
			app.Kind,
			truncateRunes(app.Name, 28),
			truncateRunes(app.Subtitle, 60),
		)
	}
	if result.Truncated {
		_, _ = fmt.Fprintf(runtime.stdout, "(truncated at %d applications)\n", len(result.Apps))
	}
	return nil
}

func runLaunchOpen(ctx context.Context, service *launcher.Service, args []string, runtime commandRuntime) error {
	jsonOutput := false
	selector := ""
	for _, arg := range args {
		switch arg {
		case "--json":
			jsonOutput = true
		default:
			if strings.HasPrefix(arg, "-") {
				return fmt.Errorf("unknown flag for `aih launch open`: %s", arg)
			}
			if selector != "" {
				return errors.New("`aih launch open` accepts only one <id|#index>")
			}
			selector = arg
		}
	}
	if selector == "" {
		return errors.New("usage: aih launch open <id|#index> [--json]")
	}
	app, err := service.ResolveSelector(ctx, selector)
	if err != nil {
		return err
	}
	opened, err := service.Open(ctx, app.ID)
	if err != nil {
		return err
	}
	if jsonOutput {
		return writeLaunchJSON(runtime.stdout, map[string]any{
			"ok":  true,
			"app": opened,
		})
	}
	_, _ = fmt.Fprintf(runtime.stdout, "opened %s (%s)\n", opened.Name, opened.ID)
	return nil
}

func runLaunchCatalog(ctx context.Context, service *launcher.Service, args []string, runtime commandRuntime) error {
	wireOutput := false
	opts := launcher.ListOptions{}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--wire":
			wireOutput = true
		case arg == "--refresh":
			opts.Refresh = true
		case (arg == "--q" || arg == "--query") && i+1 < len(args):
			i++
			opts.Query = args[i]
		case strings.HasPrefix(arg, "--q="):
			opts.Query = strings.TrimPrefix(arg, "--q=")
		case strings.HasPrefix(arg, "--query="):
			opts.Query = strings.TrimPrefix(arg, "--query=")
		case arg == "--limit" && i+1 < len(args):
			i++
			parsed, err := strconv.Atoi(strings.TrimSpace(args[i]))
			if err != nil || parsed <= 0 {
				return fmt.Errorf("invalid --limit: %s", args[i])
			}
			opts.Limit = parsed
		case strings.HasPrefix(arg, "--limit="):
			parsed, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(arg, "--limit=")))
			if err != nil || parsed <= 0 {
				return fmt.Errorf("invalid --limit: %s", arg)
			}
			opts.Limit = parsed
		default:
			return fmt.Errorf("unknown flag for `aih launch catalog`: %s", arg)
		}
	}

	result, err := service.List(ctx, opts)
	if err != nil {
		return err
	}
	if !wireOutput {
		return writeLaunchJSON(runtime.stdout, result)
	}
	// Wire format (§9): LAUNCH1\t<b64 id>\t<b64 name>\t<b64 subtitle>\t<b64 icon>\t<b64 kind>\t<0|1 terminal>\t<b64 path>
	for _, app := range result.Apps {
		termFlag := "0"
		if app.Terminal {
			termFlag = "1"
		}
		_, err := fmt.Fprintf(
			runtime.stdout,
			"LAUNCH1\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n",
			encodeWireField(app.ID),
			encodeWireField(app.Name),
			encodeWireField(app.Subtitle),
			encodeWireField(app.Icon),
			encodeWireField(string(app.Kind)),
			termFlag,
			encodeWireField(app.Path),
		)
		if err != nil {
			return err
		}
	}
	return nil
}

func runLaunchShow(ctx context.Context, args []string, runtime commandRuntime) error {
	jsonOutput := false
	for _, arg := range args {
		switch arg {
		case "--json":
			jsonOutput = true
		default:
			return fmt.Errorf("unknown flag for `aih launch show`: %s", arg)
		}
	}
	configured := withLocalGatewayDefaults(ctx, runtime)
	baseURL := strings.TrimRight(strings.TrimSpace(lookupOrDefault(configured.lookupEnv, "AIH_SERVER_BASE_URL", defaultGatewayBaseURL)), "/")
	managementKey := strings.TrimSpace(lookupOrDefault(configured.lookupEnv, "AIH_SERVER_MANAGEMENT_KEY", ""))
	if managementKey == "" {
		return errors.New("management key not configured (set AIH_SERVER_MANAGEMENT_KEY or configure local server)")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+webuilauncherapi.Path+"/show", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+managementKey)
	req.Header.Set("Accept", "application/json")
	resp, err := configured.managementAPI.Do(req)
	if err != nil {
		return fmt.Errorf("request %s failed: %w", req.URL.String(), err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	if resp.StatusCode != http.StatusOK {
		var errPayload struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		if json.Unmarshal(raw, &errPayload) == nil && (errPayload.Message != "" || errPayload.Error != "") {
			msg := errPayload.Message
			if msg == "" {
				msg = errPayload.Error
			}
			return fmt.Errorf("HTTP %d (%s): %s", resp.StatusCode, errPayload.Error, msg)
		}
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	if jsonOutput {
		return writeLaunchJSON(runtime.stdout, map[string]any{"ok": true})
	}
	_, _ = fmt.Fprintln(runtime.stdout, "launcher shown")
	return nil
}

func runLaunchStatus(ctx context.Context, service *launcher.Service, args []string, runtime commandRuntime) error {
	jsonOutput := false
	for _, arg := range args {
		switch arg {
		case "--json":
			jsonOutput = true
		default:
			return fmt.Errorf("unknown flag for `aih launch status`: %s", arg)
		}
	}
	status := service.Status(ctx)
	if jsonOutput {
		return writeLaunchJSON(runtime.stdout, status)
	}
	_, _ = fmt.Fprintf(runtime.stdout, "Platform:    %s\n", status.Platform)
	_, _ = fmt.Fprintf(runtime.stdout, "Supported:   %t\n", status.Supported)
	_, _ = fmt.Fprintf(runtime.stdout, "Apps:        %d\n", status.Count)
	if status.GeneratedAt > 0 {
		_, _ = fmt.Fprintf(runtime.stdout, "GeneratedAt: %s\n", time.UnixMilli(status.GeneratedAt).UTC().Format(time.RFC3339))
	} else {
		_, _ = fmt.Fprintln(runtime.stdout, "GeneratedAt: -")
	}
	if status.LastError != "" {
		_, _ = fmt.Fprintf(runtime.stdout, "LastError:   %s\n", status.LastError)
	}
	return nil
}

func encodeWireField(value string) string {
	return base64.StdEncoding.EncodeToString([]byte(value))
}

func isLaunchHelp(arg string) bool {
	return arg == "-h" || arg == "--help" || arg == "help"
}

func writeLaunchUsage(w io.Writer) {
	_, _ = fmt.Fprintln(w, "用法:")
	_, _ = fmt.Fprintln(w, "  aih launch apps [--json] [--q <关键词>] [--refresh] [--limit <N>]")
	_, _ = fmt.Fprintln(w, "  aih launch open <id|#序号> [--json]")
	_, _ = fmt.Fprintln(w, "  aih launch catalog [--wire] [--q <关键词>] [--refresh] [--limit <N>]")
	_, _ = fmt.Fprintln(w, "  aih launch show [--json]")
	_, _ = fmt.Fprintln(w, "  aih launch status [--json]")
}

func writeLaunchJSON(w io.Writer, payload any) error {
	encoder := json.NewEncoder(w)
	encoder.SetIndent("", "  ")
	encoder.SetEscapeHTML(false)
	return encoder.Encode(payload)
}
