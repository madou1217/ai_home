package transportpolicy_test

import (
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/adapters/claude/transportpolicy"
)

// TestRequiresNativeOAuthDistinguishesOfficialAndCustomTransports 验证
// 凭据类型和端点共同决定是否需要原生 Claude Runtime。
func TestRequiresNativeOAuthDistinguishesOfficialAndCustomTransports(
	t *testing.T,
) {
	t.Parallel()

	refreshable, err := claudeauth.NewOAuthAuth(claudeauth.OAuthInput{
		AccessToken:  "sk-ant-oat01-policy-refreshable",
		RefreshToken: "sk-ant-ort01-policy-refreshable",
		ExpiresAtMS:  4_102_444_800_000,
		Scopes:       []string{claudeauth.InferenceScope},
		Identity: claudeauth.OAuthIdentity{
			AccountUUID: "123e4567-e89b-12d3-a456-426614174000",
		},
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthAuth() error = %v", err)
	}
	officialToken, err := claudeauth.NewOAuthTokenAuth(
		claudeauth.OAuthTokenInput{
			AccessToken: "sk-ant-oat01-policy-official",
		},
	)
	if err != nil {
		t.Fatalf("claude.NewOAuthTokenAuth(official) error = %v", err)
	}
	customToken, err := claudeauth.NewOAuthTokenAuth(
		claudeauth.OAuthTokenInput{
			AccessToken: "sk-ant-oat01-policy-custom",
			BaseURL:     "https://relay.example/anthropic",
		},
	)
	if err != nil {
		t.Fatalf("claude.NewOAuthTokenAuth(custom) error = %v", err)
	}
	apiKey, err := claudeauth.NewAPIKeyAuth(claudeauth.APIKeyInput{
		APIKey: "sk-ant-api03-policy",
	})
	if err != nil {
		t.Fatalf("claude.NewAPIKeyAuth() error = %v", err)
	}

	tests := []struct {
		name       string
		credential accountapp.Credential
		expected   bool
	}{
		{name: "refreshable oauth", credential: refreshable, expected: true},
		{name: "official setup token", credential: officialToken, expected: true},
		{name: "custom oauth endpoint", credential: customToken, expected: false},
		{name: "api key", credential: apiKey, expected: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			if actual := transportpolicy.RequiresNativeOAuth(
				test.credential,
			); actual != test.expected {
				t.Fatalf(
					"RequiresNativeOAuth() = %t, want %t",
					actual,
					test.expected,
				)
			}
		})
	}
}
