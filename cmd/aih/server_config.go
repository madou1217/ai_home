package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/webuiserverconfigapi"
)

func runServerConfig(ctx context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	if len(arguments) < 2 || arguments[0] != "server" || arguments[1] != "config" {
		return false, nil
	}
	home, err := resolveAIHome(runtime)
	if err != nil {
		return true, err
	}
	action := "show"
	rest := arguments[2:]
	if len(rest) > 0 && !strings.HasPrefix(rest[0], "-") {
		action = strings.ToLower(rest[0])
		rest = rest[1:]
	}
	switch action {
	case "show", "get", "set", "list", "ls", "-l":
		if action == "ls" || action == "-l" {
			action = "list"
		}
	default:
		if strings.HasPrefix(action, "-") {
			action = "show"
			rest = arguments[2:]
		} else {
			return true, fmt.Errorf("unknown server config action: %s", action)
		}
	}
	switch action {
	case "show":
		return true, showServerConfig(ctx, home, rest, runtime)
	case "get":
		if len(rest) == 0 {
			return true, errors.New("server config get requires a key")
		}
		return true, getServerConfig(ctx, home, rest[0], rest[1:], runtime)
	case "set":
		return true, setServerConfig(ctx, home, rest, runtime)
	case "list":
		return true, listServerConfig(ctx, home, rest, runtime)
	}
	return true, nil
}

func resolveAIHome(runtime commandRuntime) (string, error) {
	if value := strings.TrimSpace(readEnv(runtime.lookupEnv, "AIH_HOME_DIR")); value != "" {
		return value, nil
	}
	userHome, err := runtime.userHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(userHome, ".ai_home"), nil
}

func showServerConfig(ctx context.Context, home string, args []string, runtime commandRuntime) error {
	includeSecrets, jsonOutput, oneLine, filter := parseDisplayFlags(args)
	config, err := webuiserverconfigapi.ReadFullConfig(ctx, home)
	if err != nil {
		return err
	}
	if !includeSecrets {
		config = webuiserverconfigapi.PublicConfig(config)
	} else {
		config.APIKeyConfigured = strings.TrimSpace(config.APIKey) != ""
		config.ManagementKeyConfigured = strings.TrimSpace(config.ManagementKey) != ""
	}
	if jsonOutput || oneLine {
		encoded, err := json.Marshal(config)
		if err != nil {
			return err
		}
		if !oneLine {
			encoded, err = json.MarshalIndent(config, "", "  ")
			if err != nil {
				return err
			}
		}
		_, _ = fmt.Fprintln(runtime.stdout, string(encoded))
		return nil
	}
	values := configToValues(config)
	keys := sortedKeys(values)
	_, _ = fmt.Fprintln(runtime.stdout, "[aih] server config")
	for _, key := range keys {
		if filter != "" && !strings.Contains(strings.ToLower(key), strings.ToLower(filter)) {
			continue
		}
		_, _ = fmt.Fprintf(runtime.stdout, "  %s: %s\n", key, formatConfigValue(values[key]))
	}
	return nil
}

func getServerConfig(ctx context.Context, home string, key string, args []string, runtime commandRuntime) error {
	includeSecrets, jsonOutput, _, _ := parseDisplayFlags(args)
	config, err := webuiserverconfigapi.ReadFullConfig(ctx, home)
	if err != nil {
		return err
	}
	if !includeSecrets {
		config = webuiserverconfigapi.PublicConfig(config)
	} else {
		config.APIKeyConfigured = strings.TrimSpace(config.APIKey) != ""
		config.ManagementKeyConfigured = strings.TrimSpace(config.ManagementKey) != ""
	}
	values := configToValues(config)
	name := normalizeConfigKey(key)
	value, found := values[name]
	if !found {
		return fmt.Errorf("unknown server config option: %s", key)
	}
	if jsonOutput {
		encoded, _ := json.Marshal(value)
		_, _ = fmt.Fprintln(runtime.stdout, string(encoded))
		return nil
	}
	_, _ = fmt.Fprintln(runtime.stdout, formatConfigValue(value))
	return nil
}

func listServerConfig(ctx context.Context, home string, args []string, runtime commandRuntime) error {
	return showServerConfig(ctx, home, args, runtime)
}

func setServerConfig(ctx context.Context, home string, args []string, runtime commandRuntime) error {
	patch := map[string]any{}
	for index := 0; index < len(args); index++ {
		flag := args[index]
		if flag == "--json" || flag == "--one-line" || flag == "--verbose" || flag == "--show-secrets" {
			continue
		}
		if flag == "--generate-management-key" {
			key, err := generateManagementKey()
			if err != nil {
				return err
			}
			patch["managementKey"] = key
			continue
		}
		if flag == "--open-network" {
			patch["openNetwork"] = true
			continue
		}
		if flag == "--local-only" {
			patch["openNetwork"] = false
			continue
		}
		if flag == "--window-activation" {
			patch["windowActivation"] = true
			continue
		}
		if flag == "--no-window-activation" {
			patch["windowActivation"] = false
			continue
		}
		if flag == "--go-core" {
			patch["goCoreEnabled"] = true
			continue
		}
		if flag == "--no-go-core" {
			patch["goCoreEnabled"] = false
			continue
		}
		if strings.HasPrefix(flag, "--clear-") {
			key, ok := clearConfigKey(strings.TrimPrefix(flag, "--clear-"))
			if !ok {
				return fmt.Errorf("unknown server config option: %s", flag)
			}
			patch[key] = clearConfigValue(key)
			continue
		}
		key, ok := configFlagKey(flag)
		if !ok {
			return fmt.Errorf("unknown server config option: %s", flag)
		}
		if index+1 >= len(args) || strings.HasPrefix(args[index+1], "--") {
			return fmt.Errorf("%s requires a value", flag)
		}
		index++
		patch[key] = args[index]
	}
	if len(patch) == 0 {
		return errors.New("server config set requires at least one option")
	}
	if _, err := webuiserverconfigapi.ApplyConfigPatch(ctx, home, patch); err != nil {
		return err
	}
	_, _ = fmt.Fprintln(runtime.stdout, "[aih] server config saved; run aih server restart to apply it.")
	return nil
}

func parseDisplayFlags(args []string) (includeSecrets bool, jsonOutput bool, oneLine bool, filter string) {
	for _, arg := range args {
		switch arg {
		case "--show-secrets":
			includeSecrets = true
		case "--json":
			jsonOutput = true
		case "--one-line":
			oneLine = true
		default:
			if !strings.HasPrefix(arg, "-") {
				filter = arg
			}
		}
	}
	return
}

func configFlagKey(flag string) (string, bool) {
	keys := map[string]string{
		"--host": "host", "--port": "port", "--client-key": "apiKey",
		"--management-key": "managementKey", "--proxy-url": "proxyUrl",
		"--no-proxy": "noProxy", "--models-probe-accounts": "modelsProbeAccounts",
		"--window-activation-default-interval-ms": "windowActivationDefaultIntervalMs",
		"--window-activation-min-interval-ms":     "windowActivationMinIntervalMs",
		"--go-core-routes":                        "goCoreRoutes", "--upstream-error-rules": "upstreamErrorRuleProviders",
		"--relay-udp": "relayUdp", "--relay-udp-advertise-host": "relayUdpAdvertiseHost",
		"--relay-udp-advertise-port": "relayUdpAdvertisePort", "--relay-port-mode": "relayPortMode",
		"--relay-listen-host": "relayListenHost", "--max-attempts": "maxAttempts",
		"--egress-evidence-ttl-ms": "egressEvidenceTtlMs", "--large-paste-chars": "largePasteChars",
	}
	key, ok := keys[flag]
	return key, ok
}

func clearConfigKey(name string) (string, bool) {
	mapping := map[string]string{
		"max-attempts": "maxAttempts", "large-paste-chars": "largePasteChars",
		"egress-evidence-ttl-ms": "egressEvidenceTtlMs", "relay-udp-advertise-host": "relayUdpAdvertiseHost",
		"relay-udp-advertise-port": "relayUdpAdvertisePort", "relay-listen-host": "relayListenHost",
		"go-core-routes": "goCoreRoutes", "upstream-error-rules": "upstreamErrorRuleProviders",
	}
	key, ok := mapping[name]
	return key, ok
}

func clearConfigValue(key string) any {
	switch key {
	case "goCoreRoutes", "upstreamErrorRuleProviders":
		return []string{}
	default:
		return 0
	}
}

func configToValues(config webuiserverconfigapi.ConfigView) map[string]any {
	encoded, _ := json.Marshal(config)
	var values map[string]any
	_ = json.Unmarshal(encoded, &values)
	if values == nil {
		values = map[string]any{}
	}
	return values
}

func normalizeConfigKey(key string) string {
	trimmed := strings.TrimSpace(key)
	if trimmed == "" {
		return ""
	}
	parts := strings.Split(trimmed, "-")
	for index := 1; index < len(parts); index++ {
		if parts[index] == "" {
			continue
		}
		parts[index] = strings.ToUpper(parts[index][:1]) + parts[index][1:]
	}
	return strings.Join(parts, "")
}

func sortedKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func formatConfigValue(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		return strconv.FormatBool(typed)
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		encoded, _ := json.Marshal(typed)
		return string(encoded)
	}
}

func generateManagementKey() (string, error) {
	raw := make([]byte, 24)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}
