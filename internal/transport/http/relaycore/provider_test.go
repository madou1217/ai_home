package relaycore

import (
	"net/http"
	"strings"
	"testing"
	"time"

	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// fixedClock 是测试用的确定性时钟。
func fixedClock() time.Time { return time.Unix(1792025000, 0) }

// fakeCredential 是 AccessToken 默认实现的测试替身（基类不看内容）。
type fakeCredential struct{}

func (fakeCredential) ProviderID() string   { return "fake" }
func (fakeCredential) IdentitySeed() string { return "fake-seed" }
func (fakeCredential) String() string       { return "fake-credential" }
func (fakeCredential) GoString() string     { return "fakeCredential{}" }

// TestBaseProviderDefaultsMatchPlainOpenAIEndpoint 守「默认值取向」这条设计规则。
//
// 基类的默认必须写成**多数派**（朴素 OpenAI 兼容端点）的行为：不改写、只补通用头。
// 若有人把某个 Provider 的特例（如家族的 stream 恒 true）写成基类默认，这条会红——
// 那会让每个新增 Provider 都从错误起点出发。
func TestBaseProviderDefaultsMatchPlainOpenAIEndpoint(t *testing.T) {
	base := NewBaseProvider("plain", "https://api.example.com/v1/chat/completions")

	// 默认不改写：请求体逐字节返回，且不报告任何降级。
	original := []byte(`{"model":"m","stream":false,"messages":[{"role":"user","content":"hi"}]}`)
	result, err := base.RewriteRequest(original)
	if err != nil {
		t.Fatalf("默认改写不应报错: %v", err)
	}
	if string(result.Body) != string(original) {
		t.Fatalf("默认改写必须原样返回，实际 %s", result.Body)
	}
	if len(result.Degradations) != 0 {
		t.Fatalf("默认改写不得报告降级，实际 %v", result.Degradations)
	}

	// 默认只补三个通用头，不写 Provider 特有的 UA / Origin。
	request, _ := http.NewRequest(http.MethodPost, "https://api.example.com", nil)
	base.DecorateUpstream(request, "token-1")
	if got := request.Header.Get("Authorization"); got != "Bearer token-1" {
		t.Fatalf("默认必须写 Bearer 鉴权，实际 %q", got)
	}
	if got := request.Header.Get("Content-Type"); got != "application/json" {
		t.Fatalf("默认必须写 Content-Type，实际 %q", got)
	}
	for _, header := range []string{"User-Agent", "Origin", "Referer", "X-Requested-With"} {
		if got := request.Header.Get(header); got != "" {
			t.Fatalf("默认不得写 %s（那是特例 Provider 的差异），实际 %q", header, got)
		}
	}
}

// TestBaseProviderAccessTokenRefusesToGuess 守「不猜测凭据形态」。
//
// 基类默认返回 ErrUnsupportedCredential，让「忘了覆盖 AccessToken」立刻表现为
// 交还 Canonical，而不是拿错字段去上游换一个 401。
func TestBaseProviderAccessTokenRefusesToGuess(t *testing.T) {
	base := NewBaseProvider("plain", "https://api.example.com")
	if _, err := base.AccessToken(fakeCredential{}); err == nil {
		t.Fatal("基类默认必须拒绝取令牌，不能猜凭据形态")
	}
}

// TestBaseProviderResolveOnlyAcceptsOwnID 守单 Provider 通道的默认解析语义。
func TestBaseProviderResolveOnlyAcceptsOwnID(t *testing.T) {
	base := NewBaseProvider("cline", "https://api.example.com")
	if _, ok := base.Resolve(ResolveInput{ProviderID: "cline"}); !ok {
		t.Fatal("同名必须解析成功")
	}
	if _, ok := base.Resolve(ResolveInput{ProviderID: "CLINE"}); !ok {
		t.Fatal("解析必须大小写不敏感")
	}
	if _, ok := base.Resolve(ResolveInput{ProviderID: "kimi"}); ok {
		t.Fatal("别的 Provider 不得解析成功")
	}
}

// TestBaseProviderEndpointRefusesEmpty 守「表达不了就明说」。
func TestBaseProviderEndpointRefusesEmpty(t *testing.T) {
	if _, ok := NewBaseProvider("plain", "").Endpoint(); ok {
		t.Fatal("空端点必须返回 false，不能给一个空 URL 让上游换一个费解的错误")
	}
	if _, ok := NewBaseProvider("plain", "https://api.example.com").Endpoint(); !ok {
		t.Fatal("非空端点必须返回 true")
	}
}

// TestBaseProviderClassifyFailureUsesSharedObserver 守默认走通用观察器。
func TestBaseProviderClassifyFailureUsesSharedObserver(t *testing.T) {
	base := NewBaseProvider("plain", "https://api.example.com")
	classification, err := base.ClassifyFailure(
		http.StatusTooManyRequests,
		http.Header{},
		[]byte(`{"error":{"type":"rate_limit_exceeded","code":"429"}}`),
		fixedClock(),
	)
	if err != nil {
		t.Fatalf("通用观察器不应报错: %v", err)
	}
	if classification.Kind() == "" {
		t.Fatal("必须给出失败种类")
	}
}

// TestSharedObserverReportsNoEvidenceOnSuccess 守「2xx 不得被改写成失败」。
func TestSharedObserverReportsNoEvidenceOnSuccess(t *testing.T) {
	if _, err := sharedfailure.ObserveHTTP(
		http.StatusOK, http.Header{}, []byte(`{"ok":true}`), fixedClock(),
	); err == nil {
		t.Fatal("普通 2xx 正文必须报 ErrNoFailureEvidence，不能被改写成失败")
	}
}

// TestAggregateSSEUsesInjectableFallbackIDPrefix 守兜底 id 前缀可注入（Provider 差异）。
func TestAggregateSSEUsesInjectableFallbackIDPrefix(t *testing.T) {
	sse := "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n"
	aggregated := AggregateSSE([]byte(sse), AggregateOptions{
		Clock:            fixedClock,
		FallbackIDPrefix: "chatcmpl-acme",
	})
	if len(aggregated.Payload) == 0 {
		t.Fatal("必须产出聚合结果")
	}
	fields, ok := DecodeRawObject(aggregated.Payload)
	if !ok {
		t.Fatalf("聚合结果必须是 JSON 对象: %s", aggregated.Payload)
	}
	id, _ := RawString(fields["id"])
	if !strings.HasPrefix(id, "chatcmpl-acme-") {
		t.Fatalf("兜底 id 必须用注入的前缀，实际 %q", id)
	}
	if !aggregated.SawDone {
		t.Fatal("必须记录看到了 [DONE]")
	}
}

// TestAggregateSSEDefaultPrefixIsNeutral 守未注入前缀时的中性兜底。
func TestAggregateSSEDefaultPrefixIsNeutral(t *testing.T) {
	sse := "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"
	aggregated := AggregateSSE([]byte(sse), AggregateOptions{Clock: fixedClock})
	fields, _ := DecodeRawObject(aggregated.Payload)
	id, _ := RawString(fields["id"])
	if !strings.HasPrefix(id, "chatcmpl-") {
		t.Fatalf("默认兜底 id 必须是中性前缀，实际 %q", id)
	}
	if strings.Contains(id, "codebuddy") {
		t.Fatalf("relaycore 不得出现任何 Provider 专属前缀，实际 %q", id)
	}
}

// TestHandlerRejectsInvalidDependencies 守默认失败关闭。
func TestHandlerRejectsInvalidDependencies(t *testing.T) {
	base := NewBaseProvider("plain", "https://api.example.com")
	cases := map[string]Dependencies{
		"缺 Provider": {Path: "/v1/chat/completions", Client: http.DefaultClient, Clock: fixedClock},
		"缺 Path":     {Provider: base, Client: http.DefaultClient, Clock: fixedClock},
		"缺 Client":   {Provider: base, Path: "/v1/chat/completions", Clock: fixedClock},
		"缺 Clock":    {Provider: base, Path: "/v1/chat/completions", Client: http.DefaultClient},
	}
	for name, dependencies := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := NewHandler(dependencies); err == nil {
				t.Fatal("必须返回错误而不是装配出半成品")
			}
		})
	}
}

// TestWriteRelayErrorUsesOpenAIEnvelope 守网关自有错误的形态与客户端协议一致。
func TestWriteRelayErrorUsesOpenAIEnvelope(t *testing.T) {
	recorder := &fakeResponseWriter{header: http.Header{}}
	WriteRelayError(recorder, http.StatusServiceUnavailable, "relay_unavailable", "不可用")
	if recorder.status != http.StatusServiceUnavailable {
		t.Fatalf("状态码错误: %d", recorder.status)
	}
	fields, ok := DecodeRawObject(recorder.body)
	if !ok {
		t.Fatalf("错误体必须是 JSON 对象: %s", recorder.body)
	}
	errorObject, ok := DecodeRawObject(fields["error"])
	if !ok {
		t.Fatal("必须包在 error 对象里")
	}
	if code, _ := RawString(errorObject["code"]); code != "relay_unavailable" {
		t.Fatalf("错误码错误: %q", code)
	}
}

// fakeResponseWriter 是只记录写出内容的最小 ResponseWriter。
type fakeResponseWriter struct {
	header http.Header
	status int
	body   []byte
}

func (writer *fakeResponseWriter) Header() http.Header { return writer.header }

func (writer *fakeResponseWriter) WriteHeader(status int) { writer.status = status }

func (writer *fakeResponseWriter) Write(payload []byte) (int, error) {
	writer.body = append(writer.body, payload...)
	return len(payload), nil
}
