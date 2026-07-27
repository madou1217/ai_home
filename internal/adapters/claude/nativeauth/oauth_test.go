package nativeauth

import (
	"errors"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/accounts/claude"
)

// TestDecodeOAuth 证明上层可以通过一个入口组合官方身份与 secure storage。
func TestDecodeOAuth(t *testing.T) {
	auth, err := DecodeOAuth(validSecureStorage(), validGlobalConfig())
	if err != nil {
		t.Fatalf("组合解析 Claude OAuth 失败: %v", err)
	}
	if auth.Kind() != claude.AuthKindOAuth {
		t.Fatalf("认证类型错误: %s", auth.Kind())
	}
	if auth.IdentitySeed() != "oauth:claude:uuid:123e4567-e89b-12d3-a456-426614174000" {
		t.Fatalf("稳定身份错误: %s", auth.IdentitySeed())
	}
	if auth.AccessToken() != "sk-ant-oat01-native-facade-access" {
		t.Fatal("Access Token 没有进入领域对象")
	}
	if auth.RefreshTokenExpiresAtMS() != 4_105_036_800_000 || auth.ClientID() != "claude-code-official-client" {
		t.Fatal("官方可选 OAuth 元数据没有进入领域对象")
	}
}

// TestDecodeOAuthMapsBoundaryErrors 验证 Facade 只暴露稳定边界错误。
func TestDecodeOAuthMapsBoundaryErrors(t *testing.T) {
	tests := []struct {
		name        string
		credentials []byte
		config      []byte
	}{
		{name: "身份无效", credentials: validSecureStorage(), config: []byte(`{}`)},
		{name: "凭据无效", credentials: []byte(`{}`), config: validGlobalConfig()},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := DecodeOAuth(test.credentials, test.config); err == nil {
				t.Fatal("无效原生 artifact 应失败")
			} else if !errors.Is(err, ErrInvalidNativeAuth) {
				t.Fatalf("错误类型不稳定: %v", err)
			}
		})
	}
}

// TestDecodeOAuthErrorNeverLeaksTokens 验证组合边界错误不包含原始 Token。
func TestDecodeOAuthErrorNeverLeaksTokens(t *testing.T) {
	secret := "sk-ant-oat01-native-facade-access"
	broken := []byte(strings.Replace(string(validSecureStorage()), `"expiresAt":4102444800000`, `"expiresAt":0`, 1))
	_, err := DecodeOAuth(broken, validGlobalConfig())
	if err == nil {
		t.Fatal("无效过期时间应失败")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatal("Facade 错误泄漏 Token")
	}
}

// validSecureStorage 返回官方 OAuth Token 容器测试数据。
func validSecureStorage() []byte {
	return []byte(`{"claudeAiOauth":{"accessToken":"sk-ant-oat01-native-facade-access","refreshToken":"sk-ant-ort01-native-facade-refresh","expiresAt":4102444800000,"refreshTokenExpiresAt":4105036800000,"clientId":"claude-code-official-client","scopes":["user:inference","user:profile"],"subscriptionType":"max","rateLimitTier":"default_claude_max_20x"}}`)
}

// validGlobalConfig 返回官方独立 oauthAccount 身份测试数据。
func validGlobalConfig() []byte {
	return []byte(`{"oauthAccount":{"accountUuid":"123e4567-e89b-12d3-a456-426614174000","emailAddress":"owner@example.com","organizationUuid":"223e4567-e89b-12d3-a456-426614174000"}}`)
}
