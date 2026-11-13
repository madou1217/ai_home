package clilogin

import (
	"context"
	"runtime"
	"strings"
	"testing"
)

func TestRunRegistersClineLogin(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("假 CLI 用 sh 脚本")
	}
	script := writeFakeBinary(t, "cline", `mkdir -p "$CLINE_DATA_DIR/settings"
printf '%s' '{"version":1,"lastUsedProvider":"cline","providers":{"cline":{"settings":{"auth":{"accessToken":"workos:eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ1c2VyX2NsaW5lXzEiLCJpYXQiOjE3MDAwMDAwMDB9.sig","refreshToken":"refresh-1","expiresAt":4070903045000}}}}}' > "$CLINE_DATA_DIR/settings/providers.json"
`)
	t.Setenv("AIH_CLINE_BINARY", script)
	var output strings.Builder
	account, err := Run(context.Background(), Options{
		AIHomeDir:   t.TempDir(),
		HostHomeDir: t.TempDir(),
		ProviderID:  "cline",
		Stdin:       strings.NewReader(""),
		Stdout:      &output,
		Stderr:      &output,
	})
	if err != nil {
		t.Fatalf("Run: %v\n%s", err, output.String())
	}
	if account.ProviderID() != "cline" || account.Ref().String() == "" {
		t.Fatalf("account = %s %s", account.ProviderID(), account.Ref())
	}
}

func TestRunRegistersKimiLogin(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("假 CLI 用 sh 脚本")
	}
	script := writeFakeBinary(t, "kimi", `mkdir -p "$KIMI_CODE_HOME/credentials"
printf '%s' '{"access_token":"eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJraW1pLXVzZXItMSIsImlhdCI6MTcwMDAwMDAwMH0.sig","refresh_token":"refresh-1","user_id":"kimi-user-1"}' > "$KIMI_CODE_HOME/credentials/kimi-code.json"
printf 'device-abc' > "$KIMI_CODE_HOME/device_id"
`)
	t.Setenv("AIH_KIMI_BINARY", script)
	var output strings.Builder
	account, err := Run(context.Background(), Options{
		AIHomeDir:   t.TempDir(),
		HostHomeDir: t.TempDir(),
		ProviderID:  "kimi",
		Stdin:       strings.NewReader(""),
		Stdout:      &output,
		Stderr:      &output,
	})
	if err != nil {
		t.Fatalf("Run: %v\n%s", err, output.String())
	}
	if account.ProviderID() != "kimi" || account.Ref().String() == "" {
		t.Fatalf("account = %s %s", account.ProviderID(), account.Ref())
	}
}
