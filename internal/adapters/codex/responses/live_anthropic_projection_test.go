package responses

import (
	"context"
	"encoding/json"
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

// TestLiveCodexAnthropicThinkingRequest 使用真实 OAuth 验证 Anthropic thinking
// 意图进入 Codex 请求且正常完成；上游是否返回摘要由模型自行决定。
func TestLiveCodexAnthropicThinkingRequest(t *testing.T) {
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
		"messages":[{"role":"user","content":"Think carefully, then reply with exactly: AIH_REAL_ROUTE_OK"}],
		"thinking":{"type":"enabled","budget_tokens":1024,"display":"summarized"},
		"output_config":{"effort":"low"},
		"stream":true
	}`))
	if err != nil {
		t.Fatalf("Messages Decode() error = %v", err)
	}
	payload, err := encodeRequest(
		request,
		realCodexSmokeModel,
		credential.Kind(),
		requestProfileForModel(realCodexSmokeModel),
	)
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	var wire struct {
		Reasoning reasoningDTO `json:"reasoning"`
	}
	if json.Unmarshal(payload, &wire) != nil ||
		wire.Reasoning.Effort != "low" ||
		wire.Reasoning.Summary != "auto" {
		clear(payload)
		t.Fatal("Anthropic thinking 未投影为 Codex low/auto reasoning")
	}
	clear(payload)
	coordinator, recorder, transport := newRealCodexCoordinator(
		t,
		credential,
		realCodexSmokeModel,
	)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	events := make([]inference.StreamEvent, 0, 32)
	if err := coordinator.Execute(
		ctx,
		request,
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	); err != nil {
		t.Fatalf("真实 Codex Execute() error = %v", err)
	}

	var hasSummaryDelta bool
	var hasSummary bool
	var hasEncrypted bool
	var hasForeignReasoning bool
	for _, event := range events {
		if delta, ok := event.(inference.ReasoningDeltaEvent); ok &&
			delta.DeltaKind() == inference.ReasoningDeltaSummary {
			hasSummaryDelta = true
		}
		if completed, ok := event.(inference.ReasoningCompletedEvent); ok {
			switch completed.Content().ReasoningKind() {
			case inference.ReasoningSummary:
				hasSummary = true
			case inference.ReasoningEncrypted:
				hasEncrypted = true
			case inference.ReasoningThinking, inference.ReasoningRedacted:
				hasForeignReasoning = true
			}
		}
	}
	output := strings.TrimSpace(completedText(events))
	if recorder.successes != 1 ||
		len(recorder.failures) != 0 ||
		output != realCodexSmokeExpected ||
		hasForeignReasoning {
		t.Fatalf(
			"真实 Codex thinking 异常: http_status=%d success=%d failures=%d output=%q summary_delta=%t summary=%t encrypted=%t foreign_reasoning=%t wire=%v",
			transport.statusCode,
			recorder.successes,
			len(recorder.failures),
			output,
			hasSummaryDelta,
			hasSummary,
			hasEncrypted,
			hasForeignReasoning,
			transport.fingerprint(),
		)
	}
	t.Logf(
		"real_codex_anthropic_thinking model=%s request_reasoning=low/auto summary_delta=%t summary=%t encrypted=%t foreign_reasoning=false output=%q",
		realCodexSmokeModel,
		hasSummaryDelta,
		hasSummary,
		hasEncrypted,
		output,
	)
}
