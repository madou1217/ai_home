package nativeaccount_test

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

const (
	testCodexAccessToken   = "synthetic-native-codex-access"
	testCodexRefreshToken  = "synthetic-native-codex-refresh"
	testClaudeAccessToken  = "sk-ant-oat01-synthetic-native-access"
	testClaudeRefreshToken = "sk-ant-ort01-synthetic-native-refresh"
)

// TestDecoderBuildsCodexOAuthCredentialAndProfile 验证 Codex 身份只从官方 Token claim 派生。
func TestDecoderBuildsCodexOAuthCredentialAndProfile(t *testing.T) {
	t.Parallel()

	decoder := nativeaccount.NewDecoder()
	credential, profile, err := decoder.Decode(
		"codex",
		wrapArtifacts(t, map[string]any{
			"auth_json": json.RawMessage(codexOAuthArtifact(t)),
		}),
	)
	if err != nil {
		t.Fatalf("Decode(codex) error = %v", err)
	}
	oauth, validCredential := credential.(*codex.OAuthAuth)
	codexProfile, validProfile := profile.(codex.AccountProfile)
	if !validCredential ||
		!validProfile ||
		oauth.IdentitySeed() != codexProfile.IdentitySeed() ||
		codexProfile.Email() != "native-codex@example.invalid" ||
		codexProfile.SubscriptionKind() != "business" ||
		codexProfile.SubscriptionRaw() != "team" {
		t.Fatalf(
			"Codex 原生账号转换错误: credential=%T profile=%T",
			credential,
			profile,
		)
	}
}

// TestDecoderBuildsCodexAPIKeyWithoutProfile 验证官方 API Key 文件不会伪造公开资料。
func TestDecoderBuildsCodexAPIKeyWithoutProfile(t *testing.T) {
	t.Parallel()

	secret := "synthetic-native-codex-api-key"
	credential, profile, err := nativeaccount.NewDecoder().Decode(
		"codex",
		wrapArtifacts(t, map[string]any{
			"auth_json": map[string]any{
				"auth_mode":      "apikey",
				"OPENAI_API_KEY": secret,
			},
		}),
	)
	if err != nil {
		t.Fatalf("Decode(codex) error = %v", err)
	}
	apiKey, valid := credential.(*codex.APIKeyAuth)
	if !valid || apiKey.APIKey() != secret || profile != nil {
		t.Fatalf(
			"Codex API Key 转换错误: credential=%T profile=%T",
			credential,
			profile,
		)
	}
}

// TestDecoderBuildsClaudeOAuthCredentialAndProfile 验证两个 Claude artifact 按稳定 UUID 组合。
func TestDecoderBuildsClaudeOAuthCredentialAndProfile(t *testing.T) {
	t.Parallel()

	credential, profile, err := nativeaccount.NewDecoder().Decode(
		"claude",
		wrapArtifacts(t, map[string]any{
			"credentials_json":   json.RawMessage(claudeCredentialsArtifact()),
			"global_config_json": json.RawMessage(claudeGlobalConfigArtifact()),
		}),
	)
	if err != nil {
		t.Fatalf("Decode(claude) error = %v", err)
	}
	oauth, validCredential := credential.(*claude.OAuthAuth)
	claudeProfile, validProfile := profile.(claude.AccountProfile)
	if !validCredential ||
		!validProfile ||
		oauth.IdentitySeed() != claudeProfile.IdentitySeed() ||
		claudeProfile.Email() != "native-claude@example.invalid" ||
		claudeProfile.SubscriptionKind() != "max" {
		t.Fatalf(
			"Claude 原生账号转换错误: credential=%T profile=%T",
			credential,
			profile,
		)
	}
}

// TestDecoderErrorsNeverExposeArtifacts 验证所有失败都收敛为不包含凭据的固定错误。
func TestDecoderErrorsNeverExposeArtifacts(t *testing.T) {
	t.Parallel()

	decoder := nativeaccount.NewDecoder()
	tests := []struct {
		name string
		run  func() error
	}{
		{
			name: "invalid codex",
			run: func() error {
				_, _, err := decoder.Decode(
					"codex",
					[]byte(
						`{"auth_json":{`+
							`"secret":"synthetic-codex-must-not-leak"}}`,
					),
				)
				return err
			},
		},
		{
			name: "invalid claude",
			run: func() error {
				_, _, err := decoder.Decode(
					"claude",
					[]byte(
						`{"credentials_json":{"claudeAiOauth":{`+
							`"accessToken":"synthetic-claude-must-not-leak"}},`+
							`"global_config_json":`+
							string(claudeGlobalConfigArtifact())+
							`}`,
					),
				)
				return err
			},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			err := test.run()
			if !errors.Is(err, nativeaccount.ErrInvalidNativeArtifacts) {
				t.Fatalf("error = %v, want ErrInvalidNativeArtifacts", err)
			}
			if strings.Contains(err.Error(), "must-not-leak") {
				t.Fatalf("错误泄漏 artifact: %v", err)
			}
		})
	}
}

// TestDecoderUsesProviderStrategyRegistry 验证 HTTP 端口不需要为每个 Provider 增加方法。
func TestDecoderUsesProviderStrategyRegistry(t *testing.T) {
	t.Parallel()

	decoder := nativeaccount.NewDecoder()
	if !decoder.Supports("codex") ||
		!decoder.Supports("claude") ||
		decoder.Supports("gemini") {
		t.Fatal("原生账号策略注册表错误")
	}
	_, _, err := decoder.Decode("gemini", []byte(`{}`))
	if !errors.Is(err, nativeaccount.ErrInvalidNativeArtifacts) {
		t.Fatalf("Decode(gemini) error = %v", err)
	}
}

// codexOAuthArtifact 创建不含真实凭据的官方 Codex OAuth auth.json。
func codexOAuthArtifact(t *testing.T) []byte {
	t.Helper()

	idToken := buildTestJWT(t, map[string]any{
		"sub":   "native-codex-user",
		"email": "native-codex@example.invalid",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "native-codex-workspace",
			"chatgpt_plan_type":  "team",
		},
	})
	return marshalTestJSON(t, map[string]any{
		"auth_mode":      "chatgpt",
		"OPENAI_API_KEY": nil,
		"tokens": map[string]any{
			"id_token":      idToken,
			"access_token":  testCodexAccessToken,
			"refresh_token": testCodexRefreshToken,
			"account_id":    "native-codex-workspace",
		},
		"last_refresh": "2026-07-27T10:00:00Z",
	})
}

// claudeCredentialsArtifact 创建官方 Claude secure storage OAuth JSON。
func claudeCredentialsArtifact() []byte {
	return []byte(
		`{"claudeAiOauth":{` +
			`"accessToken":"` + testClaudeAccessToken + `",` +
			`"refreshToken":"` + testClaudeRefreshToken + `",` +
			`"expiresAt":4102444800000,` +
			`"scopes":["user:inference","user:profile"],` +
			`"subscriptionType":"max",` +
			`"rateLimitTier":"default_claude_max_20x"}}`,
	)
}

// claudeGlobalConfigArtifact 创建只含官方 oauthAccount 的全局配置 JSON。
func claudeGlobalConfigArtifact() []byte {
	return []byte(
		`{"oauthAccount":{` +
			`"accountUuid":"123e4567-e89b-12d3-a456-426614174111",` +
			`"emailAddress":"native-claude@example.invalid",` +
			`"displayName":"Native Claude"}}`,
	)
}

// buildTestJWT 创建领域解析测试使用的无签名 JWT。
func buildTestJWT(t *testing.T, payload map[string]any) string {
	t.Helper()

	header := marshalTestJSON(t, map[string]any{
		"alg": "none",
		"typ": "JWT",
	})
	body := marshalTestJSON(t, payload)
	return base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(body) +
		".signature"
}

// marshalTestJSON 把测试值编码为确定的 JSON artifact。
func marshalTestJSON(t *testing.T, value any) []byte {
	t.Helper()

	document, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	return document
}

// wrapArtifacts 编码 Provider 策略接收的 artifact envelope。
func wrapArtifacts(t *testing.T, artifacts map[string]any) []byte {
	t.Helper()

	return marshalTestJSON(t, artifacts)
}
