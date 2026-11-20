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

	corepolicy "github.com/madou1217/ai_home/core/upstreamretry"
	"github.com/madou1217/ai_home/internal/transport/http/webuiserverconfigapi"
)

func showServerConfigUsage(runtime commandRuntime) {
	_, _ = fmt.Fprintln(runtime.stdout, "\x1b[90mUsage:\x1b[0m aih server config [show|get|set|unset|list] [--show-secrets] [--qr [--qr-url <server-url>]] [--json] [--one-line] [--verbose] [<filter>] [--host <ip>] [--port <n>] [--client-key <key>] [--management-key <key>|--generate-management-key] [--proxy-url <a,b,c>|--clear-proxy-url] [--clear-management-key --confirm-clear-management-key] [--open-network|--local-only] [--window-activation|--no-window-activation] [--window-activation-default-interval-ms <ms>] [--window-activation-min-interval-ms <ms>] [--go-core|--no-go-core] [--go-core-routes <entry-ids>|--clear-go-core-routes] [--upstream-error-rules <providers>|--clear-upstream-error-rules] [--upstream-429-retry|--no-upstream-429-retry] [--upstream-429-retry-backoff <sec,...>|--clear-upstream-429-retry-backoff] [--relay-udp on|off|default] [--relay-udp-advertise-host <host>|--clear-relay-udp-advertise-host] [--relay-udp-advertise-port <port>|--clear-relay-udp-advertise-port] [--max-attempts <1..32>|--clear-max-attempts] [--large-paste-chars <50..100000>|--clear-large-paste-chars] [--egress-evidence-ttl-ms <ms>|--clear-egress-evidence-ttl-ms] [--relay-port-mode server|dedicated|default] [--relay-listen-host <host>|--clear-relay-listen-host]")
	_, _ = fmt.Fprintln(runtime.stdout, "\x1b[90m      \x1b[0m `aih server config list` 列出全部可设置参数、默认值与含义（`-l` / `--list` / `ls` 等价）。")
}

func runServerConfig(ctx context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	if len(arguments) < 2 || arguments[0] != "server" || arguments[1] != "config" {
		return false, nil
	}
	for _, argument := range arguments[2:] {
		if argument == "--help" || argument == "-h" || argument == "help" {
			showServerConfigUsage(runtime)
			return true, nil
		}
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
	case "show", "get", "set", "unset", "list", "ls", "-l":
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
	case "unset":
		return true, unsetServerConfig(ctx, home, rest, runtime)
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
	flags := parseDisplayFlags(args)
	includeSecrets, jsonOutput, oneLine, filter := flags.showSecrets, flags.json, flags.oneLine, flags.filter
	if flags.qr {
		if !includeSecrets {
			return errors.New("--qr 需要同时传 --show-secrets")
		}
		if jsonOutput || oneLine {
			return errors.New("--qr 仅用于终端显示，不能与 --json/--one-line 一起使用")
		}
		return printServerConfigQR(ctx, home, flags.qrURL, runtime)
	}
	if flags.qrURL != "" {
		return errors.New("--qr-url 需要同时传 --qr")
	}
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
	flags := parseDisplayFlags(args)
	includeSecrets, jsonOutput := flags.showSecrets, flags.json
	if flags.qr {
		if !includeSecrets {
			return errors.New("--qr 需要同时传 --show-secrets")
		}
		return printServerConfigQR(ctx, home, flags.qrURL, runtime)
	}
	if flags.qrURL != "" {
		return errors.New("--qr-url 需要同时传 --qr")
	}
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

func unsetServerConfig(ctx context.Context, home string, args []string, runtime commandRuntime) error {
	if len(args) == 0 {
		return errors.New("server config unset requires a key, e.g. proxy-url")
	}
	patch := map[string]any{}
	for _, raw := range args {
		key := normalizeConfigKey(raw)
		switch key {
		case "proxyUrl":
			patch["proxyUrl"] = ""
		default:
			return fmt.Errorf("server config unset does not support: %s", raw)
		}
	}
	if _, err := webuiserverconfigapi.ApplyConfigPatch(ctx, home, patch); err != nil {
		return err
	}
	_, _ = fmt.Fprintln(runtime.stdout, "[aih] proxy pool cleared; takes effect without restarting the server.")
	return nil
}

func setServerConfig(ctx context.Context, home string, args []string, runtime commandRuntime) error {
	patch := map[string]any{}
	clearManagementKey := false
	confirmClearManagementKey := false
	for index := 0; index < len(args); index++ {
		flag := args[index]
		if flag == "--json" || flag == "--one-line" || flag == "--verbose" || flag == "--show-secrets" {
			continue
		}
		if flag == "--qr" || flag == "--qr-url" || strings.HasPrefix(flag, "--qr-url=") {
			return errors.New("--qr 只能用于 show/get，不能和设置项一起使用")
		}
		if flag == "--clear-management-key" {
			clearManagementKey = true
			continue
		}
		if flag == "--confirm-clear-management-key" {
			confirmClearManagementKey = true
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
		if flag == "--upstream-429-retry" {
			setUpstream429RetryField(patch, "enabled", true)
			continue
		}
		if flag == "--no-upstream-429-retry" {
			setUpstream429RetryField(patch, "enabled", false)
			continue
		}
		if flag == "--clear-upstream-429-retry-backoff" {
			setUpstream429RetryField(patch, "backoffSeconds", corepolicy.DefaultBackoffSeconds())
			continue
		}
		if flag == "--upstream-429-retry-backoff" || strings.HasPrefix(flag, "--upstream-429-retry-backoff=") {
			var rawBackoff string
			if strings.HasPrefix(flag, "--upstream-429-retry-backoff=") {
				rawBackoff = strings.TrimPrefix(flag, "--upstream-429-retry-backoff=")
			} else {
				if index+1 >= len(args) || strings.HasPrefix(args[index+1], "--") {
					return errors.New("--upstream-429-retry-backoff requires a value")
				}
				index++
				rawBackoff = args[index]
			}
			steps, err := parseUpstream429BackoffCSV(rawBackoff, "--upstream-429-retry-backoff")
			if err != nil {
				return err
			}
			setUpstream429RetryField(patch, "backoffSeconds", steps)
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
		value := args[index]
		if key == "modelCacheSync" && value != "scheduler" && value != "go-batch" {
			return errors.New("Invalid --model-cache-sync value: 只接受 scheduler 或 go-batch")
		}
		patch[key] = value
	}
	if clearManagementKey && !confirmClearManagementKey {
		return errors.New("--clear-management-key requires --confirm-clear-management-key")
	}
	if len(patch) == 0 && !clearManagementKey {
		return errors.New("server config set requires at least one option")
	}
	if len(patch) > 0 {
		if _, err := webuiserverconfigapi.ApplyConfigPatch(ctx, home, patch); err != nil {
			return err
		}
	}
	if clearManagementKey {
		if err := webuiserverconfigapi.ClearManagementKey(ctx, home); err != nil {
			return err
		}
	}
	if serverConfigPatchRequiresRestart(patch, clearManagementKey) {
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] server config saved; run aih server restart to apply it.")
	} else {
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] server config saved; proxy pool and upstream 429 retry changes take effect automatically without restarting the server.")
	}
	return nil
}

func setUpstream429RetryField(patch map[string]any, field string, value any) {
	nested, ok := patch["upstream429Retry"].(map[string]any)
	if !ok || nested == nil {
		nested = map[string]any{}
		patch["upstream429Retry"] = nested
	}
	nested[field] = value
}

func parseUpstream429BackoffCSV(raw string, flagName string) ([]int, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, fmt.Errorf("%s requires comma-separated integer seconds (e.g. 30 or 10,30,60)", flagName)
	}
	parts := strings.Split(trimmed, ",")
	steps := make([]int, 0, len(parts))
	for _, part := range parts {
		token := strings.TrimSpace(part)
		if !isASCIIUnsignedDigits(token) {
			return nil, fmt.Errorf("%s contains invalid integer %q", flagName, token)
		}
		value, err := strconv.Atoi(token)
		if err != nil {
			return nil, fmt.Errorf("%s contains invalid integer %q", flagName, token)
		}
		steps = append(steps, value)
	}
	return corepolicy.ValidateBackoffSeconds(steps)
}

func isASCIIUnsignedDigits(text string) bool {
	if text == "" {
		return false
	}
	for index := 0; index < len(text); index++ {
		if text[index] < '0' || text[index] > '9' {
			return false
		}
	}
	return true
}

func serverConfigPatchRequiresRestart(patch map[string]any, clearManagementKey bool) bool {
	if clearManagementKey {
		return true
	}
	for key := range patch {
		if key != "upstream429Retry" && key != "proxyUrl" {
			return true
		}
	}
	return false
}

type configDisplayFlags struct {
	showSecrets bool
	json        bool
	oneLine     bool
	filter      string
	qr          bool
	qrURL       string
}

func parseDisplayFlags(args []string) configDisplayFlags {
	flags := configDisplayFlags{}
	for index := 0; index < len(args); index++ {
		arg := args[index]
		switch {
		case arg == "--show-secrets":
			flags.showSecrets = true
		case arg == "--json":
			flags.json = true
		case arg == "--one-line":
			flags.oneLine = true
		case arg == "--qr":
			flags.qr = true
		case strings.HasPrefix(arg, "--qr-url="):
			flags.qrURL = strings.TrimPrefix(arg, "--qr-url=")
		case arg == "--qr-url":
			if index+1 < len(args) {
				index++
				flags.qrURL = strings.TrimSpace(args[index])
			}
		case !strings.HasPrefix(arg, "-"):
			flags.filter = arg
		}
	}
	return flags
}

func configFlagKey(flag string) (string, bool) {
	keys := map[string]string{
		"--host": "host", "--port": "port", "--client-key": "apiKey",
		"--management-key": "managementKey", "--proxy-url": "proxyUrl",
		"--no-proxy": "noProxy", "--models-probe-accounts": "modelsProbeAccounts",
		"--model-cache-sync":                      "modelCacheSync",
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
		"proxy-url": "proxyUrl",
	}
	key, ok := mapping[name]
	return key, ok
}

func clearConfigValue(key string) any {
	switch key {
	case "goCoreRoutes", "upstreamErrorRuleProviders":
		return []string{}
	case "proxyUrl":
		return ""
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
	if strings.EqualFold(trimmed, "upstream_429_retry") {
		return "upstream429Retry"
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
