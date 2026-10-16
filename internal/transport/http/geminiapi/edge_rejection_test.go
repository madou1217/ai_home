package geminiapi_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

// failedEventExecutor 只回放一个预置事件：用于验证失败码到 Google 风格状态的映射。
type failedEventExecutor struct{ event inference.StreamEvent }

// Execute 原样发出预置事件，不产生任何其它事件。
func (executor *failedEventExecutor) Execute(
	_ context.Context,
	_ inference.Request,
	emit inferencegateway.EventSink,
) error {
	return emit(executor.event)
}

// TestHandlerDeliversEdgeRejectionAsGatewayError 验证站点边缘拒绝在 Gemini 客户协议上
// 交付 502 INTERNAL，而不是 400 INVALID_ARGUMENT——后者会把上游边缘问题（WAF 拦截页 /
// 网关请求格式拒绝）说成「请求非法」，与 Node 及其它客户协议编码器语义不一致。
func TestHandlerDeliversEdgeRejectionAsGatewayError(t *testing.T) {
	t.Parallel()

	edgeFailure, err := inference.NewResponseFailure(
		string(runtimecore.FailureUpstreamEdgeRejected),
		"上游站点边缘拒绝了本次请求",
		false,
	)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	edgeEvent, err := inference.NewResponseFailedEvent(0, edgeFailure)
	if err != nil {
		t.Fatalf("NewResponseFailedEvent() error = %v", err)
	}
	response := serveFailedEvent(t, edgeEvent)
	if response.Code != http.StatusBadGateway {
		t.Fatalf("status = %d body = %s", response.Code, response.Body)
	}
	body := response.Body.String()
	if !strings.Contains(body, `"status":"INTERNAL"`) || !strings.Contains(body, `"message":"上游站点边缘拒绝了本次请求"`) {
		t.Fatalf("body = %s", body)
	}
	if strings.Contains(body, "INVALID_ARGUMENT") {
		t.Fatalf("edge rejection must not be reported as an invalid request: %s", body)
	}

	// 对照：非边缘的不可重试失败仍按 400 INVALID_ARGUMENT 交付，分支只针对边缘拒绝。
	otherFailure, err := inference.NewResponseFailure(
		string(runtimecore.FailureReauthenticationRequired),
		"需要重新登录",
		false,
	)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	otherEvent, err := inference.NewResponseFailedEvent(0, otherFailure)
	if err != nil {
		t.Fatalf("NewResponseFailedEvent() error = %v", err)
	}
	other := serveFailedEvent(t, otherEvent)
	if other.Code != http.StatusBadRequest || !strings.Contains(other.Body.String(), `"status":"INVALID_ARGUMENT"`) {
		t.Fatalf("non-edge non-retryable failure response = %d %s", other.Code, other.Body)
	}
}

// serveFailedEvent 经真实 Handler 交付一个启动前失败事件，返回记录到的响应。
func serveFailedEvent(t *testing.T, event inference.StreamEvent) *httptest.ResponseRecorder {
	t.Helper()

	handler := newTestHandler(t, &failedEventExecutor{event: event})
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/models/m:generateContent",
		strings.NewReader(`{"contents":[{"role":"user","parts":[{"text":"x"}]}]}`),
	)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("x-api-key", testAPIKey)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
