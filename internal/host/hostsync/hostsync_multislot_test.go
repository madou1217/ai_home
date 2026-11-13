package hostsync

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/accounts/zcodecred"
)

func TestClineHostMergePreservesOtherProviders(t *testing.T) {
	host := t.TempDir()
	target := filepath.Join(host, ".cline", "data", "settings", "providers.json")
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		t.Fatal(err)
	}
	hostDoc := `{"version":1,"lastUsedProvider":"anthropic","providers":{"anthropic":{"settings":{"apiKey":"host-key"}},"cline":{"settings":{"auth":{"accessToken":"old"}}}}}`
	if err := os.WriteFile(target, []byte(hostDoc), 0o600); err != nil {
		t.Fatal(err)
	}
	payload := payloadOf(map[string]any{"auth": map[string]any{
		"version":          1,
		"lastUsedProvider": "cline",
		"providers": map[string]any{
			"cline": map[string]any{"settings": map[string]any{"auth": map[string]any{"accessToken": "new"}}},
		},
	}})
	if _, err := writeHost("cline", payload, host); err != nil {
		t.Fatalf("writeHost: %v", err)
	}
	raw, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	var merged map[string]any
	if err := json.Unmarshal(raw, &merged); err != nil {
		t.Fatal(err)
	}
	providers, _ := merged["providers"].(map[string]any)
	if _, exists := providers["anthropic"]; !exists {
		t.Fatal("宿主 anthropic 槽位被删除")
	}
	cline, _ := providers["cline"].(map[string]any)
	settings, _ := cline["settings"].(map[string]any)
	auth, _ := settings["auth"].(map[string]any)
	if auth["accessToken"] != "new" {
		t.Fatalf("cline 槽位未更新: %#v", auth)
	}
}

func TestZcodeHostEncryptsCredentials(t *testing.T) {
	host := t.TempDir()
	payload := payloadOf(map[string]any{
		"credentials": map[string]any{"oauth:zai:access_token": "plain-token", "oauth:zai:user_info": "{\"user_id\":\"u\"}"},
		"config":      map[string]any{"endpoint": "https://zcode.example.test"},
	})
	if _, err := writeHost("zcode", payload, host); err != nil {
		t.Fatalf("writeHost: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(host, ".zcode", "v2", "credentials.json"))
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	encrypted, _ := document["oauth:zai:access_token"].(string)
	if !zcodecred.IsEncrypted(encrypted) {
		t.Fatalf("宿主凭据未加密: %q", encrypted)
	}
	plain, ok := zcodecred.DecryptValue(encrypted, zcodeHostSecret(host))
	if !ok || plain != "plain-token" {
		t.Fatalf("解密失败: %q ok=%v", plain, ok)
	}
}
