package realcredential

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
)

// TestDecodeCodexSub2APIAcceptsSingleAPIKeyAccount 验证标准迁移格式通过内存读取。
func TestDecodeCodexSub2APIAcceptsSingleAPIKeyAccount(t *testing.T) {
	t.Parallel()

	credential, err := DecodeCodexSub2API(strings.NewReader(`{
  "type":"sub2api-data","version":1,"exported_at":"2026-08-13T12:00:00Z",
  "proxies":[],"accounts":[{"name":"codex-live","platform":"openai",
  "type":"apikey","credentials":{"api_key":"sk-test-secret",
  "base_url":"https://example.com/v1"},"concurrency":0,"priority":0}]
}`))
	if err != nil {
		t.Fatalf("DecodeCodexSub2API() error = %v", err)
	}
	if _, ok := credential.(*codexauth.APIKeyAuth); !ok {
		t.Fatalf("credential type = %T", credential)
	}
}

// TestDecodeClaudeAuthTokenRejectsUnknownFields 验证私有 stdin DTO 严格拒绝扩展。
func TestDecodeClaudeAuthTokenRejectsUnknownFields(t *testing.T) {
	t.Parallel()

	credential, err := DecodeClaudeAuthToken(strings.NewReader(
		`{"auth_token":"test-token","base_url":"https://example.com","extra":true}`,
	))
	if err == nil || credential != nil {
		t.Fatalf("DecodeClaudeAuthToken() credential=%T error=%v", credential, err)
	}

	credential, err = DecodeClaudeAuthToken(strings.NewReader(
		`{"auth_token":"test-token","base_url":"https://example.com"}`,
	))
	if err != nil {
		t.Fatalf("DecodeClaudeAuthToken(valid) error = %v", err)
	}
	if _, ok := credential.(*claudeauth.AuthTokenAuth); !ok {
		t.Fatalf("credential type = %T", credential)
	}
}

// TestDecodeCodexSub2APIErrorsNeverEchoCredential 验证固定错误链不会泄漏输入。
func TestDecodeCodexSub2APIErrorsNeverEchoCredential(t *testing.T) {
	t.Parallel()

	const secret = "sk-sensitive-test-secret"
	credential, err := DecodeCodexSub2API(strings.NewReader(`{
  "type":"sub2api-data","exported_at":"invalid","proxies":[],
  "accounts":[{"name":"codex-live","platform":"openai","type":"apikey",
  "credentials":{"api_key":"` + secret + `"},"concurrency":0,"priority":0}]
}`))
	if credential != nil || !errors.Is(err, ErrInvalidCredential) ||
		strings.Contains(err.Error(), secret) {
		t.Fatalf("DecodeCodexSub2API() credential=%T safe_error=%t", credential, err != nil)
	}
}

// TestPrivateFileDecodersRequireRegular0600Files 验证真实凭据文件权限边界。
func TestPrivateFileDecodersRequireRegular0600Files(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "credential.json")
	payload := []byte(`{"auth_token":"test-token","base_url":"https://example.com"}`)
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	clear(payload)
	credential, err := DecodeClaudeAuthTokenFile(path)
	if err != nil || credential == nil {
		t.Fatalf("DecodeClaudeAuthTokenFile() credential=%T error=%v", credential, err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatalf("Chmod() error = %v", err)
	}
	credential, err = DecodeClaudeAuthTokenFile(path)
	if credential != nil || !errors.Is(err, ErrInvalidCredential) {
		t.Fatalf("DecodeClaudeAuthTokenFile(0644) credential=%T error=%v", credential, err)
	}
}
