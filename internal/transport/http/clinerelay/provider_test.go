package clinerelay

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// fixedTestTime 是测试用的确定性时钟。
func fixedTestTime() time.Time { return time.Unix(1792025000, 0) }

// jwt 造一个只含声明的最小 JWT（签名段是占位，本包不做验签）。
func jwt(t *testing.T, claims map[string]any) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"RS256","typ":"JWT"}`))
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("序列化声明失败: %v", err)
	}
	return header + "." + base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}

// clineDocument 造一份 cline 文档（含别的 provider 槽位，用于验证不串号）。
func clineDocument(t *testing.T, accessToken string) []byte {
	t.Helper()
	document := map[string]any{
		"auth": map[string]any{
			"version":          1,
			"lastUsedProvider": "cline-pass",
			"providers": map[string]any{
				// 别的 provider 的明文密钥：本包**绝不能**读它。
				"anthropic": map[string]any{
					"settings": map[string]any{"apiKey": "sk-ant-should-never-be-read"},
				},
				"cline": map[string]any{
					"settings": map[string]any{
						"provider": "cline",
						"auth":     map[string]any{"accessToken": accessToken},
					},
				},
			},
		},
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("序列化文档失败: %v", err)
	}
	return encoded
}

func nativeCredential(t *testing.T, payload []byte) accountapp.Credential {
	t.Helper()
	identity, err := accountcore.NewNativeSubjectIdentity("cline", "user-1")
	if err != nil {
		t.Fatalf("构造身份失败: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, payload)
	if err != nil {
		t.Fatalf("构造凭据失败: %v", err)
	}
	return credential
}

// TestProviderUsesStandardOpenAIPath 守「cline 是多数派」：路径不抬升。
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
	// 家族抬升到 /v2；cline 必须保持标准 /api/v1/chat/completions。
	if endpoint == "https://api.cline.bot/v2/chat/completions" {
		t.Fatal("cline 不得走家族的 /v2 抬升路径")
	}
}

// TestProviderHonoursAccountBaseURL 守账号级覆盖（自建/企业代理）。
func TestProviderHonoursAccountBaseURL(t *testing.T) {
	provider := NewProvider("https://proxy.internal/cline/api/v1/")
	endpoint, _ := provider.Endpoint()
	if endpoint != "https://proxy.internal/cline/api/v1/chat/completions" {
		t.Fatalf("账号级 base URL 未生效或未去尾斜杠：%q", endpoint)
	}
}

// TestProviderDoesNotRewriteRequests 守零覆盖：cline 不该改写请求体。
func TestProviderDoesNotRewriteRequests(t *testing.T) {
	provider := NewProvider("")
	original := []byte(`{"model":"cline-pass/glm-5.3","stream":false,"messages":[{"role":"user","content":"hi"}]}`)
	result, err := provider.RewriteRequest(original)
	if err != nil {
		t.Fatalf("不应报错: %v", err)
	}
	if string(result.Body) != string(original) {
		t.Fatalf("cline 不得改写请求体（那是家族的差异）：%s", result.Body)
	}
	if len(result.Degradations) != 0 {
		t.Fatalf("cline 不得报告降级：%v", result.Degradations)
	}
}

// TestProviderDoesNotAddFamilyHeaders 守零覆盖：不写家族的 UA / Origin。
func TestProviderDoesNotAddFamilyHeaders(t *testing.T) {
	provider := NewProvider("")
	request, _ := http.NewRequest(http.MethodPost, "https://api.cline.bot", nil)
	provider.DecorateUpstream(request, "workos:token")
	if got := request.Header.Get("Authorization"); got != "Bearer workos:token" {
		t.Fatalf("Bearer 鉴权错误：%q", got)
	}
	for _, header := range []string{"User-Agent", "Origin", "Referer", "X-Requested-With"} {
		if got := request.Header.Get(header); got != "" {
			t.Fatalf("cline 不得写 %s（那是家族的差异）：%q", header, got)
		}
	}
}

// TestAccessTokenReadsClineSlotOnly 守「不读别的 provider 槽位」。
func TestAccessTokenReadsClineSlotOnly(t *testing.T) {
	token := "workos:" + jwt(t, map[string]any{"sub": "user-1"})
	provider := NewProvider("")
	credential := nativeCredential(t, clineDocument(t, token))
	got, err := provider.AccessToken(credential)
	if err != nil {
		t.Fatalf("取令牌失败: %v", err)
	}
	if got != token {
		t.Fatalf("令牌错误：got %q want %q", got, token)
	}
	// 前缀必须保留（wire 格式的一部分）：裸 JWT 上游 401。
	if len(got) < len("workos:") || got[:len("workos:")] != "workos:" {
		t.Fatal("必须保留 workos: 前缀")
	}
	if got == "sk-ant-should-never-be-read" {
		t.Fatal("绝不能读别的 provider 槽位")
	}
}

// TestAccessTokenReadsClinePassSlot 守 Cline Pass 订阅槽位。
func TestAccessTokenReadsClinePassSlot(t *testing.T) {
	token := "workos:" + jwt(t, map[string]any{"sub": "user-2"})
	document := map[string]any{
		"auth": map[string]any{
			"providers": map[string]any{
				"cline-pass": map[string]any{
					"settings": map[string]any{"auth": map[string]any{"accessToken": token}},
				},
			},
		},
	}
	encoded, _ := json.Marshal(document)
	provider := NewProvider("")
	got, err := provider.AccessToken(nativeCredential(t, encoded))
	if err != nil {
		t.Fatalf("取令牌失败: %v", err)
	}
	if got != token {
		t.Fatalf("令牌错误：got %q want %q", got, token)
	}
}

// TestAccessTokenRejectsNonNativeCredential 守凭据形态校验。
func TestAccessTokenRejectsNonNativeCredential(t *testing.T) {
	provider := NewProvider("")
	if _, err := provider.AccessToken(nil); err == nil {
		t.Fatal("nil 凭据必须拒绝")
	}
}

// TestAccessTokenRejectsDocumentWithoutClineSlot 守缺槽位时不猜。
func TestAccessTokenRejectsDocumentWithoutClineSlot(t *testing.T) {
	document := map[string]any{
		"auth": map[string]any{
			"providers": map[string]any{
				"anthropic": map[string]any{"settings": map[string]any{"apiKey": "sk-ant-x"}},
			},
		},
	}
	encoded, _ := json.Marshal(document)
	provider := NewProvider("")
	if _, err := provider.AccessToken(nativeCredential(t, encoded)); err == nil {
		t.Fatal("没有 cline 槽位时必须拒绝，不得回落到别的 provider 的密钥")
	}
}

// TestProviderResolvesOwnIDOnly 守单 Provider 通道的解析语义。
func TestProviderResolvesOwnIDOnly(t *testing.T) {
	provider := NewProvider("")
	if _, ok := provider.Resolve("cline"); !ok {
		t.Fatal("cline 必须解析成功")
	}
	if _, ok := provider.Resolve("codebuddy"); ok {
		t.Fatal("家族 Provider 不得被 cline 通道解析")
	}
}

// TestProviderUsesSharedDefaultsForFailureClassification 守零覆盖：错误分类用通用实现。
func TestProviderUsesSharedDefaultsForFailureClassification(t *testing.T) {
	provider := NewProvider("")
	var _ relaycore.Provider = provider
	// 通用观察器认得 OpenAI 错误体；家族走的是腾讯信封（本包不该是那条路径）。
	if _, err := provider.ClassifyFailure(
		http.StatusOK, http.Header{}, []byte(`{"ok":true}`), fixedTestTime(),
	); err == nil {
		t.Fatal("2xx 必须报无失败证据，不能被改写成失败")
	}
}
