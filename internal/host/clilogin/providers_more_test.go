package clilogin

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func writeFakeBinary(t *testing.T, name string, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatalf("写入假 CLI 失败: %v", err)
	}
	return path
}

func TestRunRegistersGrokLogin(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("假 CLI 用 sh 脚本")
	}
	script := writeFakeBinary(t, "grok", `mkdir -p "$HOME/.grok"
printf '%s' '{"user_id":"grokuser1","key":"xai-key-value","refresh_token":"xai-refresh-value"}' > "$HOME/.grok/auth.json"
`)
	t.Setenv("AIH_GROK_BINARY", script)
	var output strings.Builder
	account, err := Run(context.Background(), Options{
		AIHomeDir:   t.TempDir(),
		HostHomeDir: t.TempDir(),
		ProviderID:  "grok",
		Stdin:       strings.NewReader(""),
		Stdout:      &output,
		Stderr:      &output,
	})
	if err != nil {
		t.Fatalf("Run: %v\n%s", err, output.String())
	}
	if account.ProviderID() != "grok" || account.Ref().String() == "" {
		t.Fatalf("account = %s %s", account.ProviderID(), account.Ref())
	}
}

func TestRunRegistersOpenCodeLogin(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("假 CLI 用 sh 脚本")
	}
	script := writeFakeBinary(t, "opencode", `mkdir -p "$XDG_DATA_HOME/opencode"
printf '%s' '{"opencode":{"type":"oauth","access":"access-1","refresh":"refresh-1","account_id":"opencodeuser1"}}' > "$XDG_DATA_HOME/opencode/auth.json"
`)
	t.Setenv("AIH_OPENCODE_BINARY", script)
	var output strings.Builder
	account, err := Run(context.Background(), Options{
		AIHomeDir:   t.TempDir(),
		HostHomeDir: t.TempDir(),
		ProviderID:  "opencode",
		Stdin:       strings.NewReader(""),
		Stdout:      &output,
		Stderr:      &output,
	})
	if err != nil {
		t.Fatalf("Run: %v\n%s", err, output.String())
	}
	if account.ProviderID() != "opencode" || account.Ref().String() == "" {
		t.Fatalf("account = %s %s", account.ProviderID(), account.Ref())
	}
}
