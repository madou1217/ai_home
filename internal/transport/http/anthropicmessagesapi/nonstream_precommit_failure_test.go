package anthropicmessagesapi

import (
	"net/http"
	"strings"
	"testing"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

// TestHandlerReturnsCanonicalFailureBeforeNonStreamStarts 与两个 OpenAI 协议入口
// 共用同一份非流式启动前失败合同：真实上游状态码必须原样映射，不得被 Canonical
// 状态机的序号校验改写成 502。这里锁住三入口行为一致，防止 Messages 侧回退。
func TestHandlerReturnsCanonicalFailureBeforeNonStreamStarts(t *testing.T) {
	t.Parallel()

	failure, err := inference.NewResponseFailure(
		string(runtimecore.FailureRateLimited),
		"上游请求频率受限",
		true,
	)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	failed, err := inference.NewResponseFailedEvent(0, failure)
	if err != nil {
		t.Fatalf("NewResponseFailedEvent() error = %v", err)
	}
	baseURL, client := startMessagesServer(
		t,
		newScriptedExecutor([]inference.StreamEvent{failed}, nil),
		0,
	)
	response := performMessagesRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testAPIKey,
		minimalRequestBody(false),
	)

	if response.status != http.StatusTooManyRequests ||
		!strings.Contains(response.body, `"type":"rate_limit_error"`) ||
		!strings.Contains(response.body, `"message":"上游请求频率受限"`) ||
		strings.Contains(response.body, "Invalid upstream response") {
		t.Fatalf("pre-commit non-stream failure response = %#v", response)
	}
}
