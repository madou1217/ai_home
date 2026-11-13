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
