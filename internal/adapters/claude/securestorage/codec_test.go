package securestorage

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/accounts/claude"
)

const (
	testAccessToken  = "sk-ant-oat01-secure-storage-access"
	testRefreshToken = "sk-ant-ort01-secure-storage-refresh"
)

// TestDecodeOfficialOAuth 验证官方 secure storage OAuth 形态可直接进入领域层。
func TestDecodeOfficialOAuth(t *testing.T) {
	data := mustJSON(t, map[string]any{
		"claudeAiOauth":     validOAuthPayload(),
		"pluginCredentials": map[string]any{"preserved": true},
	})
	auth, err := Decode(data, validDecodeOptions())
	if err != nil {
		t.Fatalf("解析 Claude secure storage 失败: %v", err)
	}

	if auth.Kind() != claude.AuthKindOAuth {
		t.Fatalf("认证类型错误: %s", auth.Kind())
	}
	if auth.AccessToken() != testAccessToken || auth.RefreshToken() != testRefreshToken {
		t.Fatal("OAuth Token 没有完整进入领域对象")
	}
	if auth.AccountUUID() != "123e4567-e89b-12d3-a456-426614174000" {
		t.Fatalf("身份上下文没有进入领域对象: %s", auth.AccountUUID())
	}
	if auth.RefreshTokenExpiresAtMS() != 4_105_036_800_000 {
		t.Fatalf("Refresh Token 过期时间解析错误: %d", auth.RefreshTokenExpiresAtMS())
	}
	if auth.ClientID() != "claude-code-official-client" {
		t.Fatalf("OAuth Client ID 解析错误: %s", auth.ClientID())
	}
	if auth.SubscriptionType() != "max" || auth.RateLimitTier() != "default_claude_max_20x" {
		t.Fatal("官方 OAuth 公开元数据解析错误")
	}
}

// TestDecodeAcceptsMissingOrNullOptionalOAuthMetadata 验证官方可选刷新元数据不会阻塞旧登录 artifact。
func TestDecodeAcceptsMissingOrNullOptionalOAuthMetadata(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(map[string]any)
	}{
		{
			name: "字段缺失",
			mutate: func(payload map[string]any) {
				delete(payload, "refreshTokenExpiresAt")
				delete(payload, "clientId")
			},
		},
		{
			name: "字段为 null",
			mutate: func(payload map[string]any) {
				payload["refreshTokenExpiresAt"] = nil
				payload["clientId"] = nil
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			payload := validOAuthPayload()
			test.mutate(payload)
			auth, err := Decode(mustJSON(t, map[string]any{"claudeAiOauth": payload}), validDecodeOptions())
			if err != nil {
				t.Fatalf("解析可选 OAuth 元数据失败: %v", err)
			}
			if auth.RefreshTokenExpiresAtMS() != 0 || auth.ClientID() != "" {
				t.Fatal("缺失或 null 的可选 OAuth 元数据应映射为领域零值")
			}
		})
	}
}

// TestDecodeAcceptsNullPublicMetadata 验证官方登录允许套餐元数据暂时为 null。
func TestDecodeAcceptsNullPublicMetadata(t *testing.T) {
	payload := validOAuthPayload()
	payload["subscriptionType"] = nil
	payload["rateLimitTier"] = nil
	auth, err := Decode(mustJSON(t, map[string]any{"claudeAiOauth": payload}), validDecodeOptions())
	if err != nil {
		t.Fatalf("解析 null 元数据失败: %v", err)
	}
	if auth.SubscriptionType() != "" || auth.RateLimitTier() != "" {
		t.Fatal("null 元数据应映射为空领域值")
	}
}

// TestDecodeRejectsNonCanonicalOAuth 固定官方字段合同，并拒绝 AIH 历史镜像字段。
func TestDecodeRejectsNonCanonicalOAuth(t *testing.T) {
	valid := validOAuthPayload()
	tests := []struct {
		name string
		data []byte
	}{
		{name: "畸形 JSON", data: []byte(`{"claudeAiOauth":`)},
		{name: "尾随 JSON", data: []byte(`{"claudeAiOauth":{}}{}`)},
		{name: "缺少 OAuth", data: []byte(`{}`)},
		{name: "OAuth 为 null", data: []byte(`{"claudeAiOauth":null}`)},
		{name: "snake_case 容器", data: mustJSON(t, map[string]any{"claude_ai_oauth": valid})},
		{name: "未知 OAuth 字段", data: mutateOAuth(t, valid, "account", map[string]any{"uuid": "123"})},
		{name: "snake_case Token", data: mutateOAuth(t, valid, "access_token", testAccessToken)},
		{name: "缺少 Access Token", data: removeOAuthField(t, valid, "accessToken")},
		{name: "Access Token 为 null", data: mutateOAuth(t, valid, "accessToken", nil)},
		{name: "缺少 Refresh Token", data: removeOAuthField(t, valid, "refreshToken")},
		{name: "ExpiresAt 为小数", data: mutateOAuth(t, valid, "expiresAt", 1.5)},
		{name: "RefreshTokenExpiresAt 为零", data: mutateOAuth(t, valid, "refreshTokenExpiresAt", 0)},
		{name: "RefreshTokenExpiresAt 为小数", data: mutateOAuth(t, valid, "refreshTokenExpiresAt", 1.5)},
		{name: "ClientID 为数字", data: mutateOAuth(t, valid, "clientId", 123)},
		{name: "Scopes 为字符串", data: mutateOAuth(t, valid, "scopes", "user:inference")},
		{name: "缺少套餐字段", data: removeOAuthField(t, valid, "subscriptionType")},
		{name: "缺少额度层级字段", data: removeOAuthField(t, valid, "rateLimitTier")},
		{name: "重复顶层字段", data: []byte(`{"claudeAiOauth":{},"claudeAiOauth":{}}`)},
		{name: "重复 OAuth 字段", data: []byte(`{"claudeAiOauth":{"accessToken":"first","accessToken":"second","refreshToken":"refresh","expiresAt":4102444800000,"scopes":["user:inference"],"subscriptionType":null,"rateLimitTier":null}}`)},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := Decode(test.data, validDecodeOptions()); err == nil {
				t.Fatal("非官方 OAuth 结构应被拒绝")
			} else if !errors.Is(err, ErrInvalidCredentials) {
				t.Fatalf("错误类型不稳定: %v", err)
			}
		})
	}
}

// TestDecodeRequiresExternalIdentity 验证 secure storage 不得伪造其本身没有保存的账号身份。
func TestDecodeRequiresExternalIdentity(t *testing.T) {
	data := mustJSON(t, map[string]any{"claudeAiOauth": validOAuthPayload()})
	if _, err := Decode(data, DecodeOptions{}); err == nil {
		t.Fatal("缺少独立 oauthAccount 身份上下文时必须拒绝")
	}
}

// TestUpsertPreservesOtherSecureStorageData 验证写回 OAuth 时不覆盖其他插件的敏感存储域。
func TestUpsertPreservesOtherSecureStorageData(t *testing.T) {
	existing := []byte(`{"pluginCredentials":{"provider":"opaque"},"futureNativeField":[1,2,3]}`)
	auth, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:             testAccessToken,
		RefreshToken:            testRefreshToken,
		ExpiresAtMS:             4_102_444_800_000,
		RefreshTokenExpiresAtMS: 4_105_036_800_000,
		ClientID:                "claude-code-official-client",
		Scopes:                  []string{claude.InferenceScope, "user:profile"},
		Identity:                validDecodeOptions().Identity,
		SubscriptionType:        "max",
		RateLimitTier:           "default_claude_max_20x",
	})
	if err != nil {
		t.Fatalf("创建 OAuth 领域值失败: %v", err)
	}

	encoded, err := Upsert(existing, auth)
	if err != nil {
		t.Fatalf("写回 secure storage 失败: %v", err)
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatalf("写回结果不是 JSON: %v", err)
	}
	if string(document["pluginCredentials"]) != `{"provider":"opaque"}` {
		t.Fatalf("插件凭据被修改: %s", document["pluginCredentials"])
	}
	if string(document["futureNativeField"]) != `[1,2,3]` {
		t.Fatalf("未知官方字段被修改: %s", document["futureNativeField"])
	}

	var oauth map[string]json.RawMessage
	if err := json.Unmarshal(document["claudeAiOauth"], &oauth); err != nil {
		t.Fatalf("OAuth 输出无效: %v", err)
	}
	assertKeys(t, oauth,
		"accessToken",
		"refreshToken",
		"expiresAt",
		"refreshTokenExpiresAt",
		"clientId",
		"scopes",
		"subscriptionType",
		"rateLimitTier",
	)
	decoded, err := Decode(encoded, validDecodeOptions())
	if err != nil {
		t.Fatalf("写回结果不能重新解析: %v", err)
	}
	if decoded.RefreshTokenExpiresAtMS() != auth.RefreshTokenExpiresAtMS() || decoded.ClientID() != auth.ClientID() {
		t.Fatal("写回结果没有保留官方可选 OAuth 元数据")
	}
}

// TestEncodeCreatesMinimalOfficialDocument 验证新建 secure storage 只写 Claude 官方 OAuth 容器。
func TestEncodeCreatesMinimalOfficialDocument(t *testing.T) {
	auth, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:  testAccessToken,
		RefreshToken: testRefreshToken,
		ExpiresAtMS:  4_102_444_800_000,
		Scopes:       []string{claude.InferenceScope},
		Identity:     validDecodeOptions().Identity,
	})
	if err != nil {
		t.Fatalf("创建 OAuth 领域值失败: %v", err)
	}
	encoded, err := Encode(auth)
	if err != nil {
		t.Fatalf("编码 OAuth 失败: %v", err)
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatalf("编码结果无效: %v", err)
	}
	assertKeys(t, document, "claudeAiOauth")
	var oauth map[string]json.RawMessage
	if err := json.Unmarshal(document["claudeAiOauth"], &oauth); err != nil {
		t.Fatalf("OAuth 输出无效: %v", err)
	}
	assertKeys(t, oauth,
		"accessToken",
		"refreshToken",
		"expiresAt",
		"scopes",
		"subscriptionType",
		"rateLimitTier",
	)
}

// TestErrorsAndFormattingNeverLeakOAuthSecrets 验证失败和格式化路径不会泄漏真实 Token。
func TestErrorsAndFormattingNeverLeakOAuthSecrets(t *testing.T) {
	data := mustJSON(t, map[string]any{
		"claudeAiOauth": map[string]any{
			"accessToken":      testAccessToken,
			"refreshToken":     testRefreshToken,
			"expiresAt":        0,
			"scopes":           []string{claude.InferenceScope},
			"subscriptionType": nil,
			"rateLimitTier":    nil,
		},
	})
	_, err := Decode(data, validDecodeOptions())
	if err == nil {
		t.Fatal("无效过期时间应失败")
	}
	for _, secret := range []string{testAccessToken, testRefreshToken} {
		if strings.Contains(err.Error(), secret) || strings.Contains(fmt.Sprintf("%+v", err), secret) {
			t.Fatal("错误文本泄漏 OAuth Token")
		}
	}
}

// FuzzDecode 验证任意 JSON 输入不会 panic，也不会把种子凭据写入错误文本。
func FuzzDecode(f *testing.F) {
	f.Add([]byte(`{"claudeAiOauth":{"accessToken":"secret-access","refreshToken":"secret-refresh","expiresAt":4102444800000,"scopes":["user:inference"],"subscriptionType":null,"rateLimitTier":null}}`))
	f.Add([]byte(`{"claudeAiOauth":null}`))
	f.Add([]byte{0xff, 0xfe})
	f.Fuzz(func(t *testing.T, data []byte) {
		_, err := Decode(data, validDecodeOptions())
		if err == nil {
			return
		}
		if strings.Contains(err.Error(), "secret-access") || strings.Contains(err.Error(), "secret-refresh") {
			t.Fatal("模糊测试错误泄漏种子凭据")
		}
	})
}

// validOAuthPayload 返回 Claude Code 2.1.207 写入 secure storage 的 OAuth 字段集合。
func validOAuthPayload() map[string]any {
	return map[string]any{
		"accessToken":           testAccessToken,
		"refreshToken":          testRefreshToken,
		"expiresAt":             int64(4_102_444_800_000),
		"refreshTokenExpiresAt": int64(4_105_036_800_000),
		"clientId":              "claude-code-official-client",
		"scopes":                []string{claude.InferenceScope, "user:profile"},
		"subscriptionType":      "max",
		"rateLimitTier":         "default_claude_max_20x",
	}
}

// validDecodeOptions 返回 secure storage 外部提供的稳定账号身份。
func validDecodeOptions() DecodeOptions {
	return DecodeOptions{Identity: claude.OAuthIdentity{
		AccountUUID:      "123e4567-e89b-12d3-a456-426614174000",
		Email:            "owner@example.com",
		OrganizationUUID: "223e4567-e89b-12d3-a456-426614174000",
	}}
}

// mutateOAuth 克隆 OAuth payload 并写入一个字段。
func mutateOAuth(t *testing.T, source map[string]any, key string, value any) []byte {
	t.Helper()
	copy := cloneMap(source)
	copy[key] = value
	return mustJSON(t, map[string]any{"claudeAiOauth": copy})
}

// removeOAuthField 克隆 OAuth payload 并删除一个字段。
func removeOAuthField(t *testing.T, source map[string]any, key string) []byte {
	t.Helper()
	copy := cloneMap(source)
	delete(copy, key)
	return mustJSON(t, map[string]any{"claudeAiOauth": copy})
}

// cloneMap 创建浅层测试副本，避免表驱动用例互相污染。
func cloneMap(source map[string]any) map[string]any {
	out := make(map[string]any, len(source))
	for key, value := range source {
		out[key] = value
	}
	return out
}

// mustJSON 编码测试输入，失败时立即终止当前用例。
func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("构造 JSON 失败: %v", err)
	}
	return data
}

// assertKeys 验证 JSON 对象字段精确相等。
func assertKeys(t *testing.T, document map[string]json.RawMessage, expected ...string) {
	t.Helper()
	if len(document) != len(expected) {
		t.Fatalf("字段数量错误: got=%v want=%v", keys(document), expected)
	}
	wanted := make(map[string]struct{}, len(expected))
	for _, key := range expected {
		wanted[key] = struct{}{}
	}
	for key := range document {
		if _, ok := wanted[key]; !ok {
			t.Fatalf("出现未知字段: %s", key)
		}
	}
}

// keys 返回测试错误中可安全展示的字段名。
func keys(document map[string]json.RawMessage) []string {
	out := make([]string, 0, len(document))
	for key := range document {
		out = append(out, key)
	}
	return out
}
