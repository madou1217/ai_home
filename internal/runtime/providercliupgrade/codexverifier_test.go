package providercliupgrade

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestHealCodexSandboxConfigRespectsMultilineAndRepairsSection(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	raw := "personality = \"pragmatic\"\n" +
		"notice = \"\"\"\n[model_providers.aih_server]\n\"\"\"\n\n" +
		"[model_providers.aih_server]\n" +
		"name = \"\"\n" +
		"wire_api = \"chat\"\n"
	if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(raw), 0o600); err != nil {
		t.Fatalf("write config: %v", err)
	}
	if err := HealCodexSandboxConfig(dir, "http://127.0.0.1:9527/v1"); err != nil {
		t.Fatalf("HealCodexSandboxConfig error = %v", err)
	}
	gotBytes, err := os.ReadFile(filepath.Join(dir, "config.toml"))
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	got := string(gotBytes)
	if !strings.Contains(got, `name = "AIH Server"`) ||
		!strings.Contains(got, `base_url = "http://127.0.0.1:9527/v1"`) ||
		!strings.Contains(got, `env_key = "OPENAI_API_KEY"`) ||
		!strings.Contains(got, `wire_api = "responses"`) {
		t.Fatalf("healed config mismatch:\n%s", got)
	}
}

func TestVerifyCodexAppServerBootOutcomes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell mock script test runs on POSIX")
	}
	t.Parallel()
	dir := t.TempDir()

	passBin := filepath.Join(dir, "codex-pass")
	if err := os.WriteFile(passBin, []byte("#!/bin/sh\necho \"listening on: ws://127.0.0.1:12345\"\nsleep 5\n"), 0o755); err != nil {
		t.Fatalf("write passBin: %v", err)
	}
	resPass := VerifyCodexAppServerBoot(context.Background(), CodexVerifyOptions{
		CLIPath: passBin,
		Timeout: 3 * time.Second,
	})
	if resPass.Verdict != VerdictPass || resPass.Detail != "app_server_listening" {
		t.Fatalf("resPass = %+v", resPass)
	}

	failBin := filepath.Join(dir, "codex-fail")
	if err := os.WriteFile(failBin, []byte("#!/bin/sh\necho \"Error: error loading default config: model_providers.aih_server: provider name must not be empty\" >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatalf("write failBin: %v", err)
	}
	resFail := VerifyCodexAppServerBoot(context.Background(), CodexVerifyOptions{
		CLIPath: failBin,
		Timeout: 3 * time.Second,
	})
	if resFail.Verdict != VerdictFail || !strings.Contains(resFail.Detail, "must not be empty") {
		t.Fatalf("resFail = %+v", resFail)
	}

	incBin := filepath.Join(dir, "codex-inc")
	if err := os.WriteFile(incBin, []byte("#!/bin/sh\nexit 2\n"), 0o755); err != nil {
		t.Fatalf("write incBin: %v", err)
	}
	resInc := VerifyCodexAppServerBoot(context.Background(), CodexVerifyOptions{
		CLIPath: incBin,
		Timeout: 3 * time.Second,
	})
	if resInc.Verdict != VerdictInconclusive {
		t.Fatalf("resInc = %+v", resInc)
	}
}
