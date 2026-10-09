package environment

import (
	"testing"

	"github.com/madou1217/ai_home/core/accounts/claude"
)

// TestEncodeUsesSDKBaseURL 验证三种原生环境认证不会让 SDK 重复追加 /v1，
// 同时保留凭据原始端点和身份，避免启动投影触发账号重建。
func TestEncodeUsesSDKBaseURL(t *testing.T) {
	t.Parallel()

	credentials := []struct {
		name  string
		build func(string) (claude.Auth, error)
	}{
		{
			name: "api key",
			build: func(baseURL string) (claude.Auth, error) {
				return claude.NewAPIKeyAuth(claude.APIKeyInput{
					APIKey: testAPIKey, BaseURL: baseURL,
				})
			},
		},
		{
			name: "auth token",
			build: func(baseURL string) (claude.Auth, error) {
				return claude.NewAuthTokenAuth(claude.AuthTokenInput{
					AuthToken: testAuthToken, BaseURL: baseURL,
				})
			},
		},
		{
			name: "oauth token",
			build: func(baseURL string) (claude.Auth, error) {
				return claude.NewOAuthTokenAuth(claude.OAuthTokenInput{
					AccessToken: testOAuthToken, BaseURL: baseURL,
				})
			},
		},
	}
	endpoints := []struct {
		name    string
		baseURL string
		wantURL string
	}{
		{name: "official", baseURL: "https://api.anthropic.com/v1/", wantURL: ""},
		{name: "versioned relay", baseURL: "https://relay.example/v1", wantURL: "https://relay.example"},
		{name: "nested relay", baseURL: "https://relay.example/llm/api/v1///", wantURL: "https://relay.example/llm/api"},
		{name: "uppercase version", baseURL: "https://relay.example/llm/V1", wantURL: "https://relay.example/llm"},
		{name: "encoded prefix", baseURL: "https://relay.example/team%2Fone/v1", wantURL: "https://relay.example/team%2Fone"},
		{name: "unversioned relay", baseURL: "https://relay.example/anthropic/", wantURL: "https://relay.example/anthropic"},
		{name: "one segment", baseURL: "https://relay.example/v1/v1", wantURL: "https://relay.example/v1"},
		{name: "other version", baseURL: "https://relay.example/v10", wantURL: "https://relay.example/v10"},
		{name: "version hostname", baseURL: "https://v1", wantURL: "https://v1"},
	}
	for _, credential := range credentials {
		for _, endpoint := range endpoints {
			t.Run(credential.name+"/"+endpoint.name, func(t *testing.T) {
				t.Parallel()

				auth, err := credential.build(endpoint.baseURL)
				if err != nil {
					t.Fatalf("构造认证失败: %v", err)
				}
				summary, identity := auth.Summary(), auth.IdentitySeed()
				values, err := Encode(auth)
				if err != nil {
					t.Fatalf("编码认证失败: %v", err)
				}
				if got := values[baseURLName]; got != endpoint.wantURL {
					t.Fatalf("SDK Base URL = %q, want %q", got, endpoint.wantURL)
				}
				if auth.Summary() != summary || auth.IdentitySeed() != identity {
					t.Fatal("CLI 环境投影修改了账号凭据端点或身份")
				}
			})
		}
	}
}
