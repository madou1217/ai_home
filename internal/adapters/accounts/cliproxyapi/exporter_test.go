package cliproxyapi_test

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
	"github.com/madou1217/ai_home/internal/adapters/accounts/cliproxyapi"
)

var contractTime = time.Date(2026, time.August, 1, 1, 2, 3, 0, time.UTC)

// TestExporterEncodesCurrentCLIProxyAPIAuthFiles 验证两个 Provider 的官方单文件字段。
func TestExporterEncodesCurrentCLIProxyAPIAuthFiles(t *testing.T) {
	t.Parallel()

	catalog := newContractCatalog(t)
	codexOAuth := newCodexOAuth(t)
	codexProfile, err := codex.NewAccountProfile(codexOAuth.Profile())
	if err != nil {
		t.Fatalf("codex.NewAccountProfile() error = %v", err)
	}
	claudeOAuth, claudeProfile := newClaudeOAuth(t)
	tests := []struct {
		name       string
		credential accountapp.Credential
		profile    accountapp.PublicProfile
		enabled    bool
		expected   string
	}{
		{
			name:       "Codex OAuth",
			credential: codexOAuth,
			profile:    codexProfile,
			enabled:    true,
			expected: `{
				"id_token":"` + codexOAuth.IDToken() + `",
				"access_token":"` + codexOAuth.AccessToken() + `",
				"refresh_token":"synthetic-cpa-codex-refresh",
				"account_id":"cpa-codex-workspace",
				"last_refresh":"2026-08-01T01:01:03Z",
				"email":"cpa-codex@example.invalid",
				"type":"codex",
				"expired":"2026-08-01T03:02:03Z",
				"disabled":false
			}`,
		},
		{
			name:       "Claude OAuth",
			credential: claudeOAuth,
			profile:    claudeProfile,
			enabled:    false,
			expected: `{
				"id_token":"",
				"access_token":"synthetic-cpa-claude-access",
				"refresh_token":"synthetic-cpa-claude-refresh",
				"last_refresh":"",
				"email":"cpa-claude@example.invalid",
				"type":"claude",
				"expired":"2026-08-02T01:02:03Z",
				"disabled":true
			}`,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			reader, accountRef := newContractReader(
				t,
				catalog,
				test.credential,
				test.profile,
				test.enabled,
			)
			exporter, err := cliproxyapi.NewExporter(reader)
			if err != nil {
				t.Fatalf("cliproxyapi.NewExporter() error = %v", err)
			}
			document, err := exporter.ExportAccount(context.Background(), accountRef)
			if err != nil {
				t.Fatalf("ExportAccount() error = %v", err)
			}
			assertJSONEqual(t, document, []byte(test.expected))
			assertNoPrivateFields(t, document)
		})
	}
}

// TestExporterRejectsCredentialsOutsideCPAAuthFiles 验证配置型或 access-only 凭据不会被伪装。
func TestExporterRejectsCredentialsOutsideCPAAuthFiles(t *testing.T) {
	t.Parallel()

	catalog := newContractCatalog(t)
	codexKey, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey: "synthetic-cpa-codex-key",
	})
	if err != nil {
		t.Fatalf("codex.NewAPIKeyAuth() error = %v", err)
	}
	claudeToken, err := claude.NewOAuthTokenAuth(claude.OAuthTokenInput{
		AccessToken: "synthetic-cpa-claude-token",
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthTokenAuth() error = %v", err)
	}
	for _, credential := range []accountapp.Credential{codexKey, claudeToken} {
		reader, accountRef := newContractReader(
			t,
			catalog,
			credential,
			nil,
			true,
		)
		exporter, err := cliproxyapi.NewExporter(reader)
		if err != nil {
			t.Fatalf("cliproxyapi.NewExporter() error = %v", err)
		}
		_, err = exporter.ExportAccount(context.Background(), accountRef)
		if !errors.Is(err, accountapp.ErrUnsupportedAccountExport) {
			t.Fatalf("ExportAccount(%T) error = %v", credential, err)
		}
	}
}

// TestNewExporterRejectsMissingReader 验证反腐边界不接受空依赖。
func TestNewExporterRejectsMissingReader(t *testing.T) {
	t.Parallel()

	_, err := cliproxyapi.NewExporter(nil)
	if !errors.Is(err, cliproxyapi.ErrInvalidDependencies) {
		t.Fatalf("NewExporter(nil) error = %v", err)
	}
}

// contractSource 为适配器测试提供一个账号的三个应用读取端口。
type contractSource struct {
	account    accountcore.Account
	credential accountapp.Credential
	profile    accountapp.ProfileSnapshot
	hasProfile bool
}

// GetByRef 返回测试账号基础快照。
func (source *contractSource) GetByRef(
	context.Context,
	accountcore.AccountRef,
) (accountcore.Account, error) {
	return source.account, nil
}

// GetCredentialBinding 返回测试账号与领域凭据的稳定绑定。
func (source *contractSource) GetCredentialBinding(
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
func (source *contractSource) GetProfile(
	context.Context,
	accountcore.AccountRef,
) (accountapp.ProfileSnapshot, error) {
	if !source.hasProfile {
		return accountapp.ProfileSnapshot{}, accountapp.ErrProfileNotFound
	}
	return source.profile, nil
}

// newContractReader 通过真实应用读取器构造可导出的账号快照。
func newContractReader(
	t *testing.T,
	catalog *providers.Catalog,
	credential accountapp.Credential,
	profile accountapp.PublicProfile,
	enabled bool,
) (*accountapp.ExportReader, accountcore.AccountRef) {
	t.Helper()

	alias, err := accountcore.NewCLIAccountID(11)
	if err != nil {
		t.Fatalf("accountcore.NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(catalog, accountcore.NewAccountInput{
		Identity:     credential,
		CLIAccountID: alias,
		CreatedAt:    contractTime.Add(-time.Hour),
	})
	if err != nil {
		t.Fatalf("accountcore.NewAccount() error = %v", err)
	}
	if !enabled {
		account, err = account.WithEnabled(false, contractTime.Add(-time.Minute))
		if err != nil {
			t.Fatalf("Account.WithEnabled() error = %v", err)
		}
	}
	source := &contractSource{account: account, credential: credential}
	if profile != nil {
		source.profile, err = accountapp.NewProfileSnapshot(
			catalog,
			profile,
			contractTime.Add(-time.Minute),
		)
		if err != nil {
			t.Fatalf("accountapp.NewProfileSnapshot() error = %v", err)
		}
		source.hasProfile = true
	}
	reader, err := accountapp.NewExportReader(source, source, source)
	if err != nil {
		t.Fatalf("accountapp.NewExportReader() error = %v", err)
	}
	return reader, account.Ref()
}

// newCodexOAuth 创建同时携带身份与 access 到期时间的合成 Codex OAuth。
func newCodexOAuth(t *testing.T) *codex.OAuthAuth {
	t.Helper()

	idToken := buildJWT(t, map[string]any{
		"sub":   "cpa-codex-user",
		"email": "cpa-codex@example.invalid",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "cpa-codex-workspace",
			"chatgpt_plan_type":  "plus",
		},
	})
	accessToken := buildJWT(t, map[string]any{
		"exp": contractTime.Add(2 * time.Hour).Unix(),
	})
	auth, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken:       accessToken,
		RefreshToken:      "synthetic-cpa-codex-refresh",
		IDToken:           idToken,
		RefreshedAtMS:     contractTime.Add(-time.Minute).UnixMilli(),
		ExplicitAccountID: "cpa-codex-workspace",
	})
	if err != nil {
		t.Fatalf("codex.NewOAuthAuth() error = %v", err)
	}
	return auth
}

// newClaudeOAuth 创建带公开邮箱的合成 Claude 可刷新 OAuth。
func newClaudeOAuth(t *testing.T) (*claude.OAuthAuth, claude.AccountProfile) {
	t.Helper()

	const accountUUID = "123e4567-e89b-12d3-a456-426614174999"
	auth, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:  "synthetic-cpa-claude-access",
		RefreshToken: "synthetic-cpa-claude-refresh",
		ExpiresAtMS:  contractTime.Add(24 * time.Hour).UnixMilli(),
		Scopes:       []string{claude.InferenceScope, "user:profile"},
		Identity: claude.OAuthIdentity{
			AccountUUID: accountUUID,
		},
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthAuth() error = %v", err)
	}
	oauthProfile, err := claude.NewOAuthProfile(claude.OAuthProfileInput{
		AccountUUID: accountUUID,
		Email:       "cpa-claude@example.invalid",
		DisplayName: "CPA Claude",
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthProfile() error = %v", err)
	}
	subscription, err := claude.NewSubscription("max", "default_claude_max_20x")
	if err != nil {
		t.Fatalf("claude.NewSubscription() error = %v", err)
	}
	profile, err := claude.NewAccountProfile(oauthProfile, subscription)
	if err != nil {
		t.Fatalf("claude.NewAccountProfile() error = %v", err)
	}
	return auth, profile
}

// buildJWT 创建领域测试使用的无签名 JWT。
func buildJWT(t *testing.T, claims map[string]any) string {
	t.Helper()

	header, err := json.Marshal(map[string]string{"alg": "none", "typ": "JWT"})
	if err != nil {
		t.Fatalf("json.Marshal(header) error = %v", err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("json.Marshal(claims) error = %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}

// newContractCatalog 创建内置 Provider 注册表。
func newContractCatalog(t *testing.T) *providers.Catalog {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	return catalog
}

// assertJSONEqual 忽略对象字段顺序比较完整 JSON 值。
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

// assertNoPrivateFields 验证 CPA 文件没有 AIH identity、数据库或 bundle 字段。
func assertNoPrivateFields(t *testing.T, document []byte) {
	t.Helper()

	for _, field := range []string{
		"account_ref",
		"cli_account_id",
		"format_version",
		"version",
		"accounts",
		"models",
		"usage",
		"runtime",
		"account_uuid",
		"scopes",
	} {
		if strings.Contains(string(document), `"`+field+`"`) {
			t.Fatalf("CLIProxyAPI 导出包含禁止字段 %q: %s", field, document)
		}
	}
}
