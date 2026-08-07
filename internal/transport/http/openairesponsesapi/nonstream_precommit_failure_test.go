package openairesponsesapi

import (
	"net/http"
	"strings"
	"testing"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

// TestHandlerReturnsCanonicalFailureBeforeNonStreamStarts 锁定「启动前失败 ×
// 非流式」这一格：上游在第一个字节之前限流时，Adapter 一个事件都不会发，
// Coordinator 只能补序号为 0 的 ResponseFailedEvent。该事件必须绕开聚合器，
// 否则 Canonical 状态机判序号非法，真实 429 会被改写成 502 invalid_upstream_response，
// 客户端据此立即重试，与限流要求的退避语义完全相反。
func TestHandlerReturnsCanonicalFailureBeforeNonStreamStarts(t *testing.T) {
	t.Parallel()

	failure, err := inference.NewResponseFailure(
		string(runtimecore.FailureRateLimited),
		"Please retry later",
		true,
	)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	failed, err := inference.NewResponseFailedEvent(0, failure)
	if err != nil {
		t.Fatalf("NewResponseFailedEvent() error = %v", err)
	}
	executor := newScriptedExecutor(
		[]inference.StreamEvent{failed},
		nil,
	)
	baseURL, client := startResponsesServer(t, executor, 0)
	response := performResponsesRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testBearerToken,
		"application/json",
		minimalRequestBody(false),
	)

	if response.status != http.StatusTooManyRequests ||
		!strings.Contains(response.body, `"type":"rate_limit_error"`) ||
		!strings.Contains(response.body, `"code":"rate_limited"`) ||
		!strings.Contains(response.body, `"message":"Please retry later"`) ||
		strings.Contains(response.body, "invalid_upstream_response") {
		t.Fatalf("pre-commit non-stream failure response = %#v", response)
	}
}
