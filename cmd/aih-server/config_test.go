package main

import (
	"errors"
	"io"
	"strings"
	"testing"
)

func baseTestEnv(overrides map[string]string) func(string) (string, bool) {
	env := map[string]string{
		"AIH_SERVER_MANAGEMENT_KEY": strings.Repeat("m", 32),
		"AIH_SERVER_API_KEY":        strings.Repeat("c", 32),
	}
	for k, v := range overrides {
		env[k] = v
	}
	return func(key string) (string, bool) {
		val, ok := env[key]
		return val, ok
	}
}

func testRuntime(envOverrides map[string]string) commandRuntime {
	return commandRuntime{
		lookupEnv:   baseTestEnv(envOverrides),
		userHomeDir: func() (string, error) { return "/tmp/user-home", nil },
		stdout:      io.Discard,
		stderr:      io.Discard,
	}
}

func TestLoadCommandConfigOptionalRestartPaths(t *testing.T) {
	cfg, err := loadCommandConfig(nil, testRuntime(nil))
	if err != nil {
		t.Fatalf("loadCommandConfig default failed: %v", err)
	}
	if cfg.nodeExecPath != "" || cfg.entryFilePath != "" {
		t.Fatalf("expected empty optional restart paths by default, got node=%q entry=%q", cfg.nodeExecPath, cfg.entryFilePath)
	}

	cfg, err = loadCommandConfig(nil, testRuntime(map[string]string{
		"AIH_SERVER_NODE_EXEC":  " /usr/local/bin/node ",
		"AIH_SERVER_ENTRY_FILE": "/opt/ai_home/bin/ai-home.js",
	}))
	if err != nil {
		t.Fatalf("loadCommandConfig with valid restart env failed: %v", err)
	}
	if cfg.nodeExecPath != "/usr/local/bin/node" || cfg.entryFilePath != "/opt/ai_home/bin/ai-home.js" {
		t.Fatalf("unexpected restart paths: node=%q entry=%q", cfg.nodeExecPath, cfg.entryFilePath)
	}

	cfg, err = loadCommandConfig(nil, testRuntime(map[string]string{
		"AIH_SERVER_NODE_EXEC":  "",
		"AIH_SERVER_ENTRY_FILE": "",
	}))
	if err != nil {
		t.Fatalf("loadCommandConfig with empty restart env should remain optional: %v", err)
	}
	if cfg.nodeExecPath != "" || cfg.entryFilePath != "" {
		t.Fatalf("expected empty paths for empty env values, got node=%q entry=%q", cfg.nodeExecPath, cfg.entryFilePath)
	}
}

func TestLoadCommandConfigRejectsBrokenRestartPaths(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
	}{
		{
			name: "whitespace-only node exec",
			env:  map[string]string{"AIH_SERVER_NODE_EXEC": "   "},
		},
		{
			name: "whitespace-only entry file",
			env:  map[string]string{"AIH_SERVER_ENTRY_FILE": "\t"},
		},
		{
			name: "control character in node exec",
			env:  map[string]string{"AIH_SERVER_NODE_EXEC": "/bin/node\x00"},
		},
		{
			name: "newline in entry file",
			env:  map[string]string{"AIH_SERVER_ENTRY_FILE": "/opt/ai-home.js\n"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := loadCommandConfig(nil, testRuntime(tc.env))
			if !errors.Is(err, errInvalidCommandConfig) {
				t.Fatalf("expected errInvalidCommandConfig, got %v", err)
			}
		})
	}
}

func TestLoadCommandConfigCodexHooksDefaultsAndFlags(t *testing.T) {
	defaults, err := loadCommandConfig(nil, testRuntime(nil))
	if err != nil {
		t.Fatalf("loadCommandConfig(default) failed: %v", err)
	}
	if defaults.codexHooks.enableCLIHook || defaults.codexHooks.enableDesktopHook {
		t.Fatalf("expected codex CLI/Desktop hooks disabled by default, got %+v", defaults.codexHooks)
	}
	if defaults.codexHooks.cliSelfHealIntervalMs != 15000 || defaults.codexHooks.desktopSelfHealIntervalMs != 15000 {
		t.Fatalf("expected 15000ms default intervals, got %+v", defaults.codexHooks)
	}
	if !defaults.codexHooks.traceRemoteControl || !defaults.codexHooks.remoteControlProxy || defaults.codexHooks.traceResponses {
		t.Fatalf("unexpected default trace flags: %+v", defaults.codexHooks)
	}
	if defaults.codexHooks.restartAppServerOnHookChange {
		t.Fatalf("expected restartAppServerOnHookChange false by default")
	}

	args := []string{
		"--node-base-url", "http://127.0.0.1:9527",
		"--enable-codex-cli-hook=true",
		"--enable-codex-desktop-hook=true",
		"--codex-cli-hook-self-heal-interval-ms", "2000",
		"--codex-desktop-hook-self-heal-interval-ms", "3500",
		"--codex-provider-hook-receiver-url", "http://127.0.0.1:9527/custom/provider-hook",
		"--codex-desktop-trace-file", " /tmp/codex-trace.jsonl ",
		"--codex-desktop-trace-responses=true",
		"--codex-desktop-trace-remote-control=false",
		"--codex-desktop-remote-control-proxy=false",
		"--codex-desktop-restart-app-server-on-hook-change=true",
	}
	custom, err := loadCommandConfig(args, testRuntime(nil))
	if err != nil {
		t.Fatalf("loadCommandConfig(custom) failed: %v", err)
	}
	if !custom.codexHooks.enableCLIHook || !custom.codexHooks.enableDesktopHook {
		t.Fatalf("expected hooks enabled, got %+v", custom.codexHooks)
	}
	if custom.codexHooks.cliSelfHealIntervalMs != 2000 || custom.codexHooks.desktopSelfHealIntervalMs != 3500 {
		t.Fatalf("unexpected intervals: %+v", custom.codexHooks)
	}
	if custom.codexHooks.providerHookReceiverURL != "http://127.0.0.1:9527/custom/provider-hook" {
		t.Fatalf("unexpected receiver URL: %q", custom.codexHooks.providerHookReceiverURL)
	}
	if custom.codexHooks.traceFile != "/tmp/codex-trace.jsonl" ||
		!custom.codexHooks.traceResponses ||
		custom.codexHooks.traceRemoteControl ||
		custom.codexHooks.remoteControlProxy ||
		!custom.codexHooks.restartAppServerOnHookChange {
		t.Fatalf("unexpected trace/restart config: %+v", custom.codexHooks)
	}
}

func TestLoadCommandConfigRejectsInvalidCodexHooksFlags(t *testing.T) {
	cases := []struct {
		name string
		args []string
	}{
		{
			name: "zero cli self heal interval",
			args: []string{"--codex-cli-hook-self-heal-interval-ms=0"},
		},
		{
			name: "negative desktop self heal interval",
			args: []string{"--codex-desktop-hook-self-heal-interval-ms=-5"},
		},
		{
			name: "control char in trace file",
			args: []string{"--codex-desktop-trace-file=/tmp/trace\n.jsonl"},
		},
		{
			name: "non-loopback provider hook receiver url",
			args: []string{"--codex-provider-hook-receiver-url=http://example.com/hook"},
		},
		{
			name: "query string in provider hook receiver url",
			args: []string{"--codex-provider-hook-receiver-url=http://127.0.0.1:9527/hook?x=1"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := loadCommandConfig(tc.args, testRuntime(nil))
			if !errors.Is(err, errInvalidCommandConfig) {
				t.Fatalf("expected errInvalidCommandConfig, got %v", err)
			}
		})
	}
}
