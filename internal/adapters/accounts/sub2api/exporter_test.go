package sub2api_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sub2api"
)

var exportTime = time.Date(2026, time.July, 31, 8, 9, 10, 0, time.UTC)

// TestExporterEncodesCodexAndClaudeAccounts 验证每种受支持凭据都输出确定的单账号合同。
func TestExporterEncodesCodexAndClaudeAccounts(t *testing.T) {
	t.Parallel()

	catalog := newExportCatalog(t)
	codexOAuth := newCodexExportOAuth(t)
	codexProfile, err := codex.NewAccountProfile(codexOAuth.Profile())
	if err != nil {
		t.Fatalf("codex.NewAccountProfile() error = %v", err)
	}
	claudeOAuth, claudeProfile := newClaudeExportOAuth(t)
	tests := []struct {
		name       string
		credential accountapp.Credential
		profile    accountapp.PublicProfile
		expected   string
	}{
		{
			name:       "codex oauth",
			credential: codexOAuth,
			profile:    codexProfile,
			expected: `{
				"type":"sub2api-data",
				"version":1,
				"exported_at":"2026-07-31T08:09:10Z",
				"proxies":[],
				"accounts":[{
					"name":"codex-codex-export@example.invalid",
					"platform":"openai",
					"type":"oauth",
					"credentials":{
						"access_token":"synthetic-codex-export-access",
						"refresh_token":"synthetic-codex-export-refresh",
						"id_token":"` + codexOAuth.IDToken() + `",
						"last_refresh":"2026-07-31T08:08:10Z",
						"chatgpt_account_id":"codex-export-workspace",
						"plan_type":"team",
						"email":"codex-export@example.invalid"
					},
					"concurrency":0,
					"priority":0
				}]
			}`,
		},
		{
			name: "codex api key",
			credential: mustCodexExportAPIKey(
				t,
				"synthetic-codex-export-api-key",
				"https://openai-compatible.example.invalid/v1/",
			),
			expected: `{
				"type":"sub2api-data",
				"version":1,
				"exported_at":"2026-07-31T08:09:10Z",
				"proxies":[],
				"accounts":[{
					"name":"codex-https://openai-compatible.example.invalid/v1",
					"platform":"openai",
					"type":"apikey",
					"credentials":{
						"api_key":"synthetic-codex-export-api-key",
						"base_url":"https://openai-compatible.example.invalid/v1"
					},
					"concurrency":0,
					"priority":0
				}]
			}`,
		},
		{
			name:       "claude refreshable oauth",
			credential: claudeOAuth,
			profile:    claudeProfile,
			expected: `{
				"type":"sub2api-data",
				"version":1,
				"exported_at":"2026-07-31T08:09:10Z",
				"proxies":[],
				"accounts":[{
					"name":"claude-claude-export@example.invalid",
					"platform":"anthropic",
					"type":"oauth",
					"credentials":{
						"access_token":"synthetic-claude-export-access",
						"refresh_token":"synthetic-claude-export-refresh",
						"expires_at":4102444800,
						"refresh_token_expires_at":4105036800,
						"client_id":"claude-export-client",
						"scope":"user:inference user:profile",
						"account_uuid":"123e4567-e89b-12d3-a456-426614174777",
						"email_address":"claude-export@example.invalid",
						"subscription_type":"max",
						"rate_limit_tier":"default_claude_max_20x"
					},
					"extra":{
						"account_uuid":"123e4567-e89b-12d3-a456-426614174777",
						"email_address":"claude-export@example.invalid"
					},
					"concurrency":0,
					"priority":0
				}]
			}`,
		},
		{
			name: "claude api key",
			credential: mustClaudeExportAPIKey(
				t,
				"synthetic-claude-export-api-key",
				"https://anthropic-compatible.example.invalid/",
			),
			expected: `{
				"type":"sub2api-data",
				"version":1,
				"exported_at":"2026-07-31T08:09:10Z",
				"proxies":[],
				"accounts":[{
					"name":"claude-https://anthropic-compatible.example.invalid",
					"platform":"anthropic",
					"type":"apikey",
					"credentials":{
						"api_key":"synthetic-claude-export-api-key",
						"base_url":"https://anthropic-compatible.example.invalid"
					},
					"concurrency":0,
					"priority":0
				}]
			}`,
		},
		{
			name: "claude oauth access token",
			credential: mustClaudeExportOAuthToken(
				t,
				"synthetic-claude-export-oauth-token",
			),
			expected: `{
				"type":"sub2api-data",
				"version":1,
				"exported_at":"2026-07-31T08:09:10Z",
				"proxies":[],
				"accounts":[{
					"name":"claude-https://api.anthropic.com",
					"platform":"anthropic",
					"type":"setup-token",
					"credentials":{
						"access_token":"synthetic-claude-export-oauth-token",
						"base_url":"https://api.anthropic.com",
						"scope":"user:inference"
					},
					"concurrency":0,
					"priority":0
				}]
			}`,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			reader, accountRef := newSnapshotReader(
				t,
				catalog,
				test.credential,
				test.profile,
			)
			exporter, err := sub2api.NewExporter(
				reader,
				func() time.Time { return exportTime },
			)
			if err != nil {
				t.Fatalf("sub2api.NewExporter() error = %v", err)
			}
			document, err := exporter.ExportAccount(
				context.Background(),
				accountRef,
			)
			if err != nil {
				t.Fatalf("ExportAccount() error = %v", err)
			}
			assertJSONEqual(t, document, []byte(test.expected))
			assertStandardTransferFields(t, document)
		})
	}
}

// TestExporterRejectsUnsupportedClaudeAuthToken 验证 Bearer Auth Token 不会伪装成 API Key 或 OAuth。
func TestExporterRejectsUnsupportedClaudeAuthToken(t *testing.T) {
	t.Parallel()

	credential, err := claude.NewAuthTokenAuth(claude.AuthTokenInput{
		AuthToken: "synthetic-unsupported-claude-auth-token",
	})
	if err != nil {
		t.Fatalf("claude.NewAuthTokenAuth() error = %v", err)
	}
	reader, accountRef := newSnapshotReader(
		t,
		newExportCatalog(t),
		credential,
		nil,
	)
	exporter, err := sub2api.NewExporter(
		reader,
		func() time.Time { return exportTime },
	)
	if err != nil {
		t.Fatalf("sub2api.NewExporter() error = %v", err)
	}

	_, err = exporter.ExportAccount(context.Background(), accountRef)
	if !errors.Is(err, accountapp.ErrUnsupportedAccountExport) {
		t.Fatalf("ExportAccount() error = %v", err)
	}
}

// TestNewExporterRejectsMissingDependencies 验证编码边界不接受 nil 读取器或时钟。
func TestNewExporterRejectsMissingDependencies(t *testing.T) {
	t.Parallel()

	reader, _ := newSnapshotReader(
		t,
		newExportCatalog(t),
		mustCodexExportAPIKey(t, "synthetic-export-dependency-key", ""),
		nil,
	)
	tests := []struct {
		name   string
		reader sub2api.SnapshotReader
		clock  sub2api.Clock
	}{
		{name: "reader", clock: func() time.Time { return exportTime }},
		{name: "clock", reader: reader},
	}
	for _, test := range tests {
		_, err := sub2api.NewExporter(test.reader, test.clock)
		if !errors.Is(err, sub2api.ErrInvalidDependencies) {
			t.Fatalf("%s dependency error = %v", test.name, err)
		}
	}
}

// exportSource 为适配器测试提供一个账号的三个应用读取端口。
type exportSource struct {
	account    accountcore.Account
	credential accountapp.Credential
	profile    accountapp.ProfileSnapshot
	hasProfile bool
}

// GetByRef 返回测试账号基础快照。
func (source *exportSource) GetByRef(
	context.Context,
	accountcore.AccountRef,
) (accountcore.Account, error) {
	return source.account, nil
}

// GetCredentialBinding 返回测试账号与领域凭据的稳定绑定。
func (source *exportSource) GetCredentialBinding(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialBinding, error) {
	return accountapp.NewCredentialBinding(
		accountRef,
		source.credential.ProviderID(),
		source.credential,
	)
}

// GetProfile 返回测试公开资料或明确的资料不存在。
func (source *exportSource) GetProfile(
	context.Context,
	accountcore.AccountRef,
) (accountapp.ProfileSnapshot, error) {
	if !source.hasProfile {
		return accountapp.ProfileSnapshot{}, accountapp.ErrProfileNotFound
	}
	return source.profile, nil
}

// newSnapshotReader 创建真实应用读取器，避免适配器测试伪造内部快照。
func newSnapshotReader(
	t *testing.T,
	catalog *providers.Catalog,
	credential accountapp.Credential,
	profile accountapp.PublicProfile,
) (*accountapp.ExportReader, accountcore.AccountRef) {
	t.Helper()

	alias, err := accountcore.NewCLIAccountID(7)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(catalog, accountcore.NewAccountInput{
		Identity:     credential,
		CLIAccountID: alias,
		CreatedAt:    exportTime.Add(-time.Hour),
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	source := &exportSource{
		account:    account,
		credential: credential,
	}
	if profile != nil {
		source.profile, err = accountapp.NewProfileSnapshot(
			catalog,
			profile,
			exportTime.Add(-time.Minute),
		)
		if err != nil {
			t.Fatalf("NewProfileSnapshot() error = %v", err)
		}
		source.hasProfile = true
	}
	reader, err := accountapp.NewExportReader(source, source, source)
	if err != nil {
		t.Fatalf("NewExportReader() error = %v", err)
	}
	return reader, account.Ref()
}

// newCodexExportOAuth 创建只含合成值的 Codex OAuth 凭据。
func newCodexExportOAuth(t *testing.T) *codex.OAuthAuth {
	t.Helper()

	idToken := buildExportJWT(t, map[string]any{
		"sub":   "codex-export-user",
		"email": "codex-export@example.invalid",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "codex-export-workspace",
			"chatgpt_plan_type":  "team",
		},
	})
	auth, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken:       "synthetic-codex-export-access",
		RefreshToken:      "synthetic-codex-export-refresh",
		IDToken:           idToken,
		RefreshedAtMS:     exportTime.Add(-time.Minute).UnixMilli(),
		ExplicitAccountID: "codex-export-workspace",
	})
	if err != nil {
		t.Fatalf("codex.NewOAuthAuth() error = %v", err)
	}
	return auth
}

// newClaudeExportOAuth 创建带公开订阅资料的 Claude 可刷新 OAuth。
func newClaudeExportOAuth(
	t *testing.T,
) (*claude.OAuthAuth, claude.AccountProfile) {
	t.Helper()

	identity := claude.OAuthIdentity{
		AccountUUID: "123e4567-e89b-12d3-a456-426614174777",
	}
	auth, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:             "synthetic-claude-export-access",
		RefreshToken:            "synthetic-claude-export-refresh",
		ExpiresAtMS:             4_102_444_800_000,
		RefreshTokenExpiresAtMS: 4_105_036_800_000,
		ClientID:                "claude-export-client",
		Scopes:                  []string{claude.InferenceScope, "user:profile"},
		Identity:                identity,
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthAuth() error = %v", err)
	}
	oauthProfile, err := claude.NewOAuthProfile(claude.OAuthProfileInput{
		AccountUUID: identity.AccountUUID,
		Email:       "claude-export@example.invalid",
		DisplayName: "Claude Export",
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthProfile() error = %v", err)
	}
	subscription, err := claude.NewSubscription(
		"max",
		"default_claude_max_20x",
	)
	if err != nil {
		t.Fatalf("claude.NewSubscription() error = %v", err)
	}
	profile, err := claude.NewAccountProfile(oauthProfile, subscription)
	if err != nil {
		t.Fatalf("claude.NewAccountProfile() error = %v", err)
	}
	return auth, profile
}

// mustCodexExportAPIKey 创建 Codex 合成 API Key。
func mustCodexExportAPIKey(
	t *testing.T,
	secret string,
	baseURL string,
) *codex.APIKeyAuth {
	t.Helper()

	auth, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey:  secret,
		BaseURL: baseURL,
	})
	if err != nil {
		t.Fatalf("codex.NewAPIKeyAuth() error = %v", err)
	}
	return auth
}

// mustClaudeExportAPIKey 创建 Claude 合成 API Key。
func mustClaudeExportAPIKey(
	t *testing.T,
	secret string,
	baseURL string,
) *claude.APIKeyAuth {
	t.Helper()

	auth, err := claude.NewAPIKeyAuth(claude.APIKeyInput{
		APIKey:  secret,
		BaseURL: baseURL,
	})
	if err != nil {
		t.Fatalf("claude.NewAPIKeyAuth() error = %v", err)
	}
	return auth
}

// mustClaudeExportOAuthToken 创建 Claude 合成长效 OAuth Token。
func mustClaudeExportOAuthToken(
	t *testing.T,
	secret string,
) *claude.OAuthTokenAuth {
	t.Helper()

	auth, err := claude.NewOAuthTokenAuth(claude.OAuthTokenInput{
		AccessToken: secret,
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthTokenAuth() error = %v", err)
	}
	return auth
}

// buildExportJWT 创建领域测试使用的无签名 JWT。
func buildExportJWT(t *testing.T, claims map[string]any) string {
	t.Helper()

	header, err := json.Marshal(map[string]any{"alg": "none", "typ": "JWT"})
	if err != nil {
		t.Fatalf("json.Marshal(header) error = %v", err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("json.Marshal(claims) error = %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(payload) +
		".signature"
}

// newExportCatalog 创建内置 Provider 注册表。
func newExportCatalog(t *testing.T) *providers.Catalog {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	return catalog
}

// assertJSONEqual 忽略无意义空白比较完整 JSON 值。
func assertJSONEqual(t *testing.T, actual []byte, expected []byte) {
	t.Helper()

	var actualValue any
	if err := json.Unmarshal(actual, &actualValue); err != nil {
		t.Fatalf("actual json.Unmarshal() error = %v body=%s", err, actual)
	}
	var expectedValue any
	if err := json.Unmarshal(expected, &expectedValue); err != nil {
		t.Fatalf("expected json.Unmarshal() error = %v body=%s", err, expected)
	}
	actualJSON, _ := json.Marshal(actualValue)
	expectedJSON, _ := json.Marshal(expectedValue)
	if string(actualJSON) != string(expectedJSON) {
		t.Fatalf("ExportAccount() = %s\nwant = %s", actualJSON, expectedJSON)
	}
}

// assertStandardTransferFields 验证标准版本存在且文档没有本地身份或运行数据。
func assertStandardTransferFields(t *testing.T, document []byte) {
	t.Helper()

	var root map[string]any
	if err := json.Unmarshal(document, &root); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if root["version"] != float64(1) {
		t.Fatalf("导出缺少标准 version=1: %s", document)
	}
	for _, key := range []string{"account_ref", "cli_account_id", "models", "usage", "runtime", "cooldown"} {
		if containsExportKey(root, key) {
			t.Fatalf("导出包含禁止字段 %q: %s", key, document)
		}
	}
	if strings.Contains(string(document), `"format_version"`) {
		t.Fatalf("导出包含数据库格式版本: %s", document)
	}
}

// containsExportKey 递归检查 JSON 对象键，不误判字段值文本。
func containsExportKey(value any, target string) bool {
	switch current := value.(type) {
	case map[string]any:
		for key, child := range current {
			if key == target || containsExportKey(child, target) {
				return true
			}
		}
	case []any:
		for _, child := range current {
			if containsExportKey(child, target) {
				return true
			}
		}
	}
	return false
}
