package upstreamfailure

import (
	"io"
	"net/http"
	"strings"
	"testing"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// TestObserveEdgeRejectionRecognizesEdgeShapes 固化两类边缘拒绝（WAF 拦截页 / 网关
// 请求格式拒绝）的识别形状。镜像 Node test/upstream-edge-block.test.js 的用例集。
func TestObserveEdgeRejectionRecognizesEdgeShapes(t *testing.T) {
	t.Parallel()

	const apisixServer = "APISIX/3.9.1"
	const cloudflarePage = "<!DOCTYPE html><html lang=\"en-US\"><head><title>Just a moment...</title></head><body>cf challenge</body></html>"

	tests := []struct {
		name       string
		statusCode int
		header     http.Header
		body       string
		want       bool
	}{
		{
			name:       "APISIX 请求格式拒绝",
			statusCode: http.StatusUnauthorized,
			header:     http.Header{"Server": {apisixServer}, "Content-Type": {"text/plain"}},
			body:       `{"message":"invalid_format"}`,
			want:       true,
		},
		{
			name:       "Cloudflare HTML 拦截页",
			statusCode: http.StatusForbidden,
			header:     http.Header{"Content-Type": {"text/html; charset=UTF-8"}, "Cf-Ray": {"a455e65de9d080ef-NRT"}},
			body:       cloudflarePage,
			want:       true,
		},
		{
			name:       "cf-mitigated 挑战头",
			statusCode: http.StatusForbidden,
			header:     http.Header{"Cf-Mitigated": {"challenge"}},
			body:       "",
			want:       true,
		},
		{
			name:       "text/html 但正文是 JSON",
			statusCode: http.StatusForbidden,
			header:     http.Header{"Content-Type": {"text/html"}},
			body:       `{"error":{"message":"slow down"}}`,
			want:       false,
		},
		{
			name:       "边缘文案谈凭据（仍按凭据处理）",
			statusCode: http.StatusUnauthorized,
			header:     http.Header{"Server": {apisixServer}},
			body:       `{"message":"token expired"}`,
			want:       false,
		},
		{
			name:       "家族错误信封不是单键 message",
			statusCode: http.StatusUnauthorized,
			header:     http.Header{"Server": {apisixServer}},
			body:       `{"code":11128,"msg":"Illegal API invocation from an unapproved channel"}`,
			want:       false,
		},
		{
			name:       "无网关签名头",
			statusCode: http.StatusUnauthorized,
			header:     http.Header{"Content-Type": {"application/json"}},
			body:       `{"message":"invalid_format"}`,
			want:       false,
		},
		{
			name:       "message 非字符串",
			statusCode: http.StatusUnauthorized,
			header:     http.Header{"Server": {apisixServer}},
			body:       `{"message":{"nested":true}}`,
			want:       false,
		},
		{
			name:       "多键信封",
			statusCode: http.StatusUnauthorized,
			header:     http.Header{"Server": {apisixServer}},
			body:       `{"message":"invalid_format","extra":1}`,
			want:       false,
		},
		{
			name:       "正文不是 JSON",
			statusCode: http.StatusUnauthorized,
			header:     http.Header{"Server": {apisixServer}},
			body:       `{not json`,
			want:       false,
		},
		{
			name:       "5xx 上的 HTML 不进入边缘判定",
			statusCode: http.StatusInternalServerError,
			header:     http.Header{"Content-Type": {"text/html"}},
			body:       cloudflarePage,
			want:       false,
		},
		{
			name:       "2xx 上的 HTML 不进入边缘判定",
			statusCode: http.StatusOK,
			header:     http.Header{"Content-Type": {"text/html"}},
			body:       cloudflarePage,
			want:       false,
		},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			classification, rejected := ObserveEdgeRejection(
				testCase.statusCode,
				testCase.header,
				[]byte(testCase.body),
			)
			if rejected != testCase.want {
				t.Fatalf("rejected = %v, want %v", rejected, testCase.want)
			}
			if !testCase.want {
				return
			}
			if classification.Kind() != runtimecore.FailureUpstreamEdgeRejected {
				t.Fatalf("kind = %q", classification.Kind())
			}
			policy, err := runtimecore.PolicyFor(classification.Kind())
			if err != nil {
				t.Fatalf("PolicyFor() error = %v", err)
			}
			if policy.Action() != runtimecore.ActionNoStateChange || policy.BlocksRouting() {
				t.Fatalf("policy = %#v", policy)
			}
			if classification.RetryAfter() != 0 || !classification.BlockDirective().IsZero() {
				t.Fatalf("classification = %#v", classification)
			}
		})
	}
}

// TestObserveEdgeRejectionResponseReplaysBody 验证响应级入口在判定后回放同一份字节，
// 观察器的后续解析（以及调用方关闭语义）与没有预读时逐字节等价。
func TestObserveEdgeRejectionResponseReplaysBody(t *testing.T) {
	t.Parallel()

	const body = `{"message":"invalid_format"}   `
	response := &http.Response{
		StatusCode: http.StatusUnauthorized,
		Header:     http.Header{"Server": {"APISIX/3.9.1"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
	_, rejected := ObserveEdgeRejectionResponse(response)
	if !rejected {
		t.Fatal("expected edge rejection")
	}
	replayed, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("ReadAll() error = %v", err)
	}
	if string(replayed) != body {
		t.Fatalf("replayed = %q, want %q", replayed, body)
	}
}

// TestObserveEdgeRejectionResponseKeepsNonEdgeBody 验证未命中时正文同样完整回放，
// 后续的正常分类路径看到原始字节。
func TestObserveEdgeRejectionResponseKeepsNonEdgeBody(t *testing.T) {
	t.Parallel()

	const body = `{"error":{"message":"token expired"}}`
	response := &http.Response{
		StatusCode: http.StatusUnauthorized,
		Header:     http.Header{"Content-Type": {"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
	if _, rejected := ObserveEdgeRejectionResponse(response); rejected {
		t.Fatal("did not expect edge rejection")
	}
	replayed, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("ReadAll() error = %v", err)
	}
	if string(replayed) != body {
		t.Fatalf("replayed = %q, want %q", replayed, body)
	}
}

// TestObserveEdgeRejectionResponseSkipsOtherStatuses 验证非 401/403 响应不预读正文，
// 观察器保持对其它状态码的既有读取行为。
func TestObserveEdgeRejectionResponseSkipsOtherStatuses(t *testing.T) {
	t.Parallel()

	body := io.NopCloser(strings.NewReader(`{"message":"invalid_format"}`))
	response := &http.Response{
		StatusCode: http.StatusTooManyRequests,
		Header:     http.Header{"Server": {"APISIX/3.9.1"}},
		Body:       body,
	}
	if _, rejected := ObserveEdgeRejectionResponse(response); rejected {
		t.Fatal("did not expect edge rejection")
	}
	if response.Body != body {
		t.Fatal("body must stay untouched for non 401/403 statuses")
	}
}
