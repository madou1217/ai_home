package codex

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

const (
	testAccessSecret  = "access-secret-value-that-must-not-leak"
	testRefreshSecret = "refresh-secret-value-that-must-not-leak"
	testIDSecretMark  = "id-secret-value-that-must-not-leak"
)

func TestNewOAuthAuthParsesCanonicalIdentity(t *testing.T) {
	idToken := buildTestJWT(map[string]any{
		"sub":   "fallback-user",
		"email": "person@example.com",
		"exp":   9_999_999_999,
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_user_id":            "user-123",
			"chatgpt_account_id":         "workspace-456",
			"chatgpt_plan_type":          "team",
			"chatgpt_account_is_fedramp": true,
		},
	})
	accessToken := buildTestJWT(map[string]any{"exp": 2_000_000_000})

	auth, err := NewOAuthAuth(OAuthInput{
		AccessToken:       accessToken,
		RefreshToken:      testRefreshSecret,
		IDToken:           idToken,
		RefreshedAtMS:     1_700_000_000_000,
		ExplicitAccountID: "workspace-456",
	})
	if err != nil {
		t.Fatalf("构建 OAuth 认证失败: %v", err)
	}

	var sealed Auth = auth
	if got, want := sealed.Kind(), AuthKindOAuth; got != want {
		t.Fatalf("认证类型错误: got=%q want=%q", got, want)
	}
	if got, want := auth.IdentitySeed(), "oauth:codex:user-123:workspace-456"; got != want {
		t.Fatalf("身份种子错误: got=%q want=%q", got, want)
	}
	if got, want := auth.UserID(), "user-123"; got != want {
		t.Fatalf("用户 ID 错误: got=%q want=%q", got, want)
	}
	if got, want := auth.AccountID(), "workspace-456"; got != want {
		t.Fatalf("工作区 ID 错误: got=%q want=%q", got, want)
	}
	if got, want := auth.Email(), "person@example.com"; got != want {
		t.Fatalf("邮箱错误: got=%q want=%q", got, want)
	}
	if got, want := auth.PlanType(), "team"; got != want {
		t.Fatalf("套餐类型错误: got=%q want=%q", got, want)
	}
	if !auth.IsFedRAMP() {
		t.Fatal("应解析 is_fedramp=true")
	}
	if got, want := auth.AccessExpiresAtMS(), int64(2_000_000_000_000); got != want {
		t.Fatalf("Access Token 过期时间错误: got=%d want=%d", got, want)
	}
	if got, want := auth.RefreshedAtMS(), int64(1_700_000_000_000); got != want {
		t.Fatalf("刷新时间错误: got=%d want=%d", got, want)
	}
	if auth.AccessToken() != accessToken || auth.RefreshToken() != testRefreshSecret || auth.IDToken() != idToken {
		t.Fatal("只读凭证访问器没有返回原始凭证")
	}
}

func TestOAuthAuthUsesOnlyAccessTokenExpiry(t *testing.T) {
	// 已过期的 ID Token 仍提供身份资料；Access Token 只能贡献 exp，不能覆盖资料。
	auth, err := NewOAuthAuth(OAuthInput{
		AccessToken: buildTestJWT(map[string]any{
			"exp":   2_000_000_000,
			"email": "access@example.com",
			"https://api.openai.com/auth": map[string]any{
				"chatgpt_user_id":    "access-user",
				"chatgpt_account_id": "access-workspace",
				"chatgpt_plan_type":  "access-plan",
			},
		}),
		RefreshToken: testRefreshSecret,
		IDToken: buildTestJWT(map[string]any{
			"sub":   "id-user",
			"email": "id@example.com",
			"exp":   1,
			"https://api.openai.com/auth": map[string]any{
				"chatgpt_account_id": "id-workspace",
				"chatgpt_plan_type":  "id-plan",
			},
		}),
		RefreshedAtMS: 1,
	})
	if err != nil {
		t.Fatalf("过期 ID Token 不应破坏身份解析: %v", err)
	}
	if got, want := auth.AccessExpiresAtMS(), int64(2_000_000_000_000); got != want {
		t.Fatalf("错误使用了 ID Token 过期时间: got=%d want=%d", got, want)
	}
	if auth.UserID() != "id-user" || auth.AccountID() != "id-workspace" ||
		auth.Email() != "id@example.com" || auth.PlanType() != "id-plan" {
		t.Fatalf("Access Token 覆盖了 ID Token 资料: %+v", auth.Profile())
	}
}

func TestOAuthIdentitySeedSeparatesWorkspacesAndStabilizesPersonal(t *testing.T) {
	// 同一用户的不同 workspace 必须是不同账号，personal 重建后必须保持同一身份。
	build := func(accountID string) *OAuthAuth {
		t.Helper()
		authClaims := map[string]any{"chatgpt_user_id": "user-123"}
		if accountID != "" {
			authClaims["chatgpt_account_id"] = accountID
		}
		auth, err := NewOAuthAuth(OAuthInput{
			AccessToken:  testAccessSecret,
			RefreshToken: testRefreshSecret,
			IDToken: buildTestJWT(map[string]any{
				"https://api.openai.com/auth": authClaims,
			}),
			RefreshedAtMS: 1,
		})
		if err != nil {
			t.Fatalf("构建 OAuth 认证失败: %v", err)
		}
		return auth
	}

	workspaceA := build("workspace-a")
	workspaceB := build("workspace-b")
	if workspaceA.IdentitySeed() == workspaceB.IdentitySeed() {
		t.Fatal("同一用户的不同 workspace 不得共享身份种子")
	}
	personalA := build("")
	personalB := build("")
	if got, want := personalA.IdentitySeed(), personalB.IdentitySeed(); got != want {
		t.Fatalf("personal 身份不稳定: got=%q want=%q", got, want)
	}
}

func TestOAuthUserIDClaimPriority(t *testing.T) {
	// 身份选择严格遵循官方私有 claim，再回退标准 JWT sub。
	tests := []struct {
		name       string
		authClaims map[string]any
		subject    string
		expected   string
	}{
		{
			name: "优先 chatgpt_user_id",
			authClaims: map[string]any{
				"chatgpt_user_id": "chatgpt-user",
				"user_id":         "auth-user",
			},
			subject:  "subject-user",
			expected: "chatgpt-user",
		},
		{
			name:       "回退 auth user_id",
			authClaims: map[string]any{"user_id": "auth-user"},
			subject:    "subject-user",
			expected:   "auth-user",
		},
		{
			name:       "回退标准 sub",
			authClaims: map[string]any{},
			subject:    "subject-user",
			expected:   "subject-user",
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			auth, err := NewOAuthAuth(OAuthInput{
				AccessToken:  testAccessSecret,
				RefreshToken: testRefreshSecret,
				IDToken: buildTestJWT(map[string]any{
					"sub":                         testCase.subject,
					"https://api.openai.com/auth": testCase.authClaims,
				}),
				RefreshedAtMS: 1,
			})
			if err != nil {
				t.Fatalf("构建 OAuth 认证失败: %v", err)
			}
			if got := auth.UserID(); got != testCase.expected {
				t.Fatalf("用户 claim 优先级错误: got=%q want=%q", got, testCase.expected)
			}
		})
	}
}

func TestNewOAuthAuthFallsBackToSubjectAndPersonalWorkspace(t *testing.T) {
	auth, err := NewOAuthAuth(OAuthInput{
		AccessToken:  testAccessSecret,
		RefreshToken: testRefreshSecret,
		IDToken: buildTestJWT(map[string]any{
			"sub": "subject-user",
			"https://api.openai.com/profile": map[string]any{
				"email": "profile@example.com",
			},
		}),
		RefreshedAtMS: 1,
	})
	if err != nil {
		t.Fatalf("构建 personal OAuth 认证失败: %v", err)
	}
	if got, want := auth.UserID(), "subject-user"; got != want {
		t.Fatalf("sub 回退错误: got=%q want=%q", got, want)
	}
	if got, want := auth.AccountID(), PersonalAccountID; got != want {
		t.Fatalf("personal 工作区回退错误: got=%q want=%q", got, want)
	}
	if got, want := auth.IdentitySeed(), "oauth:codex:subject-user:personal"; got != want {
		t.Fatalf("personal 身份种子错误: got=%q want=%q", got, want)
	}
	if got, want := auth.Email(), "profile@example.com"; got != want {
		t.Fatalf("profile 邮箱回退错误: got=%q want=%q", got, want)
	}
	if auth.AccessExpiresAtMS() != 0 {
		t.Fatal("非 JWT Access Token 的过期时间应保持未知")
	}
}

func TestNewOAuthAuthRejectsExplicitWorkspaceMismatch(t *testing.T) {
	idToken := buildTestJWT(map[string]any{
		"sub": "subject-user",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "workspace-from-claim",
		},
	})
	_, err := NewOAuthAuth(OAuthInput{
		AccessToken:       testAccessSecret,
		RefreshToken:      testRefreshSecret,
		IDToken:           idToken,
		RefreshedAtMS:     1,
		ExplicitAccountID: "workspace-explicit",
	})
	if err == nil {
		t.Fatal("显式工作区与 claim 不一致时必须拒绝")
	}
	assertTextDoesNotContainSecrets(t, err.Error(), testAccessSecret, testRefreshSecret, idToken)
}

func TestNewOAuthAuthRejectsReservedPersonalAccountID(t *testing.T) {
	tests := []OAuthInput{
		{
			AccessToken:  testAccessSecret,
			RefreshToken: testRefreshSecret,
			IDToken: buildTestJWT(map[string]any{
				"sub": "subject-user",
				"https://api.openai.com/auth": map[string]any{
					"chatgpt_account_id": PersonalAccountID,
				},
			}),
			RefreshedAtMS: 1,
		},
		{
			AccessToken:       testAccessSecret,
			RefreshToken:      testRefreshSecret,
			IDToken:           buildTestJWT(map[string]any{"sub": "subject-user"}),
			RefreshedAtMS:     1,
			ExplicitAccountID: PersonalAccountID,
		},
	}

	for index, input := range tests {
		if _, err := NewOAuthAuth(input); err == nil {
			t.Fatalf("第 %d 个 personal 保留值输入应被拒绝", index)
		}
	}
}

func TestNewOAuthAuthValidatesRequiredFields(t *testing.T) {
	validIDToken := buildTestJWT(map[string]any{"sub": "subject-user"})
	tests := []struct {
		name  string
		input OAuthInput
	}{
		{name: "缺少 access token", input: OAuthInput{RefreshToken: testRefreshSecret, IDToken: validIDToken, RefreshedAtMS: 1}},
		{name: "缺少 refresh token", input: OAuthInput{AccessToken: testAccessSecret, IDToken: validIDToken, RefreshedAtMS: 1}},
		{name: "缺少 id token", input: OAuthInput{AccessToken: testAccessSecret, RefreshToken: testRefreshSecret, RefreshedAtMS: 1}},
		{name: "刷新时间为零", input: OAuthInput{AccessToken: testAccessSecret, RefreshToken: testRefreshSecret, IDToken: validIDToken}},
		{name: "ID Token 非法", input: OAuthInput{AccessToken: testAccessSecret, RefreshToken: testRefreshSecret, IDToken: "invalid-token", RefreshedAtMS: 1}},
		{name: "缺少稳定用户", input: OAuthInput{AccessToken: testAccessSecret, RefreshToken: testRefreshSecret, IDToken: buildTestJWT(map[string]any{"email": "person@example.com"}), RefreshedAtMS: 1}},
		{name: "access token 尾随换行", input: OAuthInput{AccessToken: testAccessSecret + "\r\n", RefreshToken: testRefreshSecret, IDToken: validIDToken, RefreshedAtMS: 1}},
		{name: "refresh token 前导空格", input: OAuthInput{AccessToken: testAccessSecret, RefreshToken: " " + testRefreshSecret, IDToken: validIDToken, RefreshedAtMS: 1}},
		{name: "id token 尾随空格", input: OAuthInput{AccessToken: testAccessSecret, RefreshToken: testRefreshSecret, IDToken: validIDToken + " ", RefreshedAtMS: 1}},
		{name: "刷新时间超出 RFC3339", input: OAuthInput{AccessToken: testAccessSecret, RefreshToken: testRefreshSecret, IDToken: validIDToken, RefreshedAtMS: maxRFC3339UnixMillis + 1}},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := NewOAuthAuth(testCase.input)
			if err == nil {
				t.Fatal("无效 OAuth 输入应返回错误")
			}
			assertTextDoesNotContainSecrets(t, err.Error(), testCase.input.AccessToken, testCase.input.RefreshToken, testCase.input.IDToken)
		})
	}
}

func TestNewOAuthAuthRejectsMalformedJWTStructureAndClaims(t *testing.T) {
	validPayload := []byte(`{"sub":"subject-user"}`)
	encodedPayload := base64.RawURLEncoding.EncodeToString(validPayload)
	tests := []struct {
		name    string
		idToken string
	}{
		{name: "空 header", idToken: "." + encodedPayload + ".signature"},
		{name: "空 signature", idToken: "header." + encodedPayload + "."},
		{name: "多余分段", idToken: "header." + encodedPayload + ".signature.extra"},
		{name: "尾随 JSON", idToken: buildTestJWTBytes([]byte(`{"sub":"subject-user"}{}`))},
		{name: "重复字段", idToken: buildTestJWTBytes([]byte(`{"sub":"first","sub":"second"}`))},
		{name: "字段大小写不匹配", idToken: buildTestJWTBytes([]byte(`{"SUB":"subject-user"}`))},
		{name: "用户字段类型错误", idToken: buildTestJWTBytes([]byte(`{"sub":123}`))},
		{name: "邮箱字段类型错误", idToken: buildTestJWTBytes([]byte(`{"sub":"subject-user","email":123}`))},
		{name: "auth 命名空间类型错误", idToken: buildTestJWTBytes([]byte(`{"sub":"subject-user","https://api.openai.com/auth":[]}`))},
		{name: "FedRAMP null", idToken: buildTestJWTBytes([]byte(`{"sub":"subject-user","https://api.openai.com/auth":{"chatgpt_account_is_fedramp":null}}`))},
		{name: "非法 UTF-8", idToken: buildTestJWTBytes([]byte{'{', '"', 's', 'u', 'b', '"', ':', '"', 0xff, '"', '}'})},
		{name: "未配对 surrogate", idToken: buildTestJWTBytes([]byte(`{"sub":"\ud800"}`))},
		{name: "邮箱未配对 surrogate", idToken: buildTestJWTBytes([]byte(`{"sub":"subject-user","email":"\ud800"}`))},
		{name: "字段名未配对 surrogate", idToken: buildTestJWTBytes([]byte(`{"sub":"subject-user","\ud800":true}`))},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := NewOAuthAuth(OAuthInput{
				AccessToken:   testAccessSecret,
				RefreshToken:  testRefreshSecret,
				IDToken:       testCase.idToken,
				RefreshedAtMS: 1,
			})
			if err == nil {
				t.Fatal("畸形 JWT 应被拒绝")
			}
			assertTextDoesNotContainSecrets(t, err.Error(), testAccessSecret, testRefreshSecret, testCase.idToken)
		})
	}
}

func TestReadAccessTokenExpiryMSUsesStrictJWTClaims(t *testing.T) {
	tests := []struct {
		name     string
		token    string
		expected int64
	}{
		{name: "有效整数", token: buildTestJWTBytes([]byte(`{"exp":2000000000,"aud":"codex"}`)), expected: 2_000_000_000_000},
		{name: "空 header", token: "." + base64.RawURLEncoding.EncodeToString([]byte(`{"exp":2000000000}`)) + ".signature"},
		{name: "空 signature", token: "header." + base64.RawURLEncoding.EncodeToString([]byte(`{"exp":2000000000}`)) + "."},
		{name: "尾随 JSON", token: buildTestJWTBytes([]byte(`{"exp":2000000000}{}`))},
		{name: "重复 exp", token: buildTestJWTBytes([]byte(`{"exp":2000000000,"exp":2000000001}`))},
		{name: "错误大小写", token: buildTestJWTBytes([]byte(`{"EXP":2000000000}`))},
		{name: "字符串 exp", token: buildTestJWTBytes([]byte(`{"exp":"2000000000"}`))},
		{name: "小数 exp", token: buildTestJWTBytes([]byte(`{"exp":2000000000.5}`))},
		{name: "null exp", token: buildTestJWTBytes([]byte(`{"exp":null}`))},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			if got := readAccessTokenExpiryMS(testCase.token); got != testCase.expected {
				t.Fatalf("过期时间错误: got=%d want=%d", got, testCase.expected)
			}
		})
	}
}

func TestOAuthAuthRedactsSecretsFromStringAndSummary(t *testing.T) {
	idToken := buildTestJWT(map[string]any{"sub": testIDSecretMark})
	auth, err := NewOAuthAuth(OAuthInput{
		AccessToken:   testAccessSecret,
		RefreshToken:  testRefreshSecret,
		IDToken:       idToken,
		RefreshedAtMS: 1,
	})
	if err != nil {
		t.Fatalf("构建 OAuth 认证失败: %v", err)
	}

	assertTextDoesNotContainSecrets(t, auth.String(), testAccessSecret, testRefreshSecret, idToken)
	assertFormattingDoesNotContainSecrets(t, auth, *auth, testAccessSecret, testRefreshSecret, idToken)
	assertTextDoesNotContainSecrets(t, auth.Summary().String(), testAccessSecret, testRefreshSecret, idToken)
}

func TestNewAPIKeyAuthNormalizesBaseURLAndBuildsIdentity(t *testing.T) {
	const apiKey = "sk-test-key-with-enough-entropy"
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{name: "默认地址", input: "", expected: DefaultAPIBaseURL},
		{name: "大小写和默认端口", input: "HTTPS://API.EXAMPLE.COM:443/v1/", expected: "https://api.example.com/v1"},
		{name: "HTTP 默认端口", input: "http://Example.COM:80/root///", expected: "http://example.com/root"},
		{name: "HTTPS 前导零默认端口", input: "https://Example.COM:0443/v1", expected: "https://example.com/v1"},
		{name: "HTTP 前导零默认端口", input: "http://Example.COM:00080/root", expected: "http://example.com/root"},
		{name: "非默认端口去除前导零", input: "https://Example.COM:08443/v1", expected: "https://example.com:8443/v1"},
		{name: "保留非默认端口", input: "https://Example.COM:8443/v1", expected: "https://example.com:8443/v1"},
	}

	keyHash := sha256.Sum256([]byte(apiKey))
	expectedHash := hex.EncodeToString(keyHash[:])
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			auth, err := NewAPIKeyAuth(APIKeyInput{APIKey: apiKey, BaseURL: testCase.input})
			if err != nil {
				t.Fatalf("构建 API Key 认证失败: %v", err)
			}
			var sealed Auth = auth
			if sealed.Kind() != AuthKindAPIKey {
				t.Fatalf("认证类型错误: %q", sealed.Kind())
			}
			if got := auth.BaseURL(); got != testCase.expected {
				t.Fatalf("Base URL 规范化错误: got=%q want=%q", got, testCase.expected)
			}
			if got := auth.Fingerprint(); got != expectedHash {
				t.Fatalf("密钥指纹错误: got=%q want=%q", got, expectedHash)
			}
			expectedSeed := fmt.Sprintf("api_key:codex:%s:%s", testCase.expected, expectedHash)
			if got := auth.IdentitySeed(); got != expectedSeed {
				t.Fatalf("身份种子错误: got=%q want=%q", got, expectedSeed)
			}
			if auth.APIKey() != apiKey {
				t.Fatal("只读 API Key 访问器没有返回原始密钥")
			}
		})
	}
}

func TestNewAPIKeyAuthAcceptsShortHeaderSafeKeys(t *testing.T) {
	// API Key 合同不设置长度门槛，短 key 也不能因 URL 的同名片段被误拒绝。
	tests := []struct {
		key     string
		baseURL string
	}{
		{key: "v1"},
		{key: "api", baseURL: "https://api.example.com/v1"},
		{key: "https", baseURL: "https://example.com/https"},
	}
	for _, testCase := range tests {
		t.Run(testCase.key, func(t *testing.T) {
			auth, err := NewAPIKeyAuth(APIKeyInput{APIKey: testCase.key, BaseURL: testCase.baseURL})
			if err != nil {
				t.Fatalf("合法短 API Key 被拒绝: %v", err)
			}
			if auth.APIKey() != testCase.key {
				t.Fatal("短 API Key 没有原样保存")
			}
		})
	}
}

func TestAPIKeyIdentityUsesCanonicalEndpoint(t *testing.T) {
	// 等价 endpoint 必须生成同一身份，不同 endpoint 必须保持隔离。
	canonical, err := NewAPIKeyAuth(APIKeyInput{
		APIKey:  testRefreshSecret,
		BaseURL: "https://example.com/v1",
	})
	if err != nil {
		t.Fatalf("构建规范 endpoint 失败: %v", err)
	}
	equivalent, err := NewAPIKeyAuth(APIKeyInput{
		APIKey:  testRefreshSecret,
		BaseURL: "HTTPS://EXAMPLE.COM:0443/v1/",
	})
	if err != nil {
		t.Fatalf("构建等价 endpoint 失败: %v", err)
	}
	if got, want := equivalent.IdentitySeed(), canonical.IdentitySeed(); got != want {
		t.Fatalf("等价 endpoint 身份不一致: got=%q want=%q", got, want)
	}
	different, err := NewAPIKeyAuth(APIKeyInput{
		APIKey:  testRefreshSecret,
		BaseURL: "https://other.example.com/v1",
	})
	if err != nil {
		t.Fatalf("构建不同 endpoint 失败: %v", err)
	}
	if different.IdentitySeed() == canonical.IdentitySeed() {
		t.Fatal("不同 endpoint 不得共享身份种子")
	}
}

func TestAPIKeyIdentitySeparatesDifferentKeysAtSameEndpoint(t *testing.T) {
	// AI Home 把同一 endpoint 下的不同 Key 视为独立账号，凭证变化必须产生新身份。
	first, err := NewAPIKeyAuth(APIKeyInput{
		APIKey:  "sk-first-account-key",
		BaseURL: "https://api.example.com/v1",
	})
	if err != nil {
		t.Fatalf("构建第一个 API Key 账号失败: %v", err)
	}
	second, err := NewAPIKeyAuth(APIKeyInput{
		APIKey:  "sk-second-account-key",
		BaseURL: "HTTPS://API.EXAMPLE.COM:443/v1/",
	})
	if err != nil {
		t.Fatalf("构建第二个 API Key 账号失败: %v", err)
	}
	if first.IdentitySeed() == second.IdentitySeed() {
		t.Fatal("同一 endpoint 下的不同 API Key 不得共享身份种子")
	}
}

func TestNewAPIKeyAuthRejectsUnsafeURLs(t *testing.T) {
	tests := []string{
		"ftp://api.example.com/v1",
		"https://user:password@api.example.com/v1",
		"https://api.example.com/v1?tenant=x",
		"https://api.example.com/v1?",
		"https://api.example.com/v1#fragment",
		"https://api.example.com/v1#",
		"https:///v1",
		"api.example.com/v1",
		"https://api.example.com:0/v1",
		"https://api.example.com:65536/v1",
		"https://api.example.com:/v1",
		"https://api.example.com:-1/v1",
		"https://api.example.com:not-a-port/v1",
		"http://[fe80::1%25en0]:8080/v1",
	}
	for _, rawURL := range tests {
		t.Run(rawURL, func(t *testing.T) {
			_, err := NewAPIKeyAuth(APIKeyInput{APIKey: testRefreshSecret, BaseURL: rawURL})
			if err == nil {
				t.Fatal("不安全 Base URL 应被拒绝")
			}
			assertTextDoesNotContainSecrets(t, err.Error(), testRefreshSecret)
		})
	}
}

func TestNewAPIKeyAuthRejectsInvalidSecrets(t *testing.T) {
	tests := []string{"", " " + testRefreshSecret, testRefreshSecret + "\r\n", "key\x00value"}
	for _, apiKey := range tests {
		_, err := NewAPIKeyAuth(APIKeyInput{APIKey: apiKey})
		if err == nil {
			t.Fatal("无效 API Key 应被拒绝")
		}
		assertTextDoesNotContainSecrets(t, err.Error(), apiKey)
	}
}

func TestAPIKeyAuthRedactsSecretFromStringAndSummary(t *testing.T) {
	const apiKey = "sk-never-print-this-secret"
	auth, err := NewAPIKeyAuth(APIKeyInput{APIKey: apiKey, BaseURL: "https://api.example.com/v1"})
	if err != nil {
		t.Fatalf("构建 API Key 认证失败: %v", err)
	}
	assertTextDoesNotContainSecrets(t, auth.String(), apiKey)
	assertFormattingDoesNotContainSecrets(t, auth, *auth, apiKey)
	assertTextDoesNotContainSecrets(t, auth.Summary().String(), apiKey)
	if strings.Contains(auth.IdentitySeed(), apiKey) {
		t.Fatal("身份种子泄漏了原始 API Key")
	}
}

func TestAuthKindStringRejectsUnknownValue(t *testing.T) {
	if got, want := AuthKindOAuth.String(), "oauth"; got != want {
		t.Fatalf("OAuth 类型文本错误: got=%q want=%q", got, want)
	}
	if got, want := AuthKindAPIKey.String(), "api_key"; got != want {
		t.Fatalf("API Key 类型文本错误: got=%q want=%q", got, want)
	}
	if got, want := AuthKind("unexpected").String(), "unknown"; got != want {
		t.Fatalf("未知类型不应原样输出: got=%q want=%q", got, want)
	}
}

func TestNilAuthStringersRemainSafe(t *testing.T) {
	// 无效的 typed nil 也不能因日志格式化触发 panic 或输出内部字段。
	var oauth *OAuthAuth
	if got, want := oauth.String(), "codex.OAuthAuth<nil>"; got != want {
		t.Fatalf("nil OAuth 文本错误: got=%q want=%q", got, want)
	}
	var apiKey *APIKeyAuth
	if got, want := apiKey.String(), "codex.APIKeyAuth<nil>"; got != want {
		t.Fatalf("nil API Key 文本错误: got=%q want=%q", got, want)
	}
}

func FuzzNewAPIKeyAuthDoesNotLeakSecret(f *testing.F) {
	f.Add("sk-long-secret-for-fuzz-seed", "https://api.openai.com/v1")
	f.Add("another-long-secret-for-fuzz", "HTTPS://EXAMPLE.COM:443/v1/")
	f.Add("secret-with-query-case", "https://example.com/v1?tenant=x")

	f.Fuzz(func(t *testing.T, apiKey, baseURL string) {
		auth, err := NewAPIKeyAuth(APIKeyInput{APIKey: apiKey, BaseURL: baseURL})
		if err != nil {
			if len(apiKey) >= 12 && strings.Contains(err.Error(), apiKey) {
				t.Fatal("错误文本泄漏了 API Key")
			}
			return
		}
		if len(apiKey) < 12 || strings.Contains(baseURL, apiKey) {
			return
		}
		assertTextDoesNotContainSecrets(t, auth.String(), apiKey)
		assertTextDoesNotContainSecrets(t, auth.Summary().String(), apiKey)
	})
}

func FuzzNewOAuthAuthIdentityClaims(f *testing.F) {
	f.Add("user-seed", "workspace-seed")
	f.Add("subject-seed", "")

	f.Fuzz(func(t *testing.T, userID, workspaceID string) {
		idToken := buildTestJWT(map[string]any{
			"sub": userID,
			"https://api.openai.com/auth": map[string]any{
				"chatgpt_account_id": workspaceID,
			},
		})
		auth, err := NewOAuthAuth(OAuthInput{
			AccessToken:   testAccessSecret,
			RefreshToken:  testRefreshSecret,
			IDToken:       idToken,
			RefreshedAtMS: 1,
		})
		if err != nil {
			assertTextDoesNotContainSecrets(t, err.Error(), testAccessSecret, testRefreshSecret, idToken)
			return
		}
		assertTextDoesNotContainSecrets(t, auth.String(), testAccessSecret, testRefreshSecret, idToken)
		assertTextDoesNotContainSecrets(t, auth.Summary().String(), testAccessSecret, testRefreshSecret, idToken)
	})
}

func buildTestJWT(payload map[string]any) string {
	payloadJSON, _ := json.Marshal(payload)
	return buildTestJWTBytes(payloadJSON)
}

func buildTestJWTBytes(payload []byte) string {
	headerJSON, _ := json.Marshal(map[string]any{"alg": "none", "typ": "JWT"})
	return base64.RawURLEncoding.EncodeToString(headerJSON) + "." +
		base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}

func assertTextDoesNotContainSecrets(t *testing.T, text string, secrets ...string) {
	t.Helper()
	for _, secret := range secrets {
		if secret != "" && strings.Contains(text, secret) {
			t.Fatalf("文本泄漏秘密: %q", text)
		}
	}
}

func assertFormattingDoesNotContainSecrets(t *testing.T, pointerValue, copiedValue any, secrets ...string) {
	// Formatter、特殊 verb 和错误 verb 都不能借助反射输出私有凭证。
	t.Helper()
	formats := []string{
		"%v", "%+v", "%#v", "%s", "%q", "%x", "%X",
		"%d", "%o", "%O", "%b", "%f", "%F", "%e", "%E", "%g", "%G",
		"%c", "%U", "%t", "%p", "%T", "%w", "%j",
	}
	for _, format := range formats {
		assertTextDoesNotContainSecrets(t, fmt.Sprintf(format, pointerValue), secrets...)
		assertTextDoesNotContainSecrets(t, fmt.Sprintf(format, copiedValue), secrets...)
	}
}
