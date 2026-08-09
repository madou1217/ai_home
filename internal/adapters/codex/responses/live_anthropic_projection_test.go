package responses

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/anthropicmessages"
)

// TestLiveCodexAnthropicProjectionSmoke 使用真实 Codex OAuth 验证
// Anthropic system 与用户消息经过 Canonical 后仍满足 Codex 线协议。
func TestLiveCodexAnthropicProjectionSmoke(t *testing.T) {
	if os.Getenv("AIH_REAL_CODEX_SMOKE") != "1" {
		t.Skip("设置 AIH_REAL_CODEX_SMOKE=1 后才允许真实上游请求")
	}

	credential := loadRealCodexCredential(t)
	status := inspectRealCodexCredential(credential, time.Now())
	if status.refreshDue {
		t.Fatal("真实 Codex Access Token 已进入刷新窗口，本测试禁止隐式刷新")
	}
	request, err := anthropicmessages.NewAdapter().Decode([]byte(`{
		"model":"aih-real-route-smoke",
		"max_tokens":4096,
		"system":"Return only the exact marker requested by the user.",
		"messages":[{"role":"user","content":"Reply with exactly: AIH_REAL_ROUTE_OK"}],
		"stream":false
	}`))
	if err != nil {
		t.Fatalf("Messages Decode() error = %v", err)
	}
	coordinator, recorder, transport := newRealCodexCoordinator(
		t,
		credential,
		realCodexSmokeModel,
	)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	events := make([]inference.StreamEvent, 0, 16)
	err = coordinator.Execute(
		ctx,
		request,
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("真实 Codex Execute() error = %v", err)
	}
	output := completedText(events)
	if recorder.successes != 1 ||
		len(recorder.failures) != 0 ||
		strings.TrimSpace(output) != realCodexSmokeExpected {
		responseCode, safeMessage, retryable :=
			realCodexResponseFailure(events)
		runtimeKind, retryAfter :=
			realCodexAttemptFailure(recorder.failures)
		t.Fatalf(
			"真实 Anthropic 投影异常: http_status=%d media_type=%s success=%d failures=%d events=%v response_code=%s safe_message=%q retryable=%t runtime_kind=%s retry_after=%s wire=%v output=%q",
			transport.statusCode,
			transport.mediaType,
			recorder.successes,
			len(recorder.failures),
			eventKindsForAdapter(events),
			responseCode,
			safeMessage,
			retryable,
			runtimeKind,
			retryAfter,
			transport.fingerprint(),
			output,
		)
	}
}
