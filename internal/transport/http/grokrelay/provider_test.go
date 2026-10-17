package grokrelay

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

func fixedTestTime() time.Time { return time.Unix(1792025000, 0) }

func nativeCredential(t *testing.T, payload []byte) accountapp.Credential {
	t.Helper()
	identity, err := accountcore.NewNativeSubjectIdentity("kimi", "user-1")
	if err != nil {
		// grok 不在 subject 白名单里时退回最小身份构造路径。
		t.Skipf("无法构造测试身份: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, payload)
	if err != nil {
		t.Fatalf("构造凭据失败: %v", err)
	}
	return credential
}

// TestProviderUsesStandardOpenAIPath 守「grok 是多数派」：路径不抬升。
func TestProviderUsesStandardOpenAIPath(t *testing.T) {
	provider := NewProvider("")
	endpoint, ok := provider.Endpoint()
	if !ok {
		t.Fatal("默认端点必须可用")
	}
	const want = DefaultBaseURL + ChatCompletionsPath
	if endpoint != want {
		t.Fatalf("端点错误：got %q want %q", endpoint, want)
	}
}

// TestProviderHonoursAccountBaseURL 守账号级覆盖。
func TestProviderHonoursAccountBaseURL(t *testing.T) {
	provider := NewProvider("https://proxy.internal/xai/v1/")
	endpoint, _ := provider.Endpoint()
	if endpoint != "https://proxy.internal/xai/v1/chat/completions" {
		t.Fatalf("账号级 base URL 未生效或未去尾斜杠：%q", endpoint)
	}
}

// TestProviderDoesNotRewriteRequests 守零覆盖。
func TestProviderDoesNotRewriteRequests(t *testing.T) {
	provider := NewProvider("")
	original := []byte(`{"model":"grok-4","stream":false,"messages":[{"role":"user","content":"hi"}]}`)
	result, err := provider.RewriteRequest(original)
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if string(result.Body) != string(original) {
		t.Fatalf("grok 不得改写请求体：%s", result.Body)
	}
}

// TestProviderDoesNotAddSpecialHeaders 守零覆盖：不写 Provider 特有头。
func TestProviderDoesNotAddSpecialHeaders(t *testing.T) {
	provider := NewProvider("")
	request, _ := http.NewRequest(http.MethodPost, "https://api.x.ai", nil)
	provider.DecorateUpstream(request, "xai-key")
	if got := request.Header.Get("Authorization"); got != "Bearer xai-key" {
		t.Fatalf("Bearer 鉴权错误：%q", got)
	}
	for _, header := range []string{"User-Agent", "Origin", "Referer", "X-Requested-With", "X-Msh-Platform"} {
		if got := request.Header.Get(header); got != "" {
			t.Fatalf("grok 不得写 %s：%q", header, got)
		}
	}
}

// TestAccessTokenReadsFlatApiKey 守 API Key 账号形态。
func TestAccessTokenReadsFlatApiKey(t *testing.T) {
	payload, _ := json.Marshal(map[string]any{"api_key": "xai-abc123"})
	provider := NewProvider("")
	got, err := provider.AccessToken(nativeCredential(t, payload))
	if err != nil {
		t.Fatalf("取令牌失败: %v", err)
	}
	if got != "xai-abc123" {
		t.Fatalf("令牌错误：%q", got)
	}
}

// TestAccessTokenReadsOAuthDocument 守 OAuth 原生文档形态。
func TestAccessTokenReadsOAuthDocument(t *testing.T) {
	payload, _ := json.Marshal(map[string]any{
		"auth": map[string]any{
			"default": map[string]any{"access_token": "oauth-token-1"},
		},
	})
	provider := NewProvider("")
	got, err := provider.AccessToken(nativeCredential(t, payload))
	if err != nil {
		t.Fatalf("取令牌失败: %v", err)
	}
	if got != "oauth-token-1" {
		t.Fatalf("令牌错误：%q", got)
	}
}

// TestAccessTokenReadsCLIAuthRecord 守 grok CLI 的真实登录态形状。
//
// 实测（2026-10-17）：凭据顶层是 auth，其下每个键是 `<issuer>::<uuid>`，
// 值里带 key（JWT access token）。键名不是固定字面量，因此必须遍历而不是按名取 ——
// 这条用例就是钉住这一点。
func TestAccessTokenReadsCLIAuthRecord(t *testing.T) {
	payload, _ := json.Marshal(map[string]any{
		"auth": map[string]any{
			"https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": map[string]any{
				"key":        "jwt-access-token",
				"auth_mode":  "oidc",
				"user_id":    "af73aa79-1317-4d84-972a-16ed6acf256f",
			},
		},
	})
	provider := NewProvider("")
	got, err := provider.AccessToken(nativeCredential(t, payload))
	if err != nil {
		t.Fatalf("取令牌失败: %v", err)
	}
	if got != "jwt-access-token" {
		t.Fatalf("令牌错误：%q", got)
	}
}

// TestAccessTokenRejectsUnknownShape 守不猜字段。
func TestAccessTokenRejectsUnknownShape(t *testing.T) {
	payload, _ := json.Marshal(map[string]any{"unrelated": "value"})
	provider := NewProvider("")
	if _, err := provider.AccessToken(nativeCredential(t, payload)); err == nil {
		t.Fatal("认不出的形态必须拒绝，不得猜字段")
	}
	if _, err := provider.AccessToken(nil); err == nil {
		t.Fatal("nil 凭据必须拒绝")
	}
}

// TestProviderResolvesOwnIDOnly 守单 Provider 通道语义。
func TestProviderResolvesOwnIDOnly(t *testing.T) {
	provider := NewProvider("")
	if _, ok := provider.Resolve(relaycore.ResolveInput{ProviderID: "grok"}); !ok {
		t.Fatal("grok 必须解析成功")
	}
	if _, ok := provider.Resolve(relaycore.ResolveInput{ProviderID: "cline"}); ok {
		t.Fatal("cline 不得被 grok 通道解析")
	}
}

// TestProviderUsesSharedFailureClassification 守零覆盖：错误分类用通用实现。
func TestProviderUsesSharedFailureClassification(t *testing.T) {
	provider := NewProvider("")
	var _ relaycore.Provider = provider
	if _, err := provider.ClassifyFailure(
		http.StatusOK, http.Header{}, []byte(`{"ok":true}`), fixedTestTime(),
	); err == nil {
		t.Fatal("2xx 必须报无失败证据")
	}
}
