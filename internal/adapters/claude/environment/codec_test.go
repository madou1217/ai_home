package environment

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/accounts/claude"
)

const (
	testAPIKey     = "sk-ant-api03-environment-secret"
	testAuthToken  = "proxy-bearer-environment-secret"
	testOAuthToken = "sk-ant-oat01-long-lived-environment-secret"
)

// TestDecodeAPIKey 验证 ANTHROPIC_API_KEY 进入独立 API Key 领域类型。
func TestDecodeAPIKey(t *testing.T) {
	auth, err := Decode(map[string]string{
		"ANTHROPIC_API_KEY":  testAPIKey,
		"ANTHROPIC_BASE_URL": "HTTPS://API.ANTHROPIC.COM:443/",
		"UNRELATED_ENV":      "ignored",
	})
	if err != nil {
		t.Fatalf("解析 API Key 环境失败: %v", err)
	}
	apiKey, ok := auth.(*claude.APIKeyAuth)
	if !ok {
		t.Fatalf("返回类型错误: %T", auth)
	}
	if apiKey.APIKey() != testAPIKey || apiKey.BaseURL() != claude.DefaultAPIBaseURL {
		t.Fatal("API Key 或 Base URL 解析错误")
	}
}

// TestDecodeAuthToken 验证 ANTHROPIC_AUTH_TOKEN 进入独立 Bearer 领域类型。
func TestDecodeAuthToken(t *testing.T) {
	auth, err := Decode(map[string]string{
		"ANTHROPIC_AUTH_TOKEN": testAuthToken,
		"ANTHROPIC_BASE_URL":   "https://relay.example.com/anthropic/",
	})
	if err != nil {
		t.Fatalf("解析 Auth Token 环境失败: %v", err)
	}
	token, ok := auth.(*claude.AuthTokenAuth)
	if !ok {
		t.Fatalf("返回类型错误: %T", auth)
	}
	if token.AuthToken() != testAuthToken || token.BaseURL() != "https://relay.example.com/anthropic" {
		t.Fatal("Auth Token 或 Base URL 解析错误")
	}
}

// TestDecodeOAuthToken 验证 CLAUDE_CODE_OAUTH_TOKEN 保持 OAuth 语义且不冒充 ANTHROPIC_AUTH_TOKEN。
func TestDecodeOAuthToken(t *testing.T) {
	auth, err := Decode(map[string]string{
		"CLAUDE_CODE_OAUTH_TOKEN": testOAuthToken,
		"ANTHROPIC_BASE_URL":      "https://api.anthropic.com/",
	})
	if err != nil {
		t.Fatalf("解析长效 OAuth Token 环境失败: %v", err)
	}
	token, ok := auth.(*claude.OAuthTokenAuth)
	if !ok {
		t.Fatalf("返回类型错误: %T", auth)
	}
	if token.Kind() != claude.AuthKindOAuth || token.Mode() != claude.OAuthModeAccessToken {
		t.Fatalf("OAuth Token 分类错误: %s / %s", token.Kind(), token.Mode())
	}
	if token.AccessToken() != testOAuthToken || token.BaseURL() != claude.DefaultAPIBaseURL {
		t.Fatal("OAuth Token 或 Base URL 解析错误")
	}
}

// TestDecodeIgnoresAIHModeHint 验证原生 Adapter 只相信 Provider 环境变量，不依赖 AIH 私有提示。
func TestDecodeIgnoresAIHModeHint(t *testing.T) {
	auth, err := Decode(map[string]string{
		"AIH_CLAUDE_CREDENTIAL_TYPE": "auth-token",
		"ANTHROPIC_API_KEY":          testAPIKey,
	})
	if err != nil {
		t.Fatalf("AIH 私有字段不应影响原生解析: %v", err)
	}
	if auth.Kind() != claude.AuthKindAPIKey {
		t.Fatalf("实际 Provider 字段应决定类型: %s", auth.Kind())
	}
}

// TestDecodeRejectsAmbiguousOrInvalidEnvironment 验证纯账号不能同时拥有两个请求头身份。
func TestDecodeRejectsAmbiguousOrInvalidEnvironment(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
	}{
		{name: "没有凭据", env: map[string]string{}},
		{name: "两个凭据同时存在", env: map[string]string{"ANTHROPIC_API_KEY": testAPIKey, "ANTHROPIC_AUTH_TOKEN": testAuthToken}},
		{name: "OAuth Token 与 API Key 同时存在", env: map[string]string{"CLAUDE_CODE_OAUTH_TOKEN": testOAuthToken, "ANTHROPIC_API_KEY": testAPIKey}},
		{name: "OAuth Token 与 Auth Token 同时存在", env: map[string]string{"CLAUDE_CODE_OAUTH_TOKEN": testOAuthToken, "ANTHROPIC_AUTH_TOKEN": testAuthToken}},
		{name: "API Key 只有空白", env: map[string]string{"ANTHROPIC_API_KEY": "  "}},
		{name: "Auth Token 含换行", env: map[string]string{"ANTHROPIC_AUTH_TOKEN": "token\nforged"}},
		{name: "OAuth Token 只有空白", env: map[string]string{"CLAUDE_CODE_OAUTH_TOKEN": "  "}},
		{name: "Base URL 无效", env: map[string]string{"ANTHROPIC_API_KEY": testAPIKey, "ANTHROPIC_BASE_URL": "file:///tmp/socket"}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := Decode(test.env); err == nil {
				t.Fatal("无效 Claude 环境应被拒绝")
			} else if !errors.Is(err, ErrInvalidEnvironment) {
				t.Fatalf("错误类型不稳定: %v", err)
			}
		})
	}
}

// TestEncodeWritesOnlySelectedCredential 验证编码不会生成 OAuth 或另一种静态凭据。
func TestEncodeWritesOnlySelectedCredential(t *testing.T) {
	apiKey, err := claude.NewAPIKeyAuth(claude.APIKeyInput{APIKey: testAPIKey})
	if err != nil {
		t.Fatalf("创建 API Key 失败: %v", err)
	}
	apiEnv, err := Encode(apiKey)
	if err != nil {
		t.Fatalf("编码 API Key 失败: %v", err)
	}
	if len(apiEnv) != 1 || apiEnv["ANTHROPIC_API_KEY"] != testAPIKey {
		t.Fatalf("API Key 环境不精确: %v", safeKeys(apiEnv))
	}

	authToken, err := claude.NewAuthTokenAuth(claude.AuthTokenInput{
		AuthToken: testAuthToken,
		BaseURL:   "https://relay.example.com/v1",
	})
	if err != nil {
		t.Fatalf("创建 Auth Token 失败: %v", err)
	}
	tokenEnv, err := Encode(authToken)
	if err != nil {
		t.Fatalf("编码 Auth Token 失败: %v", err)
	}
	if len(tokenEnv) != 2 || tokenEnv["ANTHROPIC_AUTH_TOKEN"] != testAuthToken || tokenEnv["ANTHROPIC_BASE_URL"] != "https://relay.example.com/v1" {
		t.Fatalf("Auth Token 环境不精确: %v", safeKeys(tokenEnv))
	}

	oauthToken, err := claude.NewOAuthTokenAuth(claude.OAuthTokenInput{AccessToken: testOAuthToken})
	if err != nil {
		t.Fatalf("创建长效 OAuth Token 失败: %v", err)
	}
	oauthEnv, err := Encode(oauthToken)
	if err != nil {
		t.Fatalf("编码长效 OAuth Token 失败: %v", err)
	}
	if len(oauthEnv) != 1 || oauthEnv["CLAUDE_CODE_OAUTH_TOKEN"] != testOAuthToken {
		t.Fatalf("OAuth Token 环境不精确: %v", safeKeys(oauthEnv))
	}
}

// TestEncodeRejectsRefreshableOAuth 验证可刷新 OAuth 只能走 secure storage Adapter。
func TestEncodeRejectsRefreshableOAuth(t *testing.T) {
	oauth, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:  "sk-ant-oat01-access",
		RefreshToken: "sk-ant-ort01-refresh",
		ExpiresAtMS:  4_102_444_800_000,
		Scopes:       []string{claude.InferenceScope},
		Identity: claude.OAuthIdentity{
			AccountUUID: "123e4567-e89b-12d3-a456-426614174000",
		},
	})
	if err != nil {
		t.Fatalf("创建 OAuth 失败: %v", err)
	}
	if _, err := Encode(oauth); err == nil {
		t.Fatal("环境 Adapter 不应编码 OAuth")
	}
}

// TestErrorsNeverLeakStaticCredentials 验证环境解析错误不回显用户输入。
func TestErrorsNeverLeakStaticCredentials(t *testing.T) {
	_, err := Decode(map[string]string{
		"ANTHROPIC_API_KEY":       testAPIKey,
		"ANTHROPIC_AUTH_TOKEN":    testAuthToken,
		"CLAUDE_CODE_OAUTH_TOKEN": testOAuthToken,
	})
	if err == nil {
		t.Fatal("双凭据环境应失败")
	}
	for _, secret := range []string{testAPIKey, testAuthToken, testOAuthToken} {
		if strings.Contains(err.Error(), secret) || strings.Contains(fmt.Sprintf("%+v", err), secret) {
			t.Fatal("环境错误泄漏静态凭据")
		}
	}
}

// safeKeys 只返回字段名，避免测试失败时把真实值输出到日志。
func safeKeys(values map[string]string) []string {
	out := make([]string, 0, len(values))
	for key := range values {
		out = append(out, key)
	}
	return out
}
