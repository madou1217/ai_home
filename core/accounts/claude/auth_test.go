package claude

import (
	"fmt"
	"strings"
	"testing"
)

const (
	testAccessToken  = "sk-ant-oat01-realistic-access-secret"
	testSetupToken   = "sk-ant-oat01-long-lived-inference-secret"
	testRefreshToken = "sk-ant-ort01-realistic-refresh-secret"
	testAPIKey       = "sk-ant-api03-realistic-api-secret"
	testAuthToken    = "relay-bearer-secret"
	testAccountUUID  = "123E4567-E89B-12D3-A456-426614174000"
	testOrgUUID      = "223e4567-e89b-12d3-a456-426614174000"
)

// TestNewOAuthAuth 验证 OAuth 值对象只接受完整凭据与独立账号身份上下文。
func TestNewOAuthAuth(t *testing.T) {
	auth, err := NewOAuthAuth(validOAuthInput())
	if err != nil {
		t.Fatalf("创建 Claude OAuth 失败: %v", err)
	}

	if auth.Kind() != AuthKindOAuth {
		t.Fatalf("认证类型错误: %s", auth.Kind())
	}
	if auth.IdentitySeed() != "oauth:claude:uuid:123e4567-e89b-12d3-a456-426614174000" {
		t.Fatalf("稳定身份错误: %s", auth.IdentitySeed())
	}
	if auth.AccountUUID() != strings.ToLower(testAccountUUID) {
		t.Fatalf("账号 UUID 未规范化: %s", auth.AccountUUID())
	}
	if auth.Email() != "owner@example.com" {
		t.Fatalf("邮箱未规范化: %s", auth.Email())
	}
	if auth.OrganizationUUID() != testOrgUUID {
		t.Fatalf("组织 UUID 错误: %s", auth.OrganizationUUID())
	}
	if auth.AccessToken() != testAccessToken || auth.RefreshToken() != testRefreshToken {
		t.Fatal("OAuth 访问器没有返回原始凭据")
	}
	if auth.ExpiresAtMS() != 4_102_444_800_000 {
		t.Fatalf("过期时间错误: %d", auth.ExpiresAtMS())
	}
	if auth.RefreshTokenExpiresAtMS() != 4_105_036_800_000 {
		t.Fatalf("Refresh Token 过期时间错误: %d", auth.RefreshTokenExpiresAtMS())
	}
	if auth.ClientID() != "claude-code-official-client" {
		t.Fatalf("OAuth Client ID 错误: %s", auth.ClientID())
	}
	if auth.SubscriptionType() != "max" || auth.RateLimitTier() != "default_claude_max_20x" {
		t.Fatalf("套餐元数据错误: %s / %s", auth.SubscriptionType(), auth.RateLimitTier())
	}
	if !auth.HasScope(InferenceScope) || !auth.HasScope("user:profile") {
		t.Fatalf("OAuth scopes 错误: %v", auth.Scopes())
	}
}

// TestNewOAuthTokenAuth 验证 setup-token 仍属于 OAuth，但使用凭据绑定身份而不是伪造账号 UUID。
func TestNewOAuthTokenAuth(t *testing.T) {
	auth, err := NewOAuthTokenAuth(OAuthTokenInput{
		AccessToken: testSetupToken,
		BaseURL:     "HTTPS://API.ANTHROPIC.COM:443/",
	})
	if err != nil {
		t.Fatalf("创建 Claude 长效 OAuth Token 失败: %v", err)
	}

	if auth.Kind() != AuthKindOAuth || auth.Mode() != OAuthModeAccessToken {
		t.Fatalf("认证分类错误: %s / %s", auth.Kind(), auth.Mode())
	}
	if auth.AccessToken() != testSetupToken || auth.BaseURL() != DefaultAPIBaseURL {
		t.Fatal("长效 OAuth Token 或 Base URL 错误")
	}
	if !auth.HasScope(InferenceScope) || len(auth.Scopes()) != 1 {
		t.Fatalf("setup-token 必须固定为 inference-only: %v", auth.Scopes())
	}
	if !strings.HasPrefix(auth.IdentitySeed(), "oauth:claude:token:https://api.anthropic.com:") {
		t.Fatalf("凭据绑定身份错误: %s", auth.IdentitySeed())
	}
	if auth.Summary().AccountUUID != "" {
		t.Fatal("没有 profile artifact 时不能伪造账号 UUID")
	}
}

// TestOAuthModesStayDistinct 验证可刷新登录 OAuth 与长效 access token 不会共享身份语义。
func TestOAuthModesStayDistinct(t *testing.T) {
	refreshable, err := NewOAuthAuth(validOAuthInput())
	if err != nil {
		t.Fatalf("创建可刷新 OAuth 失败: %v", err)
	}
	accessToken, err := NewOAuthTokenAuth(OAuthTokenInput{AccessToken: testSetupToken})
	if err != nil {
		t.Fatalf("创建长效 OAuth Token 失败: %v", err)
	}

	if refreshable.Mode() != OAuthModeRefreshable || accessToken.Mode() != OAuthModeAccessToken {
		t.Fatalf("OAuth 模式错误: %s / %s", refreshable.Mode(), accessToken.Mode())
	}
	if refreshable.IdentitySeed() == accessToken.IdentitySeed() {
		t.Fatal("两种 OAuth 形态不能共享身份")
	}
}

// TestOAuthScopesAreImmutable 验证构造输入和访问器都不能修改领域值内部切片。
func TestOAuthScopesAreImmutable(t *testing.T) {
	input := validOAuthInput()
	auth, err := NewOAuthAuth(input)
	if err != nil {
		t.Fatalf("创建 Claude OAuth 失败: %v", err)
	}

	input.Scopes[0] = "attacker:mutated"
	returned := auth.Scopes()
	returned[0] = "attacker:returned"
	if !auth.HasScope(InferenceScope) || auth.HasScope("attacker:mutated") || auth.HasScope("attacker:returned") {
		t.Fatalf("OAuth scopes 被外部修改: %v", auth.Scopes())
	}
}

// TestNewOAuthAuthRejectsInvalidInput 固定 OAuth 领域不变量，避免 Adapter 各自猜测。
func TestNewOAuthAuthRejectsInvalidInput(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*OAuthInput)
	}{
		{name: "缺少 Access Token", mutate: func(input *OAuthInput) { input.AccessToken = "" }},
		{name: "Access Token 含首尾空白", mutate: func(input *OAuthInput) { input.AccessToken = " token" }},
		{name: "Refresh Token 含控制字符", mutate: func(input *OAuthInput) { input.RefreshToken = "refresh\nvalue" }},
		{name: "过期时间为零", mutate: func(input *OAuthInput) { input.ExpiresAtMS = 0 }},
		{name: "过期时间越界", mutate: func(input *OAuthInput) { input.ExpiresAtMS = maxUnixMillis + 1 }},
		{name: "Refresh Token 过期时间为负数", mutate: func(input *OAuthInput) { input.RefreshTokenExpiresAtMS = -1 }},
		{name: "Refresh Token 过期时间越界", mutate: func(input *OAuthInput) { input.RefreshTokenExpiresAtMS = maxUnixMillis + 1 }},
		{name: "缺少 Scope", mutate: func(input *OAuthInput) { input.Scopes = nil }},
		{name: "缺少推理 Scope", mutate: func(input *OAuthInput) { input.Scopes = []string{"user:profile"} }},
		{name: "Scope 重复", mutate: func(input *OAuthInput) { input.Scopes = []string{InferenceScope, InferenceScope} }},
		{name: "Scope 含空白", mutate: func(input *OAuthInput) { input.Scopes = []string{" user:inference"} }},
		{name: "账号 UUID 无效", mutate: func(input *OAuthInput) { input.Identity.AccountUUID = "not-a-uuid" }},
		{name: "邮箱无效", mutate: func(input *OAuthInput) { input.Identity.Email = "not-an-email" }},
		{name: "组织 UUID 无效", mutate: func(input *OAuthInput) { input.Identity.OrganizationUUID = "org" }},
		{name: "套餐含控制字符", mutate: func(input *OAuthInput) { input.SubscriptionType = "max\nforged" }},
		{name: "额度层级过长", mutate: func(input *OAuthInput) { input.RateLimitTier = strings.Repeat("x", maxMetadataLength+1) }},
		{name: "Client ID 含控制字符", mutate: func(input *OAuthInput) { input.ClientID = "client\nforged" }},
		{name: "Client ID 过长", mutate: func(input *OAuthInput) { input.ClientID = strings.Repeat("x", maxMetadataLength+1) }},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := validOAuthInput()
			test.mutate(&input)
			if _, err := NewOAuthAuth(input); err == nil {
				t.Fatal("无效 OAuth 输入应被拒绝")
			}
		})
	}
}

// TestStaticCredentialKinds 验证 API Key 与 Auth Token 是两个互不混淆的领域类型。
func TestStaticCredentialKinds(t *testing.T) {
	apiKey, err := NewAPIKeyAuth(APIKeyInput{APIKey: testAPIKey})
	if err != nil {
		t.Fatalf("创建 API Key 认证失败: %v", err)
	}
	authToken, err := NewAuthTokenAuth(AuthTokenInput{
		AuthToken: testAuthToken,
		BaseURL:   "HTTPS://Relay.Example.COM:443/anthropic/",
	})
	if err != nil {
		t.Fatalf("创建 Auth Token 认证失败: %v", err)
	}

	if apiKey.Kind() != AuthKindAPIKey || apiKey.BaseURL() != DefaultAPIBaseURL {
		t.Fatalf("API Key 认证错误: %s / %s", apiKey.Kind(), apiKey.BaseURL())
	}
	if authToken.Kind() != AuthKindAuthToken || authToken.BaseURL() != "https://relay.example.com/anthropic" {
		t.Fatalf("Auth Token 认证错误: %s / %s", authToken.Kind(), authToken.BaseURL())
	}
	if apiKey.APIKey() != testAPIKey || authToken.AuthToken() != testAuthToken {
		t.Fatal("静态凭据访问器返回值错误")
	}
	if apiKey.IdentitySeed() == authToken.IdentitySeed() {
		t.Fatal("API Key 与 Auth Token 不能共享身份命名空间")
	}
	if !strings.HasPrefix(apiKey.IdentitySeed(), "api_key:claude:") {
		t.Fatalf("API Key 身份前缀错误: %s", apiKey.IdentitySeed())
	}
	if !strings.HasPrefix(authToken.IdentitySeed(), "auth_token:claude:") {
		t.Fatalf("Auth Token 身份前缀错误: %s", authToken.IdentitySeed())
	}
}

// TestStaticCredentialsRejectInvalidInput 验证静态凭据与上游地址的安全约束。
func TestStaticCredentialsRejectInvalidInput(t *testing.T) {
	tests := []struct {
		name  string
		build func() (Auth, error)
	}{
		{name: "API Key 为空", build: func() (Auth, error) { return NewAPIKeyAuth(APIKeyInput{}) }},
		{name: "Auth Token 含空白", build: func() (Auth, error) { return NewAuthTokenAuth(AuthTokenInput{AuthToken: " token"}) }},
		{name: "OAuth Token 含换行", build: func() (Auth, error) { return NewOAuthTokenAuth(OAuthTokenInput{AccessToken: "token\nforged"}) }},
		{name: "地址含用户信息", build: func() (Auth, error) {
			return NewAPIKeyAuth(APIKeyInput{APIKey: testAPIKey, BaseURL: "https://user@example.com"})
		}},
		{name: "地址含查询参数", build: func() (Auth, error) {
			return NewAPIKeyAuth(APIKeyInput{APIKey: testAPIKey, BaseURL: "https://example.com?v=1"})
		}},
		{name: "地址协议无效", build: func() (Auth, error) {
			return NewAuthTokenAuth(AuthTokenInput{AuthToken: testAuthToken, BaseURL: "file:///tmp/socket"})
		}},
		{name: "地址端口无效", build: func() (Auth, error) {
			return NewAuthTokenAuth(AuthTokenInput{AuthToken: testAuthToken, BaseURL: "https://example.com:0"})
		}},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := test.build(); err == nil {
				t.Fatal("无效静态凭据应被拒绝")
			}
		})
	}
}

// TestAuthFormattingNeverLeaksSecrets 覆盖常见和异常 fmt verb，防止日志意外展开私有字段。
func TestAuthFormattingNeverLeaksSecrets(t *testing.T) {
	oauth, err := NewOAuthAuth(validOAuthInput())
	if err != nil {
		t.Fatalf("创建 OAuth 失败: %v", err)
	}
	apiKey, err := NewAPIKeyAuth(APIKeyInput{APIKey: testAPIKey})
	if err != nil {
		t.Fatalf("创建 API Key 失败: %v", err)
	}
	authToken, err := NewAuthTokenAuth(AuthTokenInput{AuthToken: testAuthToken})
	if err != nil {
		t.Fatalf("创建 Auth Token 失败: %v", err)
	}
	oauthToken, err := NewOAuthTokenAuth(OAuthTokenInput{AccessToken: testSetupToken})
	if err != nil {
		t.Fatalf("创建长效 OAuth Token 失败: %v", err)
	}

	cases := []struct {
		name    string
		auth    Auth
		secrets []string
	}{
		{name: "OAuth", auth: oauth, secrets: []string{testAccessToken, testRefreshToken}},
		{name: "OAuth Token", auth: oauthToken, secrets: []string{testSetupToken}},
		{name: "API Key", auth: apiKey, secrets: []string{testAPIKey}},
		{name: "Auth Token", auth: authToken, secrets: []string{testAuthToken}},
	}
	formats := []string{"%v", "%+v", "%#v", "%s", "%q", "%x", "%d", "%p"}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			for _, format := range formats {
				formatted := fmt.Sprintf(format, test.auth)
				for _, secret := range test.secrets {
					if strings.Contains(formatted, secret) {
						t.Fatalf("格式 %s 泄漏凭据", format)
					}
				}
			}
		})
	}
}

// validOAuthInput 返回所有 OAuth 测试共享的最小合法输入。
func validOAuthInput() OAuthInput {
	return OAuthInput{
		AccessToken:             testAccessToken,
		RefreshToken:            testRefreshToken,
		ExpiresAtMS:             4_102_444_800_000,
		RefreshTokenExpiresAtMS: 4_105_036_800_000,
		ClientID:                "claude-code-official-client",
		Scopes:                  []string{InferenceScope, "user:profile"},
		Identity: OAuthIdentity{
			AccountUUID:      testAccountUUID,
			Email:            "Owner@Example.COM",
			OrganizationUUID: testOrgUUID,
		},
		SubscriptionType: "max",
		RateLimitTier:    "default_claude_max_20x",
	}
}
