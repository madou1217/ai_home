package codebuddyfamilyrelay

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestFamilyProviderTable(t *testing.T) {
	cases := []struct {
		provider string
		base     string
	}{
		{"codebuddy", "https://www.codebuddy.ai"},
		{"workbuddy", "https://www.workbuddy.ai"},
		{"codebuddycn", "https://copilot.tencent.com"},
		{"workbuddycn", "https://copilot.tencent.com"},
	}
	for _, testCase := range cases {
		if !IsFamilyProvider(testCase.provider) {
			t.Fatalf("%s 应属于家族", testCase.provider)
		}
		base, ok := InferenceBaseURL(testCase.provider)
		if !ok || base != testCase.base {
			t.Fatalf("%s 的站点根 = %q，期望 %q", testCase.provider, base, testCase.base)
		}
		endpoint, ok := InferenceEndpoint(testCase.provider)
		if !ok || endpoint != testCase.base+ChatCompletionsPath {
			t.Fatalf("%s 的上游 URL = %q，期望 %q", testCase.provider, endpoint, testCase.base+ChatCompletionsPath)
		}
	}
	// 国内站两支共用同一个网关（发行版级 endpoint），国际站各用自己域名。
	cnBase, _ := InferenceBaseURL("codebuddycn")
	workCNBase, _ := InferenceBaseURL("workbuddycn")
	if cnBase != workCNBase {
		t.Fatal("国内站两支必须共用同一个推理网关")
	}
}

func TestConversationHeadersAreNonEmptyAndFresh(t *testing.T) {
	now := time.UnixMilli(1_000)
	first := ConversationHeaders(now)
	second := ConversationHeaders(now)
	// 官方 UUIDv7 形状：8-4-4-4-12 十六进制，第 13 位版本固定 7、第 17 位变体固定 8。
	uuidV7 := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	for _, name := range []string{ConversationIDHeader, ConversationMessageIDHeader, ConversationRequestIDHeader} {
		value := first[name]
		if value == "" {
			t.Fatalf("%s 不能为空（空值同样触发 11128）", name)
		}
		if !uuidV7.MatchString(value) {
			t.Fatalf("%s = %q，应为官方同形的 UUIDv7", name, value)
		}
		// 时间有序：去掉连字符后前 12 位是毫秒时间戳。
		compact := strings.ReplaceAll(value, "-", "")
		if !strings.HasPrefix(compact, fmt.Sprintf("%012x", now.UnixMilli())) {
			t.Fatalf("%s = %q，应以毫秒时间戳开头", name, value)
		}
		if value == second[name] {
			t.Fatalf("%s 每次请求都应新建", name)
		}
	}
	// 官方让这两个头同值（2026-10-21 抓包确认），复刻它避免留下可区分的差异。
	if first[RequestIDHeader] != first[ConversationMessageIDHeader] {
		t.Fatalf("%s 应与 %s 同值: %q vs %q",
			RequestIDHeader, ConversationMessageIDHeader,
			first[RequestIDHeader], first[ConversationMessageIDHeader])
	}
}

func TestIdentityHeadersCarryOfficialClientPicture(t *testing.T) {
	headers := IdentityHeaders("workbuddy", "  uid-1  ")
	if headers[ProductHeader] != "SaaS" || headers[AgentIntentHeader] != "craft" {
		t.Fatalf("官方身份头取值不对: %+v", headers)
	}
	if headers[DomainHeader] != "www.workbuddy.ai" {
		t.Fatalf("%s 应为站点域名: %q", DomainHeader, headers[DomainHeader])
	}
	// uid 去空白后下发；为空时**不下发**这个头——留空头比不发更容易被识别为异常。
	if headers[UserIDHeader] != "uid-1" {
		t.Fatalf("%s 应为去空白的 uid: %q", UserIDHeader, headers[UserIDHeader])
	}
	if _, present := IdentityHeaders("workbuddy", "")[UserIDHeader]; present {
		t.Fatal("uid 为空时不应下发 X-User-Id")
	}
	// 非家族 provider 不带 X-Domain，但不应产生空值头。
	if _, present := IdentityHeaders("codex", "uid-1")[DomainHeader]; present {
		t.Fatal("未登记的 provider 不应下发 X-Domain")
	}
}

func TestFamilyProviderRejectsOthers(t *testing.T) {
	for _, provider := range []string{"", "codex", "claude", "agy", "gemini", "opencode", "codebuddy.ai", "workbuddyx"} {
		if IsFamilyProvider(provider) {
			t.Fatalf("%q 不应被当作家族成员", provider)
		}
		if _, ok := InferenceEndpoint(provider); ok {
			t.Fatalf("%q 不应有家族上游 URL", provider)
		}
	}
	// 大小写与空白归一后仍要认出来（CLI 输入常见形态）。
	if !IsFamilyProvider("  CodeBuddyCN ") {
		t.Fatal("大小写与空白归一后应识别为家族成员")
	}
}

func TestAccessTokenFromPayload(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		token   string
	}{
		{"nested accessToken", `{"credentials":{"auth":{"accessToken":"tok-1"}}}`, "tok-1"},
		{"snake case fallback", `{"credentials":{"auth":{"access_token":" tok-2 "}}}`, "tok-2"},
		{"extra fields ignored", `{"credentials":{"auth":{"accessToken":"tok-3","refreshToken":"r"}},"account":{"uid":"u"}}`, "tok-3"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			token, err := accessTokenFromPayload([]byte(testCase.payload))
			if err != nil || token != testCase.token {
				t.Fatalf("token = %q (err=%v)，期望 %q", token, err, testCase.token)
			}
		})
	}
	for _, payload := range []string{
		``,
		`not json`,
		`{"credentials":{}}`,
		`{"credentials":{"auth":{}}}`,
		`{"credentials":{"auth":{"accessToken":""}}}`,
		`{"credentials":{"auth":{"accessToken":42}}}`,
		`{"auth":{"accessToken":"tok"}}`,
	} {
		if _, err := accessTokenFromPayload([]byte(payload)); !errors.Is(err, ErrUnsupportedCredential) {
			t.Fatalf("payload %q 应返回 ErrUnsupportedCredential，实际 %v", payload, err)
		}
	}
	// 非原生凭据（或 nil）一律不可透传：交回 Canonical。
	if _, err := AccessTokenFromCredential(nil); !errors.Is(err, ErrUnsupportedCredential) {
		t.Fatalf("nil 凭据应返回 ErrUnsupportedCredential，实际 %v", err)
	}
}

// 官方画像完整性（2026-10-21 抓包）：官方 CLI 身份共发 35 个头（不含鉴权/长度/host/连接）。
// 这里钉住「我们发的那一套与官方逐项对齐」，任何一侧漏发都会让画像出现可区分的差异。
func TestOfficialClientPictureIsComplete(t *testing.T) {
	conversation := ConversationHeaders(time.UnixMilli(1_000))
	sets := []map[string]string{
		IdentityHeaders("workbuddy", "uid-1"),
		StainlessHeaders(),
		TraceHeaders(),
		conversation,
		{"Baggage": BaggageHeader(conversation[ConversationIDHeader], conversation[ConversationRequestIDHeader])},
		{"User-Agent": UserAgent},
		{"X-Requested-With": "XMLHttpRequest"},
		{"Accept": "application/json"},
		{"Content-Type": "application/json"}, // 由 relaycore 基类写
	}
	got := map[string]bool{}
	for _, set := range sets {
		for name := range set {
			got[http.CanonicalHeaderKey(name)] = true
		}
	}
	// 官方抓包的完整头集合（小写，已剔除鉴权/长度/host/连接）。
	official := []string{
		"accept", "b3", "baggage", "content-type", "traceparent", "user-agent",
		"x-agent-intent", "x-agent-purpose", "x-agent-type", "x-b3-parentspanid",
		"x-b3-sampled", "x-b3-spanid", "x-b3-traceid", "x-codebuddy-request",
		"x-conversation-id", "x-conversation-message-id", "x-conversation-request-id",
		"x-domain", "x-ide-name", "x-ide-type", "x-ide-version", "x-private-data",
		"x-product", "x-request-id", "x-requested-with", "x-root-request-id",
		"x-stainless-arch", "x-stainless-lang", "x-stainless-os",
		"x-stainless-package-version", "x-stainless-retry-count", "x-stainless-runtime",
		"x-stainless-runtime-version", "x-trace-id", "x-user-id",
	}
	for _, name := range official {
		if !got[http.CanonicalHeaderKey(name)] {
			t.Fatalf("官方画像缺少头 %s（官方 CLI 会发它）", name)
		}
	}
	if len(got) != len(official) {
		t.Fatalf("头集合与官方不一致：我们有 %d 个，官方 %d 个", len(got), len(official))
	}
}
