package hostsync

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func payloadOf(value map[string]any) []byte {
	encoded, _ := json.Marshal(value)
	return encoded
}

func TestWriteHostGemini(t *testing.T) {
	host := t.TempDir()
	payload := payloadOf(map[string]any{
		"oauthCreds":     map[string]any{"access_token": "a", "refresh_token": "r", "expiry_date": 4070903045000},
		"googleAccounts": map[string]any{"active": "gemini@example.com", "old": []any{}},
	})
	result, err := writeHost("gemini", payload, host)
	if err != nil {
		t.Fatalf("writeHost: %v", err)
	}
	if len(result.Files) != 2 {
		t.Fatalf("files = %v", result.Files)
	}
	raw, err := os.ReadFile(filepath.Join(host, ".gemini", "oauth_creds.json"))
	if err != nil || len(raw) == 0 {
		t.Fatalf("oauth_creds: %v", err)
	}
}

func TestWriteHostGrokAndOpenCode(t *testing.T) {
	host := t.TempDir()
	if _, err := writeHost("grok", payloadOf(map[string]any{"auth": map[string]any{"user_id": "u", "key": "k"}}), host); err != nil {
		t.Fatalf("grok: %v", err)
	}
	if _, err := os.Stat(filepath.Join(host, ".grok", "auth.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := writeHost("opencode", payloadOf(map[string]any{"auth": map[string]any{"opencode": map[string]any{"type": "api", "key": "k"}}}), host); err != nil {
		t.Fatalf("opencode: %v", err)
	}
	if _, err := os.Stat(filepath.Join(host, ".local", "share", "opencode", "auth.json")); err != nil {
		t.Fatal(err)
	}
}

func TestWriteHostQoder(t *testing.T) {
	host := t.TempDir()
	payload := payloadOf(map[string]any{"credentials": "opaque-blob", "machineId": "machine-1"})
	result, err := writeHost("qoder", payload, host)
	if err != nil {
		t.Fatalf("writeHost: %v", err)
	}
	if len(result.Files) != 2 {
		t.Fatalf("files = %v", result.Files)
	}
	raw, err := os.ReadFile(filepath.Join(host, ".qoder", ".auth", "user"))
	if err != nil || string(raw) != "opaque-blob" {
		t.Fatalf("user = %q err=%v", raw, err)
	}
}

func TestWriteHostUnsupported(t *testing.T) {
	if _, err := writeHost("cline", payloadOf(map[string]any{"auth": map[string]any{}}), t.TempDir()); err == nil {
		t.Fatal("cline 不应被 hostsync 接受")
	}
}
