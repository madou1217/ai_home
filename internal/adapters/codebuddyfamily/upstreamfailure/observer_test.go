package upstreamfailure

import (
	"errors"
	"net/http"
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

func TestParseEnvelope(t *testing.T) {
	cases := []struct {
		name      string
		status    int
		body      string
		envelope  bool
		code      int64
		message   string
		retryable bool
	}{
		{
			name:      "displayMsg zh wins",
			status:    403,
			body:      `{"code":10085,"msg":"请求不合法","displayMsg":{"en":"bad request","zh":"请求不合法（WAF）"}}`,
			envelope:  true,
			code:      10085,
			message:   "请求不合法（WAF）",
			retryable: true,
		},
		{
			name:      "msg fallback",
			status:    400,
			body:      `{"code":11128,"msg":"first message is not system prompt"}`,
			envelope:  true,
			code:      11128,
			message:   "first message is not system prompt",
			retryable: true,
		},
		{
			// 渠道校验（2026-10-21 真上游实测文案）：请求形态被拦、与账号无关，换号只会拿到
			// 同一张拒绝并给每个账号挂冷却，因此即便同为 11128 也必须不可重试。
			name:      "channel verification 11128 is not retryable",
			status:    400,
			body:      `{"code":11128,"msg":"request illegal","displayMsg":{"en":"Request blocked. Please send it again","zh":"请求被拦截，请重新发送"}}`,
			envelope:  true,
			code:      11128,
			message:   "请求被拦截，请重新发送",
			retryable: false,
		},
		{
			name:      "unknown code is not retryable",
			status:    400,
			body:      `{"code":12345,"msg":"whatever"}`,
			envelope:  true,
			code:      12345,
			message:   "whatever",
			retryable: false,
		},
		{
			name:      "missing message falls back to code",
			status:    400,
			body:      `{"code":99999}`,
			envelope:  true,
			code:      99999,
			message:   "upstream_code_99999",
			retryable: false,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			envelope := ParseEnvelope(testCase.status, []byte(testCase.body))
			if envelope.Present != testCase.envelope {
				t.Fatalf("Present = %v，期望 %v", envelope.Present, testCase.envelope)
			}
			if envelope.Code == nil || *envelope.Code != testCase.code {
				t.Fatalf("Code = %v，期望 %d", envelope.Code, testCase.code)
			}
			if envelope.Message != testCase.message {
				t.Fatalf("Message = %q，期望 %q", envelope.Message, testCase.message)
			}
			if envelope.Retryable != testCase.retryable {
				t.Fatalf("Retryable = %v，期望 %v", envelope.Retryable, testCase.retryable)
			}
		})
	}
	// 非信封：HTML 401 用正文 + 状态码，标准 OpenAI 错误体交给调用方。
	html := ParseEnvelope(401, []byte("<html>401 Authorization Required</html>"))
	if html.Present || html.Code != nil || html.Retryable {
		t.Fatalf("HTML 响应不应被当成信封: %+v", html)
	}
	if html.Message == "" {
		t.Fatal("非信封应透出正文")
	}
	if openai := ParseEnvelope(400, []byte(`{"error":{"message":"bad tool_choice"}}`)); openai.Present || openai.Message != "" {
		t.Fatalf("非信封对象应交给调用方原样处理: %+v", openai)
	}
}

func TestClassifyMapsStatusAndEnvelope(t *testing.T) {
	retryable := Envelope{Present: true, Retryable: true}
	cases := []struct {
		name   string
		status int
		env    Envelope
		kind   runtimecore.FailureKind
	}{
		{"WAF 可重试信封码优先于状态码", 403, retryable, runtimecore.FailureUpstreamUnavailable},
		{"429 限流", 429, Envelope{}, runtimecore.FailureRateLimited},
		{"401 凭据被拒", 401, Envelope{}, runtimecore.FailureCredentialRejected},
		{"403 非可重试即权限", 403, Envelope{}, runtimecore.FailurePermissionDenied},
		{"400 请求不合法", 400, Envelope{}, runtimecore.FailureInvalidRequest},
		{"404 未找到", 404, Envelope{}, runtimecore.FailureNotFound},
		{"503 上游不可用", 503, Envelope{}, runtimecore.FailureUpstreamUnavailable},
		{"认不出的状态码不猜", 418, Envelope{}, runtimecore.FailureUnclassified},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			classification, err := Classify(testCase.status, testCase.env)
			if err != nil {
				t.Fatalf("分类失败: %v", err)
			}
			if classification.Kind() != testCase.kind {
				t.Fatalf("kind = %s，期望 %s", classification.Kind(), testCase.kind)
			}
		})
	}
	// 权限类必须带阻塞指令（账号模型级），否则运行态只会冷却不会挡住。
	blocked, err := Classify(403, Envelope{})
	if err != nil || !blocked.BlockDirective().IsValidFor(runtimecore.FailurePermissionDenied) {
		t.Fatalf("403 应带账号模型级阻塞指令: %+v (%v)", blocked, err)
	}
}

func TestObserveHTTPRequiresFailureEvidence(t *testing.T) {
	// 2xx 且信封不可重试 → 没有失败证据（普通 200 正文绝不能被改写成失败）。
	if _, err := ObserveHTTP(200, nil, []byte(`{"code":12345,"msg":"ok"}`), time.Now()); !errors.Is(err, sharedfailure.ErrNoFailureEvidence) {
		t.Fatalf("200 正文不应构成失败证据，实际 %v", err)
	}
	// 2xx 但信封声明可重试 → 上游行为变了（例如又要求非流式），必须留下证据。
	classification, err := ObserveHTTP(200, nil, []byte(`{"code":11101,"msg":"non-stream"}`), time.Now())
	if err != nil || classification.Kind() != runtimecore.FailureUpstreamUnavailable {
		t.Fatalf("可重试信封码应构成失败证据: %+v (%v)", classification, err)
	}
	// 非 2xx 一律有证据。
	if _, err := ObserveHTTP(503, nil, nil, time.Now()); err != nil {
		t.Fatalf("503 应可分类: %v", err)
	}
	if _, err := ObserveHTTP(0, nil, nil, time.Now()); !errors.Is(err, ErrInvalidObservation) {
		t.Fatalf("无状态码应报 ErrInvalidObservation，实际 %v", err)
	}
}

func TestObserveHTTPHonoursRetryAfterWithinBounds(t *testing.T) {
	header := http.Header{}
	header.Set("Retry-After", "7")
	classification, err := ObserveHTTP(429, header, nil, time.Now())
	if err != nil {
		t.Fatalf("分类失败: %v", err)
	}
	if classification.Kind() != runtimecore.FailureRateLimited || classification.RetryAfter() != 7*time.Second {
		t.Fatalf("应采纳 7 秒 Retry-After: %+v", classification)
	}
	// 超出上限的提示被忽略，避免上游用超长值绕过冷却上限。
	huge := http.Header{}
	huge.Set("Retry-After", "999999")
	ignored, err := ObserveHTTP(429, huge, nil, time.Now())
	if err != nil {
		t.Fatalf("分类失败: %v", err)
	}
	if ignored.RetryAfter() != 0 {
		t.Fatalf("超长 Retry-After 应被忽略，实际 %v", ignored.RetryAfter())
	}
	// 非法值不影响分类本身。
	invalid := http.Header{}
	invalid.Set("Retry-After", "not-a-number")
	if _, err := ObserveHTTP(429, invalid, nil, time.Now()); err != nil {
		t.Fatalf("非法 Retry-After 不应影响分类: %v", err)
	}
}

// TestObserveHTTPRecognizesEdgeRejection 固化 2026-10-15 事故：站点边缘按**请求形态**拒绝
// （server: APISIX/* + 单键 message 信封 / WAF 拦截页）与账号凭据无关，换号只会拿到同一张
// 拒绝——绝不能判成凭据失效给健康账号挂硬阻塞。
func TestObserveHTTPRecognizesEdgeRejection(t *testing.T) {
	apisix := http.Header{}
	apisix.Set("Server", "APISIX/3.9.1")
	classification, err := ObserveHTTP(
		http.StatusUnauthorized,
		apisix,
		[]byte(`{"message":"invalid_format"}`),
		time.Now(),
	)
	if err != nil {
		t.Fatalf("边缘拒绝应可分类: %v", err)
	}
	if classification.Kind() != runtimecore.FailureUpstreamEdgeRejected {
		t.Fatalf("401 invalid_format 不应判成凭据失效: %+v", classification)
	}
	// 边缘文案谈凭据时仍按凭据处理（避免把厂商真正的 401 吞掉）。
	credentialShaped, err := ObserveHTTP(
		http.StatusUnauthorized,
		apisix,
		[]byte(`{"message":"token expired"}`),
		time.Now(),
	)
	if err != nil || credentialShaped.Kind() != runtimecore.FailureCredentialRejected {
		t.Fatalf("凭据语义的 401 仍应按凭据拒绝: %+v (%v)", credentialShaped, err)
	}
	// WAF 拦截页（cf-mitigated / HTML 正文）同样与账号无关。
	waf := http.Header{}
	waf.Set("Cf-Mitigated", "challenge")
	blocked, err := ObserveHTTP(
		http.StatusForbidden,
		waf,
		[]byte("<!DOCTYPE html><html><body>blocked</body></html>"),
		time.Now(),
	)
	if err != nil || blocked.Kind() != runtimecore.FailureUpstreamEdgeRejected {
		t.Fatalf("WAF 拦截页不应判成账号问题: %+v (%v)", blocked, err)
	}
}
