package projection

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/accounts/agy"
)

func testAgyAuth(t *testing.T, accessToken string) *agy.OAuthAuth {
	t.Helper()
	refreshedAt := time.Date(2026, time.November, 11, 10, 0, 0, 0, time.UTC)
	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "agy@example.test",
		AccessToken:   accessToken,
		RefreshToken:  "refresh-token",
		ExpiresAtMS:   refreshedAt.Add(time.Hour).UnixMilli(),
		RefreshedAtMS: refreshedAt.UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return auth
}

func readJSON(t *testing.T, path string) map[string]any {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile(%s) error = %v", path, err)
	}
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("Unmarshal(%s) error = %v", path, err)
	}
	return document
}

func TestWriteUpdatesAllAgyProjectionFiles(t *testing.T) {
	aiHomeDir := t.TempDir()
	accountRef := "acct_0123456789abcdef0123"
	runtimeDir := filepath.Join(aiHomeDir, "run", "auth-projections", "agy", accountRef)
	if err := os.MkdirAll(filepath.Join(runtimeDir, ".gemini", "antigravity-cli"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(runtimeDir, ".gemini", "oauth_creds.json"),
		[]byte(`{"access_token":"old","refresh_token":"old-refresh","scope":"cloud-platform"}`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(runtimeDir, ".gemini", "google_accounts.json"),
		[]byte(`{"active":"old@example.test","old":["older@example.test"]}`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(runtimeDir, ".gemini", "antigravity-cli", "email.cache"),
		[]byte("old@example.test"),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(
		filepath.Join(runtimeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
		[]byte(`{"auth_method":"consumer","token":{"access_token":"old"},"custom":"keep-me"}`),
		0o600,
	); err != nil {
		t.Fatal(err)
	}
	auth := testAgyAuth(t, "new-access")
	if err := Write(aiHomeDir, accountRef, auth); err != nil {
		t.Fatalf("Write() error = %v", err)
	}

	creds := readJSON(t, filepath.Join(runtimeDir, ".gemini", "oauth_creds.json"))
	if creds["access_token"] != "new-access" {
		t.Fatalf("oauth_creds access_token = %v", creds["access_token"])
	}
	if creds["scope"] != "cloud-platform" {
		t.Fatalf("oauth_creds scope = %v, want preserved", creds["scope"])
	}
	if number(creds["expiry_date"]) != auth.ExpiresAtMS() {
		t.Fatalf("oauth_creds expiry_date = %v", creds["expiry_date"])
	}

	antigravity := readJSON(t, filepath.Join(runtimeDir, ".gemini", "antigravity-cli", "antigravity-oauth-token"))
	token, _ := antigravity["token"].(map[string]any)
	if token["access_token"] != "new-access" {
		t.Fatalf("antigravity access_token = %v", token["access_token"])
	}
	if antigravity["id_token_email"] != "agy@example.test" {
		t.Fatalf("id_token_email = %v", antigravity["id_token_email"])
	}
	if antigravity["custom"] != "keep-me" {
		t.Fatalf("custom field = %v, want preserved", antigravity["custom"])
	}

	accounts := readJSON(t, filepath.Join(runtimeDir, ".gemini", "google_accounts.json"))
	if accounts["active"] != "agy@example.test" {
		t.Fatalf("google_accounts active = %v", accounts["active"])
	}
	oldAccounts, _ := accounts["old"].([]any)
	if len(oldAccounts) != 1 || oldAccounts[0] != "older@example.test" {
		t.Fatalf("google_accounts old = %v, want preserved", accounts["old"])
	}
	emailCache, err := os.ReadFile(filepath.Join(runtimeDir, ".gemini", "antigravity-cli", "email.cache"))
	if err != nil || string(emailCache) != "agy@example.test" {
		t.Fatalf("email.cache = %q, %v", string(emailCache), err)
	}

	jetski := readJSON(t, filepath.Join(runtimeDir, ".gemini", "jetski-standalone-oauth-token"))
	jetskiToken, _ := jetski["token"].(map[string]any)
	if number(jetskiToken["expires_at_ms"]) != auth.ExpiresAtMS() ||
		number(jetskiToken["refreshed_at_ms"]) != auth.RefreshedAtMS() {
		t.Fatalf("jetski token = %v", jetskiToken)
	}
	if jetski["auth_method"] != "consumer" {
		t.Fatalf("jetski auth_method = %v", jetski["auth_method"])
	}
}

func TestWriteSkipsMissingRuntimeDir(t *testing.T) {
	aiHomeDir := t.TempDir()
	accountRef := "acct_0123456789abcdef0123"
	if err := Write(aiHomeDir, accountRef, testAgyAuth(t, "new-access")); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	runtimeDir := filepath.Join(aiHomeDir, "run", "auth-projections", "agy", accountRef)
	if _, err := os.Stat(runtimeDir); !os.IsNotExist(err) {
		t.Fatalf("runtime dir was created: %v", err)
	}
}

func number(value any) int64 {
	switch typed := value.(type) {
	case float64:
		return int64(typed)
	case int64:
		return typed
	default:
		return 0
	}
}
