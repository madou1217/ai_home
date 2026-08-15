package sub2api_test

import (
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sub2api"
)

// TestDecoderDecodesCurrentCodexAndClaudeContracts 验证现行 sub2api 凭据字段进入正确领域类型。
func TestDecoderDecodesCurrentCodexAndClaudeContracts(t *testing.T) {
	t.Parallel()

	codexIDToken := buildExportJWT(t, map[string]any{
		"sub":   "sub2api-codex-user",
		"email": "sub2api-codex@example.invalid",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "sub2api-codex-workspace",
			"chatgpt_plan_type":  "plus",
		},
	})
	tests := []struct {
		name        string
		document    []byte
		assertValue func(*testing.T, accountapp.Credential, accountapp.PublicProfile)
	}{
		{
			name: "codex oauth",
			document: newSub2APIDocument(t, "openai", "oauth", map[string]any{
				"access_token":       "synthetic-sub2api-codex-access",
				"refresh_token":      "synthetic-sub2api-codex-refresh",
				"id_token":           codexIDToken,
				"last_refresh":       "2026-07-31T08:08:10Z",
				"chatgpt_account_id": "sub2api-codex-workspace",
				"plan_type":          "plus",
				"email":              "sub2api-codex@example.invalid",
			}, nil),
			assertValue: func(
				t *testing.T,
				credential accountapp.Credential,
				profile accountapp.PublicProfile,
			) {
				t.Helper()
				auth, valid := credential.(*codex.OAuthAuth)
				if !valid ||
					auth.AccessToken() != "synthetic-sub2api-codex-access" ||
					auth.RefreshToken() != "synthetic-sub2api-codex-refresh" ||
					auth.RefreshedAtMS() != 1_785_485_290_000 ||
					auth.AccountID() != "sub2api-codex-workspace" {
					t.Fatalf("Codex OAuth 解码结果错误: %T %v", credential, credential)
				}
				codexProfile, valid := profile.(codex.AccountProfile)
				if !valid ||
					codexProfile.Email() != "sub2api-codex@example.invalid" ||
					codexProfile.SubscriptionRaw() != "plus" {
					t.Fatalf("Codex 资料解码结果错误: %T %v", profile, profile)
				}
			},
		},
		{
			name: "codex api key",
			document: newSub2APIDocument(t, "openai", "apikey", map[string]any{
				"apiKey":  "test-codex-key",
				"baseUrl": "https://openai-compatible.example.invalid/v1/",
			}, nil),
			assertValue: func(
				t *testing.T,
				credential accountapp.Credential,
				profile accountapp.PublicProfile,
			) {
				t.Helper()
				auth, valid := credential.(*codex.APIKeyAuth)
				if !valid ||
					auth.APIKey() != "test-codex-key" ||
					auth.BaseURL() != "https://openai-compatible.example.invalid/v1" ||
					profile != nil {
					t.Fatalf("Codex API Key 解码结果错误: credential=%T profile=%T", credential, profile)
				}
			},
		},
		{
			name: "claude oauth",
			document: newSub2APIDocument(t, "anthropic", "oauth", map[string]any{
				"access_token":  "synthetic-sub2api-claude-access",
				"refresh_token": "synthetic-sub2api-claude-refresh",
				"expires_at":    "4102444800",
				"scope":         "user:inference user:profile",
				"account_uuid":  "123e4567-e89b-12d3-a456-426614174301",
				"org_uuid":      "123e4567-e89b-12d3-a456-426614174302",
				"email_address": "sub2api-claude@example.invalid",
			}, map[string]any{
				"account_uuid":  "123E4567-E89B-12D3-A456-426614174301",
				"org_uuid":      "123e4567-e89b-12d3-a456-426614174302",
				"email_address": "SUB2API-CLAUDE@example.invalid",
			}),
			assertValue: func(
				t *testing.T,
				credential accountapp.Credential,
				profile accountapp.PublicProfile,
			) {
				t.Helper()
				assertClaudeRefreshable(
					t,
					credential,
					"123e4567-e89b-12d3-a456-426614174301",
					[]string{"user:inference", "user:profile"},
				)
				claudeProfile, valid := profile.(claude.AccountProfile)
				if !valid ||
					claudeProfile.Email() != "sub2api-claude@example.invalid" ||
					claudeProfile.OAuthProfile().OrganizationUUID() !=
						"123e4567-e89b-12d3-a456-426614174302" {
					t.Fatalf("Claude 资料解码结果错误: %T %v", profile, profile)
				}
			},
		},
		{
			name: "claude node mixed oauth aliases",
			document: newSub2APIDocument(t, "anthropic", "oauth", map[string]any{
				"access_token":          "synthetic-sub2api-node-access",
				"accessToken":           "",
				"refresh_token":         "synthetic-sub2api-node-refresh",
				"refreshToken":          "",
				"expires_at":            "4102444800000",
				"expiresAt":             int64(4_102_444_800_000),
				"expiry":                "2100-01-01T00:00:00Z",
				"last_refresh":          "2026-08-10T04:27:29.587Z",
				"lastRefresh":           "2026-08-10T04:27:29.587Z",
				"scope":                 "user:profile user:inference",
				"refreshTokenExpiresAt": int64(4_105_036_800_000),
				"clientId":              "claude-code-official-client",
				"scopes":                []string{"user:inference", "user:profile"},
				"account_uuid":          "123E4567-E89B-12D3-A456-426614174305",
				"email_address":         "NODE-STANDARD@example.invalid",
				"subscriptionType":      "max",
				"rateLimitTier":         "default_claude_max_20x",
				"account": map[string]any{
					"uuid":             "123e4567-e89b-12d3-a456-426614174305",
					"emailAddress":     "node-standard@example.invalid",
					"organizationUuid": "123e4567-e89b-12d3-a456-426614174306",
				},
			}, nil),
			assertValue: func(
				t *testing.T,
				credential accountapp.Credential,
				profile accountapp.PublicProfile,
			) {
				t.Helper()
				auth, valid := credential.(*claude.OAuthAuth)
				if !valid ||
					auth.RefreshTokenExpiresAtMS() != 4_105_036_800_000 ||
					auth.ClientID() != "claude-code-official-client" {
					t.Fatalf("Claude Node 标准凭据解码错误: %T %v", credential, credential)
				}
				claudeProfile, valid := profile.(claude.AccountProfile)
				if !valid ||
					claudeProfile.Email() != "node-standard@example.invalid" ||
					claudeProfile.OAuthProfile().OrganizationUUID() !=
						"123e4567-e89b-12d3-a456-426614174306" ||
					claudeProfile.SubscriptionRaw() != "max" ||
					claudeProfile.Subscription().RateLimitTier() != "default_claude_max_20x" {
					t.Fatalf("Claude Node 标准资料解码错误: %T %v", profile, profile)
				}
			},
		},
		{
			name: "claude refreshable setup token",
			document: newSub2APIDocument(t, "anthropic", "setup-token", map[string]any{
				"accessToken":           "synthetic-sub2api-setup-access",
				"refreshToken":          "synthetic-sub2api-setup-refresh",
				"expiresAt":             int64(4_102_444_800_000),
				"refreshTokenExpiresAt": int64(4_105_036_800_000),
				"clientId":              "claude-code-official-client",
				"scopes":                []string{"user:inference"},
				"accountUuid":           "123e4567-e89b-12d3-a456-426614174303",
			}, nil),
			assertValue: func(
				t *testing.T,
				credential accountapp.Credential,
				profile accountapp.PublicProfile,
			) {
				t.Helper()
				auth := assertClaudeRefreshable(
					t,
					credential,
					"123e4567-e89b-12d3-a456-426614174303",
					[]string{"user:inference"},
				)
				if auth.RefreshTokenExpiresAtMS() != 4_105_036_800_000 ||
					auth.ClientID() != "claude-code-official-client" {
					t.Fatalf("Claude setup-token 官方可选字段错误: %v", auth)
				}
				if profile != nil {
					t.Fatalf("无邮箱 setup-token 不应构造资料: %T", profile)
				}
			},
		},
		{
			name: "claude access only setup token",
			document: newSub2APIDocument(t, "anthropic", "setup-token", map[string]any{
				"access_token": "synthetic-sub2api-access-only",
				"base_url":     "https://api.anthropic.com/",
				"scope":        "user:inference",
			}, nil),
			assertValue: func(
				t *testing.T,
				credential accountapp.Credential,
				profile accountapp.PublicProfile,
			) {
				t.Helper()
				auth, valid := credential.(*claude.OAuthTokenAuth)
				if !valid ||
					auth.AccessToken() != "synthetic-sub2api-access-only" ||
					auth.BaseURL() != "https://api.anthropic.com" ||
					profile != nil {
					t.Fatalf("Claude access-only 解码结果错误: credential=%T profile=%T", credential, profile)
				}
			},
		},
		{
			name: "claude api key",
			document: newSub2APIDocument(t, "anthropic", "apikey", map[string]any{
				"api_key": "test-claude-key",
				"baseUrl": "https://anthropic-compatible.example.invalid/",
			}, nil),
			assertValue: func(
				t *testing.T,
				credential accountapp.Credential,
				profile accountapp.PublicProfile,
			) {
				t.Helper()
				auth, valid := credential.(*claude.APIKeyAuth)
				if !valid ||
					auth.APIKey() != "test-claude-key" ||
					auth.BaseURL() != "https://anthropic-compatible.example.invalid" ||
					profile != nil {
					t.Fatalf("Claude API Key 解码结果错误: credential=%T profile=%T", credential, profile)
				}
			},
		},
	}

	decoder := sub2api.NewDecoder()
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			credential, profile, err := decoder.DecodeAccount(test.document)
			if err != nil {
				t.Fatalf("DecodeAccount() error = %v", err)
			}
			test.assertValue(t, credential, profile)
		})
	}
}

// TestDecoderRejectsUnsupportedOrUnsafeDocuments 验证批量、代理、版本和错配身份均失败关闭。
func TestDecoderRejectsUnsupportedOrUnsafeDocuments(t *testing.T) {
	t.Parallel()

	const secret = "synthetic-secret-must-not-leak"
	validClaude := map[string]any{
		"access_token":  secret,
		"refresh_token": "synthetic-sub2api-invalid-refresh",
		"expires_at":    int64(4_102_444_800),
		"scope":         "user:inference user:profile",
		"account_uuid":  "123e4567-e89b-12d3-a456-426614174311",
	}
	tests := []struct {
		name     string
		document func(*testing.T) []byte
		target   error
	}{
		{
			name: "unsupported platform",
			document: func(t *testing.T) []byte {
				return newSub2APIDocument(
					t,
					"gemini",
					"oauth",
					map[string]any{"access_token": secret},
					nil,
				)
			},
			target: sub2api.ErrUnsupportedAccount,
		},
		{
			name: "credential and extra uuid conflict",
			document: func(t *testing.T) []byte {
				return newSub2APIDocument(t, "anthropic", "oauth", validClaude, map[string]any{
					"account_uuid": "123e4567-e89b-12d3-a456-426614174312",
				})
			},
			target: sub2api.ErrInvalidDocument,
		},
		{
			name: "oauth without profile scope",
			document: func(t *testing.T) []byte {
				return newSub2APIDocument(t, "anthropic", "oauth", map[string]any{
					"access_token":  secret,
					"refresh_token": "synthetic-sub2api-invalid-refresh",
					"expires_at":    int64(4_102_444_800),
					"scope":         "user:inference",
					"account_uuid":  "123e4567-e89b-12d3-a456-426614174313",
				}, nil)
			},
			target: sub2api.ErrInvalidDocument,
		},
		{
			name: "setup token with profile scope",
			document: func(t *testing.T) []byte {
				return newSub2APIDocument(t, "anthropic", "setup-token", validClaude, nil)
			},
			target: sub2api.ErrInvalidDocument,
		},
		{
			name: "batch accounts",
			document: func(t *testing.T) []byte {
				var document map[string]any
				decodeTestJSON(t, newSub2APIDocument(
					t,
					"openai",
					"apikey",
					map[string]any{"api_key": secret},
					nil,
				), &document)
				account := document["accounts"].([]any)[0]
				document["accounts"] = []any{account, account}
				return marshalTestJSON(t, document)
			},
			target: sub2api.ErrInvalidDocument,
		},
		{
			name: "proxy data",
			document: func(t *testing.T) []byte {
				var document map[string]any
				decodeTestJSON(t, newSub2APIDocument(
					t,
					"openai",
					"apikey",
					map[string]any{"api_key": secret},
					nil,
				), &document)
				document["proxies"] = []any{map[string]any{"proxy_key": "proxy"}}
				return marshalTestJSON(t, document)
			},
			target: sub2api.ErrInvalidDocument,
		},
		{
			name: "unsupported format version",
			document: func(t *testing.T) []byte {
				var document map[string]any
				decodeTestJSON(t, newSub2APIDocument(
					t,
					"openai",
					"apikey",
					map[string]any{"api_key": secret},
					nil,
				), &document)
				document["version"] = 2
				return marshalTestJSON(t, document)
			},
			target: sub2api.ErrInvalidDocument,
		},
		{
			name: "expires at overflow",
			document: func(t *testing.T) []byte {
				return newSub2APIDocument(t, "anthropic", "oauth", map[string]any{
					"access_token":  secret,
					"refresh_token": "synthetic-sub2api-invalid-refresh",
					"expires_at":    int64(math.MaxInt64),
					"scope":         "user:inference user:profile",
					"account_uuid":  "123e4567-e89b-12d3-a456-426614174314",
				}, nil)
			},
			target: sub2api.ErrInvalidDocument,
		},
		{
			name: "access only identity",
			document: func(t *testing.T) []byte {
				return newSub2APIDocument(t, "anthropic", "setup-token", map[string]any{
					"access_token": secret,
					"account_uuid": "123e4567-e89b-12d3-a456-426614174315",
				}, nil)
			},
			target: sub2api.ErrInvalidDocument,
		},
		{
			name: "credential alias conflict",
			document: func(t *testing.T) []byte {
				return newSub2APIDocument(t, "openai", "apikey", map[string]any{
					"api_key": "test-key-one",
					"apiKey":  "test-key-two",
				}, nil)
			},
			target: sub2api.ErrInvalidDocument,
		},
		{
			name: "claude expiry alias conflict",
			document: func(t *testing.T) []byte {
				return newSub2APIDocument(t, "anthropic", "oauth", map[string]any{
					"access_token":  "synthetic-claude-access",
					"refresh_token": "synthetic-claude-refresh",
					"expires_at":    int64(4_102_444_800_000),
					"expiry":        "2099-12-31T23:59:59Z",
					"account_uuid":  "123e4567-e89b-12d3-a456-426614174399",
				}, nil)
			},
			target: sub2api.ErrInvalidDocument,
		},
		{
			name: "claude last refresh alias conflict",
			document: func(t *testing.T) []byte {
				return newSub2APIDocument(t, "anthropic", "oauth", map[string]any{
					"access_token":  "synthetic-claude-access",
					"refresh_token": "synthetic-claude-refresh",
					"expires_at":    int64(4_102_444_800_000),
					"last_refresh":  "2026-08-10T04:27:29.587Z",
					"lastRefresh":   "2026-08-10T04:27:30.587Z",
					"account_uuid":  "123e4567-e89b-12d3-a456-426614174399",
				}, nil)
			},
			target: sub2api.ErrInvalidDocument,
		},
		{
			name: "claude invalid last refresh",
			document: func(t *testing.T) []byte {
				return newSub2APIDocument(t, "anthropic", "oauth", map[string]any{
					"access_token":  "synthetic-claude-access",
					"refresh_token": "synthetic-claude-refresh",
					"expires_at":    int64(4_102_444_800_000),
					"last_refresh":  "not-a-timestamp",
					"account_uuid":  "123e4567-e89b-12d3-a456-426614174399",
				}, nil)
			},
			target: sub2api.ErrInvalidDocument,
		},
		{
			name: "unknown credential field",
			document: func(t *testing.T) []byte {
				return newSub2APIDocument(t, "openai", "apikey", map[string]any{
					"api_key":         secret,
					"ai_home_private": true,
				}, nil)
			},
			target: sub2api.ErrInvalidDocument,
		},
		{
			name: "unknown extra field",
			document: func(t *testing.T) []byte {
				return newSub2APIDocument(t, "anthropic", "oauth", validClaude, map[string]any{
					"runtime": "must-not-import",
				})
			},
			target: sub2api.ErrInvalidDocument,
		},
	}

	decoder := sub2api.NewDecoder()
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			_, _, err := decoder.DecodeAccount(test.document(t))
			if !errors.Is(err, test.target) {
				t.Fatalf("DecodeAccount() error = %v, want %v", err, test.target)
			}
			if strings.Contains(err.Error(), secret) {
				t.Fatal("解码错误泄漏凭据")
			}
		})
	}
}

// assertClaudeRefreshable 校验 Claude 可刷新凭据的稳定身份、scope 和秒转毫秒结果。
func assertClaudeRefreshable(
	t *testing.T,
	credential accountapp.Credential,
	accountUUID string,
	scopes []string,
) *claude.OAuthAuth {
	t.Helper()

	auth, valid := credential.(*claude.OAuthAuth)
	if !valid ||
		auth.AccountUUID() != accountUUID ||
		auth.ExpiresAtMS() != 4_102_444_800_000 ||
		strings.Join(auth.Scopes(), " ") != strings.Join(scopes, " ") {
		t.Fatalf("Claude 可刷新凭据解码结果错误: %T %v", credential, credential)
	}
	return auth
}

// newSub2APIDocument 创建一个不含真实凭据的现行单账号迁移文档。
func newSub2APIDocument(
	t *testing.T,
	platform string,
	authType string,
	credentials map[string]any,
	extra map[string]any,
) []byte {
	t.Helper()

	account := map[string]any{
		"name":        "synthetic-sub2api-account",
		"platform":    platform,
		"type":        authType,
		"credentials": credentials,
		"concurrency": 0,
		"priority":    0,
	}
	if extra != nil {
		account["extra"] = extra
	}
	return marshalTestJSON(t, map[string]any{
		"type":        "sub2api-data",
		"version":     1,
		"exported_at": "2026-07-31T08:09:10Z",
		"proxies":     []any{},
		"accounts":    []any{account},
	})
}

// marshalTestJSON 编码测试合同并在失败时终止当前用例。
func marshalTestJSON(t *testing.T, value any) []byte {
	t.Helper()

	document, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	return document
}

// decodeTestJSON 解码测试辅助文档，便于只改动一个非法字段。
func decodeTestJSON(t *testing.T, document []byte, target any) {
	t.Helper()

	if err := json.Unmarshal(document, target); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
}
