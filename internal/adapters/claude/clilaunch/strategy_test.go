package clilaunch_test

import (
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/adapters/claude/clilaunch"
)

const (
	claudeAPIKeySecret      = "claude-api-key-secret-must-not-leak"
	claudeAuthTokenSecret   = "claude-auth-token-secret-must-not-leak"
	claudeSetupTokenSecret  = "claude-setup-token-secret-must-not-leak"
	claudeAccessTokenSecret = "claude-access-token-secret-must-not-leak"
	claudeRefreshSecret     = "claude-refresh-token-secret-must-not-leak"
)

// TestStrategyBuildsAllClaudeCredentialModes 验证四种领域凭据映射到唯一原生环境来源。
func TestStrategyBuildsAllClaudeCredentialModes(t *testing.T) {
	apiKey, err := claude.NewAPIKeyAuth(claude.APIKeyInput{
		APIKey:  claudeAPIKeySecret,
		BaseURL: "https://api.example.test/anthropic",
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	authToken, err := claude.NewAuthTokenAuth(claude.AuthTokenInput{
		AuthToken: claudeAuthTokenSecret,
	})
	if err != nil {
		t.Fatalf("NewAuthTokenAuth() error = %v", err)
	}
	setupToken, err := claude.NewOAuthTokenAuth(claude.OAuthTokenInput{
		AccessToken: claudeSetupTokenSecret,
	})
	if err != nil {
		t.Fatalf("NewOAuthTokenAuth() error = %v", err)
	}
	refreshable := mustRefreshableOAuth(t)

	tests := []struct {
		name       string
		credential accountapp.Credential
		wantSet    map[string]string
		wantKind   string
		wantMode   string
	}{
		{
			name:       "API Key",
			credential: apiKey,
			wantSet: map[string]string{
				"ANTHROPIC_API_KEY":  claudeAPIKeySecret,
				"ANTHROPIC_BASE_URL": "https://api.example.test/anthropic",
			},
			wantKind: "api_key",
		},
		{
			name:       "Auth Token",
			credential: authToken,
			wantSet:    map[string]string{"ANTHROPIC_AUTH_TOKEN": claudeAuthTokenSecret},
			wantKind:   "auth_token",
		},
		{
			name:       "setup-token OAuth",
			credential: setupToken,
			wantSet:    map[string]string{"CLAUDE_CODE_OAUTH_TOKEN": claudeSetupTokenSecret},
			wantKind:   "oauth",
			wantMode:   "access_token",
		},
		{
			name:       "refreshable OAuth",
			credential: refreshable,
			wantSet:    map[string]string{"CLAUDE_CODE_OAUTH_TOKEN": claudeAccessTokenSecret},
			wantKind:   "oauth",
			wantMode:   "refreshable",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			result, err := clilaunch.NewStrategy().Build(mustBinding(t, test.credential))
			if err != nil {
				t.Fatalf("Build() error = %v", err)
			}
			if !result.IsValid() || result.ProviderID() != claude.ProviderID ||
				result.Binary() != "claude" || len(result.Arguments()) != 0 {
				t.Fatalf("StrategyResult 错误: provider=%s binary=%s", result.ProviderID(), result.Binary())
			}
			if _, exists := result.Projection(); exists {
				t.Fatal("Claude 正常启动不应拆分 CLAUDE_CONFIG_DIR")
			}
			environment := result.Environment()
			if !mapsEqual(environment.RevealSet(), test.wantSet) {
				t.Fatalf("环境设置错误: got=%v want=%v", environment.SetNames(), sortedMapKeys(test.wantSet))
			}
			if slices.Contains(environment.SetNames(), "CLAUDE_CONFIG_DIR") ||
				slices.Contains(environment.UnsetNames(), "CLAUDE_CONFIG_DIR") {
				t.Fatal("策略不得修改共享 CLAUDE_CONFIG_DIR")
			}
			for name := range test.wantSet {
				if slices.Contains(environment.UnsetNames(), name) {
					t.Fatalf("环境变量同时 set/unset: %s", name)
				}
			}
			credential := result.Credential()
			if credential.Kind() != test.wantKind || credential.Mode() != test.wantMode {
				t.Fatalf("凭据摘要错误: %v", credential)
			}
			assertNoSecrets(t, result, environment)
		})
	}
}

// TestRefreshableOAuthDoesNotProjectSecureStorage 验证刷新凭据不会以账号级配置根破坏会话可见性。
func TestRefreshableOAuthDoesNotProjectSecureStorage(t *testing.T) {
	auth := mustRefreshableOAuth(t)
	result, err := clilaunch.NewStrategy().Build(mustBinding(t, auth))
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	values := result.Environment().RevealSet()
	if values["CLAUDE_CODE_OAUTH_TOKEN"] != auth.AccessToken() {
		t.Fatal("refreshable OAuth 没有注入当前 Access Token")
	}
	if strings.Contains(fmt.Sprint(values), claudeRefreshSecret) {
		t.Fatal("Refresh Token 不得进入子进程环境")
	}
	if _, exists := result.Projection(); exists {
		t.Fatal("refreshable OAuth 不得创建 .credentials.json 投影")
	}
}

// TestStrategyRejectsInvalidAndForeignBindings 验证空绑定和非封闭 Claude 凭据失败关闭。
func TestStrategyRejectsInvalidAndForeignBindings(t *testing.T) {
	strategy := clilaunch.NewStrategy()
	if _, err := strategy.Build(accountapp.CredentialBinding{}); !errors.Is(err, clilaunch.ErrInvalidBinding) {
		t.Fatalf("Build(empty) error = %v", err)
	}
	validBinding := mustBinding(t, mustRefreshableOAuth(t))
	foreign := foreignCredential{}
	binding, err := accountapp.NewCredentialBinding(
		validBinding.AccountRef(),
		claude.ProviderID,
		foreign,
	)
	if err != nil {
		t.Fatalf("NewCredentialBinding() error = %v", err)
	}
	if _, err := strategy.Build(binding); !errors.Is(err, clilaunch.ErrUnsupportedCredential) {
		t.Fatalf("Build(foreign) error = %v", err)
	}
}

// mustRefreshableOAuth 创建包含完整刷新信息的 Claude OAuth 测试凭据。
func mustRefreshableOAuth(t *testing.T) *claude.OAuthAuth {
	t.Helper()
	auth, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:             claudeAccessTokenSecret,
		RefreshToken:            claudeRefreshSecret,
		ExpiresAtMS:             4_102_444_800_000,
		RefreshTokenExpiresAtMS: 4_105_036_800_000,
		ClientID:                "claude-code-client",
		Scopes:                  []string{claude.InferenceScope, "user:profile"},
		Identity: claude.OAuthIdentity{
			AccountUUID: "123e4567-e89b-12d3-a456-426614174000",
		},
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return auth
}

// mustBinding 根据领域身份派生稳定账号引用并创建 Claude 凭据绑定。
func mustBinding(t *testing.T, credential accountapp.Credential) accountapp.CredentialBinding {
	t.Helper()
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	binding, err := accountapp.NewCredentialBinding(accountRef, claude.ProviderID, credential)
	if err != nil {
		t.Fatalf("NewCredentialBinding() error = %v", err)
	}
	return binding
}

// mapsEqual 比较测试环境明文副本，不输出其值。
func mapsEqual(left map[string]string, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for name, value := range left {
		if right[name] != value {
			return false
		}
	}
	return true
}

// sortedMapKeys 返回环境名的确定性排序结果。
func sortedMapKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}

// assertNoSecrets 验证所有安全格式化路径均不包含 Claude 凭据。
func assertNoSecrets(t *testing.T, values ...any) {
	t.Helper()
	formatted := ""
	for _, value := range values {
		formatted += fmt.Sprintf("%v\n%+v\n%#v\n", value, value, value)
	}
	for _, secret := range []string{
		claudeAPIKeySecret,
		claudeAuthTokenSecret,
		claudeSetupTokenSecret,
		claudeAccessTokenSecret,
		claudeRefreshSecret,
	} {
		if strings.Contains(formatted, secret) {
			t.Fatalf("格式化结果泄漏 Claude 凭据 %q: %s", secret, formatted)
		}
	}
}

// foreignCredential 模拟 Provider 一致但不属于封闭 Claude 领域的非法凭据实现。
type foreignCredential struct{}

// ProviderID 返回伪造的 Claude Provider。
func (foreignCredential) ProviderID() string { return claude.ProviderID }

// IdentitySeed 返回测试使用的稳定伪造身份。
func (foreignCredential) IdentitySeed() string { return "foreign:claude:launch" }

// String 返回不含凭据的测试摘要。
func (foreignCredential) String() string { return "foreignCredential" }

// GoString 返回不含凭据的测试摘要。
func (foreignCredential) GoString() string { return "foreignCredential" }
