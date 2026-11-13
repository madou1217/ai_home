package clilogin

import (
	"context"
	"encoding/json"
	"runtime"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/accounts/kirodb"
)

func kiroArtifact(t *testing.T, access string, refresh string) []byte {
	t.Helper()
	endpoint := "https://codewhisperer.us-east-1.amazonaws.com"
	authJSON := map[string]any{"access_token": access, "refresh_token": refresh, "region": "us-east-1", "expires_at": "2099-01-02T03:04:05.000Z"}
	rawAuth, err := json.Marshal(authJSON)
	if err != nil {
		t.Fatal(err)
	}
	var authObject map[string]json.RawMessage
	if err := json.Unmarshal(rawAuth, &authObject); err != nil {
		t.Fatal(err)
	}
	artifact := map[string]any{
		"auth":   json.RawMessage(rawAuth),
		"flavor": "desktop",
		"identityEvidence": map[string]any{
			"version":      1,
			"source":       "aws-codewhisperer:GetUsageLimits",
			"endpoint":     endpoint,
			"subject":      "kirouser1",
			"tokenBinding": kirodb.TokenBinding(authObject),
			"observedAtMs": 1_700_000_000_000,
		},
	}
	encoded, err := json.Marshal(artifact)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestRunRegistersKiroLogin(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("假 CLI 用 sh 脚本")
	}
	previousRead := kiroReadAuth
	kiroReadAuth = func(context.Context, string) (kirodb.Auth, bool, error) {
		raw := []byte(`{"access_token":"access-1","refresh_token":"refresh-1","region":"us-east-1"}`)
		return kirodb.Auth{Raw: raw, Slot: "kirocli:odic:token", Flavour: "odic"}, true, nil
	}
	previousImport := kiroImport
	kiroImport = func(refreshToken string, region string) ([]byte, error) {
		if refreshToken != "refresh-1" || region != "us-east-1" {
			t.Fatalf("unexpected import input %q/%q", refreshToken, region)
		}
		return kiroArtifact(t, "access-1", "refresh-1"), nil
	}
	t.Cleanup(func() {
		kiroReadAuth = previousRead
		kiroImport = previousImport
	})
	script := writeFakeBinary(t, "kiro-cli", "exit 0\n")
	t.Setenv("AIH_KIRO_BINARY", script)
	var output strings.Builder
	account, err := Run(context.Background(), Options{
		AIHomeDir:   t.TempDir(),
		HostHomeDir: t.TempDir(),
		ProviderID:  "kiro",
		Stdin:       strings.NewReader(""),
		Stdout:      &output,
		Stderr:      &output,
	})
	if err != nil {
		t.Fatalf("Run: %v\n%s", err, output.String())
	}
	if account.ProviderID() != "kiro" || account.Ref().String() == "" {
		t.Fatalf("account = %s %s", account.ProviderID(), account.Ref())
	}
}
