package main

import (
	"context"
	"encoding/json"
	"errors"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/application/providerruntime"
	"github.com/madou1217/ai_home/application/serverconfig"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// runTerminalSessionsEntry supplies only the old public Node list bootstrap.
// It never changes process-wide environment or duplicates the session business.
func runTerminalSessionsEntry(ctx context.Context, args []string, command commandRuntime) error {
	if len(args) != 2 || (args[0] != "ss" && args[0] != "sessions") || args[1] != "--list" {
		return errors.New("terminal_sessions_arguments_invalid")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	host := terminalSessionHostHome(command)
	aiHome := terminalSessionEnv(command, "AIH_HOME_DIR")
	if aiHome == "" {
		aiHome = terminalSessionEnv(command, "AI_HOME")
	}
	if aiHome == "" {
		if host == "" {
			return errors.New("terminal_sessions_home_unavailable")
		}
		aiHome = filepath.Join(host, ".ai_home")
	}
	absolute, err := filepath.Abs(aiHome)
	if err != nil {
		return errors.New("terminal_sessions_home_invalid")
	}
	values := map[string]string{"AIH_HOME_DIR": absolute}
	if host != "" {
		values["AIH_HOST_HOME"] = host
	}
	// Node's existing bootstrap gives a non-empty persisted management key and
	// its public port priority over injected management settings. Read only this
	// key, leave missing/unreadable optional configuration to the original env.
	database, pathErr := appstate.DatabasePath(absolute)
	if pathErr == nil {
		raw, found, readErr := appstate.ReadKV(ctx, database, "config:server")
		if readErr == nil && found {
			var config struct {
				ManagementKey string          `json:"managementKey"`
				Port          json.RawMessage `json:"port"`
			}
			if json.Unmarshal([]byte(raw), &config) == nil {
				if key := strings.TrimSpace(config.ManagementKey); key != "" {
					values["AIH_SERVER_MANAGEMENT_KEY"] = key
					values["AIH_SERVER_BASE_URL"] = "http://127.0.0.1:" + strconv.Itoa(terminalSessionPort(config.Port))
				}
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	original := command.lookupEnv
	command.lookupEnv = func(key string) (string, bool) {
		if value, found := values[key]; found {
			return value, true
		}
		return original(key)
	}
	return runGlobalSessions(ctx, args[1:], command)
}

func terminalSessionEnv(command commandRuntime, key string) string {
	value, _ := command.lookupEnv(key)
	return strings.TrimSpace(value)
}

// Explicit host > non-projected HOME > real OS user > homedir fallback, as in
// resolveUnprojectedHostHomeDir. Normalization reuses the canonical Go helper.
func terminalSessionHostHome(command commandRuntime) string {
	normalize := func(value string) string {
		return providerruntime.ResolveHostHomeDir(value, map[string]string{}, runtime.GOOS)
	}
	if explicit := terminalSessionEnv(command, "AIH_HOST_HOME"); explicit != "" {
		return normalize(explicit)
	}
	home := terminalSessionEnv(command, "HOME")
	if home == "" {
		home = terminalSessionEnv(command, "USERPROFILE")
	}
	normalized := strings.ReplaceAll(home, "\\", "/")
	if home != "" && !strings.Contains(normalized, "/run/login/") && !strings.Contains(normalized, "/run/auth-projections/") {
		return normalize(home)
	}
	if current, err := user.Current(); err == nil && strings.TrimSpace(current.HomeDir) != "" {
		return normalize(current.HomeDir)
	}
	if fallback, err := command.userHomeDir(); err == nil && strings.TrimSpace(fallback) != "" {
		return normalize(fallback)
	}
	if home != "" {
		return normalize(home)
	}
	return ""
}

func terminalSessionPort(raw json.RawMessage) int {
	text := strings.TrimSpace(string(raw))
	var quoted string
	if json.Unmarshal(raw, &quoted) == nil {
		text = strings.TrimSpace(quoted)
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil || !serverconfig.IsValidPort(value) {
		return serverconfig.DefaultPort
	}
	return int(value)
}
