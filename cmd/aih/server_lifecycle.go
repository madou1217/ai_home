package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/autostart"
)

// runServerLifecycle owns the common server lifecycle commands. Advanced
// serve/config variants still delegate to the legacy CLI until each command has
// a Go implementation.
func runServerLifecycle(ctx context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	action := ""
	switch {
	case len(arguments) == 1 && arguments[0] == "serve":
		action = "start"
	case len(arguments) >= 1 && (arguments[0] == "server" || arguments[0] == "daemon"):
		if len(arguments) > 1 {
			action = strings.TrimSpace(arguments[1])
		} else {
			action = "start"
		}
	default:
		return false, nil
	}
	if action == "help" || action == "--help" || action == "-h" {
		showServerUsage(runtime)
		return true, nil
	}
	if action != "start" && action != "stop" && action != "restart" && action != "status" {
		return false, nil
	}
	if len(arguments) > 2 {
		var message string
		switch action {
		case "start":
			message = "server start does not accept serve options; update server config first"
		case "stop":
			message = "server stop does not accept serve options"
		case "restart":
			message = "server restart does not accept serve options; update server config first"
		default:
			message = "server status does not accept serve options"
		}
		_, _ = fmt.Fprintf(runtime.stderr, "\x1b[31m[aih] %s\x1b[0m\n", message)
		return true, cliExitCode{code: 1}
	}
	options, err := resolveAutostartOptions(runtime)
	if err != nil {
		return true, err
	}
	port := resolveServerPort(ctx, options.Home, runtime)
	switch action {
	case "start":
		if serverReady(ctx, port) {
			_, _ = fmt.Fprintln(runtime.stdout, "[aih] server is already running")
			return true, nil
		}
		if _, err := autostart.Install(ctx, options); err != nil {
			return true, err
		}
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] server started")
	case "stop":
		if err := autostart.Stop(ctx, options); err != nil {
			return true, err
		}
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] server stopped")
	case "restart":
		if _, err := autostart.Install(ctx, options); err != nil {
			return true, err
		}
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] server restarted")
	case "status":
		status, _ := autostart.StatusFor(ctx, options)
		ready := serverReady(ctx, port)
		if ready {
			_, _ = fmt.Fprintf(runtime.stdout, "[aih] server is running (port=%d)\n", port)
			_, _ = fmt.Fprintln(runtime.stdout, "  ready: true")
		} else {
			_, _ = fmt.Fprintln(runtime.stdout, "[aih] server is not running")
		}
		_, _ = fmt.Fprintf(runtime.stdout, "  base_url: http://127.0.0.1:%d\n", port)
		_, _ = fmt.Fprintf(runtime.stdout, "  autostart: type=%s installed=%t loaded=%t\n",
			autostartType(), status.Installed, status.Loaded)
		if ready {
			if pid := serverPID(options.Home); pid > 0 {
				_, _ = fmt.Fprintf(runtime.stdout, "  pid_file: %s\n", filepath.Join(options.Home, "run", "go-server-runtime.json"))
				_, _ = fmt.Fprintf(runtime.stdout, "  pid: %d\n", pid)
			}
		}
	}
	return true, nil
}

func resolveServerPort(ctx context.Context, home string, runtime commandRuntime) int {
	if value := strings.TrimSpace(readEnv(runtime.lookupEnv, "AIH_SERVER_PORT")); value != "" {
		if port, err := strconv.Atoi(value); err == nil && port > 0 && port <= 65535 {
			return port
		}
	}
	path, err := appstate.DatabasePath(home)
	if err != nil {
		return 9527
	}
	raw, found, err := appstate.ReadKV(ctx, path, "config:server")
	if err != nil || !found {
		return 9527
	}
	var config map[string]any
	if json.Unmarshal([]byte(raw), &config) != nil {
		return 9527
	}
	if number, ok := config["port"].(float64); ok && number > 0 && number <= 65535 {
		return int(number)
	}
	return 9527
}

func serverReady(ctx context.Context, port int) bool {
	client := &http.Client{Timeout: 2 * time.Second}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/readyz", port), nil)
	if err != nil {
		return false
	}
	response, err := client.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false
	}
	var payload map[string]any
	if json.NewDecoder(response.Body).Decode(&payload) != nil {
		return false
	}
	ready, _ := payload["ready"].(bool)
	return ready
}

func serverPID(home string) int {
	raw, err := os.ReadFile(filepath.Join(home, "run", "go-server-runtime.json"))
	if err != nil || len(raw) > 64*1024 {
		return 0
	}
	var identity map[string]any
	if json.Unmarshal(raw, &identity) != nil {
		return 0
	}
	if pid, ok := identity["pid"].(float64); ok {
		return int(pid)
	}
	return 0
}
