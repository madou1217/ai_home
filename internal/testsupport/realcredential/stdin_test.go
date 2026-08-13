package realcredential

import (
	"errors"
	"fmt"
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

// TestDecodeCodexAccountFileBindsPersistedIdentity 验证 Codex 标准迁移凭据只能
// 与同一个私有 envelope 中的正式账号身份一起进入真实验收。
func TestDecodeCodexAccountFileBindsPersistedIdentity(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "codex-account.json")
	payload := []byte(`{
  "account_ref":"acct_0123456789abcdef0123",
  "models":["gpt-5.6-luna","gpt-5.4"],
  "credential":{
    "type":"sub2api-data","version":1,
    "exported_at":"2026-08-13T12:00:00Z","proxies":[],
    "accounts":[{"name":"codex-live","platform":"openai",
    "type":"apikey","credentials":{"api_key":"sk-test-secret",
    "base_url":"https://example.com/v1"},"concurrency":0,"priority":0}]
  }
}`)
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	clear(payload)
	accountRef, credential, models, err := DecodeCodexAccountFile(path)
	if err != nil || accountRef.String() != "acct_0123456789abcdef0123" {
		t.Fatalf(
			"DecodeCodexAccountFile() account_valid=%t credential=%T models=%v error=%v",
			accountRef.IsValid(),
			credential,
			models,
			err,
		)
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

// TestAccountFileDecodersBindIdentityAndRequire0600 验证同一私有 envelope 同时绑定
// 正式账号身份、凭据与文件权限边界。
func TestAccountFileDecodersBindIdentityAndRequire0600(t *testing.T) {
	t.Parallel()

	path := filepath.Join(t.TempDir(), "credential.json")
	payload := []byte(`{
  "account_ref":"acct_0123456789abcdef0123",
  "models":["glm-5.2","glm-5.1"],
  "credential":{"auth_token":"test-token","base_url":"https://example.com"}
}`)
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	clear(payload)
	accountRef, credential, models, err := DecodeClaudeAccountFile(path)
	if err != nil || credential == nil ||
		accountRef.String() != "acct_0123456789abcdef0123" || len(models) != 2 {
		t.Fatalf(
			"DecodeClaudeAccountFile() account_valid=%t credential=%T models=%v error=%v",
			accountRef.IsValid(),
			credential,
			models,
			err,
		)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatalf("Chmod() error = %v", err)
	}
	accountRef, credential, models, err = DecodeClaudeAccountFile(path)
	if accountRef.IsValid() || credential != nil ||
		models != nil || !errors.Is(err, ErrInvalidCredential) {
		t.Fatalf(
			"DecodeClaudeAccountFile(0644) account_valid=%t credential=%T error=%v",
			accountRef.IsValid(),
			credential,
			err,
		)
	}
}

// TestAccountFileDecoderRejectsUnboundOrUnknownIdentity 验证凭据不能脱离正式身份，
// envelope 也不接受调用方自定义扩展字段。
func TestAccountFileDecoderRejectsUnboundOrUnknownIdentity(t *testing.T) {
	t.Parallel()

	tests := []string{
		`{"credential":{"auth_token":"test-token","base_url":"https://example.com"}}`,
		`{"account_ref":"acct_0123456789abcdef0123","models":["glm-5.2"],"credential":{"auth_token":"test-token","base_url":"https://example.com"},"alias":5}`,
		`{"account_ref":"acct_0123456789abcdef0123","models":[],"credential":{"auth_token":"test-token","base_url":"https://example.com"}}`,
		`{"account_ref":"acct_0123456789abcdef0123","models":["glm-5.2","glm-5.2"],"credential":{"auth_token":"test-token","base_url":"https://example.com"}}`,
	}
	for index, payload := range tests {
		path := filepath.Join(t.TempDir(), fmt.Sprintf("credential-%d.json", index))
		if err := os.WriteFile(path, []byte(payload), 0o600); err != nil {
			t.Fatalf("WriteFile() error = %v", err)
		}
		accountRef, credential, models, err := DecodeClaudeAccountFile(path)
		if accountRef.IsValid() || credential != nil ||
			models != nil || !errors.Is(err, ErrInvalidCredential) {
			t.Fatalf(
				"DecodeClaudeAccountFile(%d) account_valid=%t credential=%T error=%v",
				index,
				accountRef.IsValid(),
				credential,
				err,
			)
		}
	}
}

// TestContainsModelsRequiresEveryRequestedModel 验证目录检查不会只命中目标模型
// 就忽略兄弟模型，也不会接受空请求集合。
func TestContainsModelsRequiresEveryRequestedModel(t *testing.T) {
	t.Parallel()

	models := []string{"gpt-5.6-luna", "gpt-5.4"}
	if !ContainsModels(models, "gpt-5.6-luna", "gpt-5.4") ||
		ContainsModels(models, "gpt-5.6-luna", "gpt-missing") ||
		ContainsModels(models) {
		t.Fatal("ContainsModels() 没有执行完整集合包含检查")
	}
}
