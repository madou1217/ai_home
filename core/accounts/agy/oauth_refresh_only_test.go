package agy

import "testing"

// Node 历史数据里存在只有 refresh_token 的 agy 凭据；原生导入必须接受，
// 使用前由 credential resolver 强制刷新。显式 OAuth 交换仍然要求 access token。
func TestNewNativeOAuthAuthAllowsRefreshOnly(t *testing.T) {
	auth, err := NewNativeOAuthAuth(OAuthInput{
		Email:         "refresh-only@example.test",
		AccessToken:   "",
		RefreshToken:  "refresh-token",
		ExpiresAtMS:   0,
		RefreshedAtMS: 123,
		TokenType:     "Bearer",
		AuthMethod:    AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("NewNativeOAuthAuth() error = %v", err)
	}
	if auth.AccessToken() != "" {
		t.Fatalf("AccessToken() = %q, want empty", auth.AccessToken())
	}
	if auth.RefreshToken() != "refresh-token" {
		t.Fatalf("RefreshToken() = %q", auth.RefreshToken())
	}
}

func TestNewOAuthAuthRejectsRefreshOnly(t *testing.T) {
	if _, err := NewOAuthAuth(OAuthInput{
		Email:         "refresh-only@example.test",
		RefreshToken:  "refresh-token",
		ExpiresAtMS:   0,
		RefreshedAtMS: 123,
		TokenType:     "Bearer",
		AuthMethod:    AuthMethodConsumer,
	}); err == nil {
		t.Fatal("NewOAuthAuth() accepted refresh-only credential")
	}
}
