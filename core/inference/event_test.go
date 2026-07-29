package inference

import (
	"bytes"
	"errors"
	"testing"
)

// TestStreamEventsPreserveTypedDeltasAndCompletion 验证流式事件分别表达文本、
// thinking、signature、工具参数和完成状态，不依赖 Provider JSON。
func TestStreamEventsPreserveTypedDeltasAndCompletion(t *testing.T) {
	t.Parallel()

	start, err := NewResponseStartedEvent(0, "response_exact_1", "gpt-5.6-sol")
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	textDelta, err := NewTextDeltaEvent(1, 0, 0, "正在分析")
	if err != nil {
		t.Fatalf("NewTextDeltaEvent() error = %v", err)
	}
	thinkingDelta, err := NewReasoningDeltaEvent(2, 0, 1, ReasoningDeltaThinking, "先检查")
	if err != nil {
		t.Fatalf("NewReasoningDeltaEvent() error = %v", err)
	}
	signatureDelta, err := NewReasoningDeltaEvent(3, 0, 1, ReasoningDeltaSignature, "sig_")
	if err != nil {
		t.Fatalf("NewReasoningDeltaEvent() signature error = %v", err)
	}
	argumentsDelta, err := NewToolArgumentsDeltaEvent(4, 0, 2, "call_exact_1", `{"query"`)
	if err != nil {
		t.Fatalf("NewToolArgumentsDeltaEvent() error = %v", err)
	}
	usage, err := NewUsage(UsageInput{InputTokens: 10, OutputTokens: 4})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	completed, err := NewResponseCompletedEvent(5, StopReasonEndTurn, "", usage)
	if err != nil {
		t.Fatalf("NewResponseCompletedEvent() error = %v", err)
	}

	events := []StreamEvent{start, textDelta, thinkingDelta, signatureDelta, argumentsDelta, completed}
	expectedKinds := []EventKind{
		EventResponseStarted,
		EventTextDelta,
		EventReasoningDelta,
		EventReasoningDelta,
		EventToolArgumentsDelta,
		EventResponseCompleted,
	}
	for index, event := range events {
		if event.Kind() != expectedKinds[index] || event.Sequence() != uint64(index) {
			t.Fatalf("event[%d] = (%q, %d), want (%q, %d)", index, event.Kind(), event.Sequence(), expectedKinds[index], index)
		}
	}
	if thinkingDelta.DeltaKind() == signatureDelta.DeltaKind() {
		t.Fatal("thinking delta 与 signature delta 必须保持不同类型")
	}
}

// TestToolCallCompletedEventOwnsArgumentsSnapshot 验证工具调用最终参数不会被
// Decoder 的复用缓冲区修改。
func TestToolCallCompletedEventOwnsArgumentsSnapshot(t *testing.T) {
	t.Parallel()

	arguments := []byte(`{"query":"codex"}`)
	event, err := NewToolCallCompletedEvent(3, 0, 1, "call_exact_1", "lookup", arguments)
	if err != nil {
		t.Fatalf("NewToolCallCompletedEvent() error = %v", err)
	}
	arguments[0] = '['
	firstRead := event.Arguments()
	firstRead[0] = '['
	if !bytes.Equal(event.Arguments(), []byte(`{"query":"codex"}`)) {
		t.Fatalf("ToolCallCompletedEvent.Arguments() = %s, want immutable object", event.Arguments())
	}
}

// TestReasoningCompletedEventPreservesEncryptedContinuity 验证只在完成响应中出现的
// 加密 reasoning 仍以独立事件保留，不会被降级为普通文本或丢弃。
func TestReasoningCompletedEventPreservesEncryptedContinuity(t *testing.T) {
	t.Parallel()

	encrypted, err := NewEncryptedReasoningContent("encrypted_continuity_exact_1")
	if err != nil {
		t.Fatalf("NewEncryptedReasoningContent() error = %v", err)
	}
	event, err := NewReasoningCompletedEvent(2, 0, 1, encrypted)
	if err != nil {
		t.Fatalf("NewReasoningCompletedEvent() error = %v", err)
	}
	if event.Kind() != EventReasoningCompleted ||
		event.Content().ReasoningKind() != ReasoningEncrypted ||
		event.Content().EncryptedData() != "encrypted_continuity_exact_1" {
		t.Fatalf("reasoning event = %#v, want encrypted continuity", event)
	}
}

// TestOutputItemEventsPreserveStableItemIdentity 验证 Responses Renderer 可以通过
// output index 找回真实 item ID，而不是临时生成一个新标识。
func TestOutputItemEventsPreserveStableItemIdentity(t *testing.T) {
	t.Parallel()

	started, err := NewOutputItemStartedEvent(1, 0, "msg_exact_1", OutputItemMessage)
	if err != nil {
		t.Fatalf("NewOutputItemStartedEvent() error = %v", err)
	}
	completed, err := NewOutputItemCompletedEvent(4, 0, "msg_exact_1")
	if err != nil {
		t.Fatalf("NewOutputItemCompletedEvent() error = %v", err)
	}
	if started.ItemID() != completed.ItemID() ||
		started.OutputIndex() != completed.OutputIndex() ||
		started.ItemKind() != OutputItemMessage {
		t.Fatalf("output item identity changed: started=%#v completed=%#v", started, completed)
	}
}

// TestRefusalEventsRemainDistinctFromTextEvents 验证 refusal 增量和终值具有独立事件类型。
func TestRefusalEventsRemainDistinctFromTextEvents(t *testing.T) {
	t.Parallel()

	delta, err := NewRefusalDeltaEvent(2, 0, 0, "无法")
	if err != nil {
		t.Fatalf("NewRefusalDeltaEvent() error = %v", err)
	}
	completed, err := NewRefusalCompletedEvent(3, 0, 0, "无法协助")
	if err != nil {
		t.Fatalf("NewRefusalCompletedEvent() error = %v", err)
	}
	if delta.Kind() != EventRefusalDelta || completed.Kind() != EventRefusalCompleted {
		t.Fatalf("refusal events = (%q, %q), want distinct refusal kinds", delta.Kind(), completed.Kind())
	}
}

// TestStreamEventsRejectSyntheticSuccessInputs 验证完成事件不能缺结束原因，
// 增量事件也不能用空值伪造有效输出。
func TestStreamEventsRejectSyntheticSuccessInputs(t *testing.T) {
	t.Parallel()

	usage, err := NewUsage(UsageInput{})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	if _, err := NewResponseCompletedEvent(1, "", "", usage); !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("missing stop reason error = %v, want ErrInvalidEvent", err)
	}
	if _, err := NewTextDeltaEvent(1, 0, 0, ""); !errors.Is(err, ErrInvalidEvent) {
		t.Fatalf("empty text delta error = %v, want ErrInvalidEvent", err)
	}
}

// TestResponseCompletedEventPreservesPauseTurn 验证 Anthropic 长任务暂停语义
// 不会被降级为普通 end_turn。
func TestResponseCompletedEventPreservesPauseTurn(t *testing.T) {
	t.Parallel()

	usage, err := NewUsage(UsageInput{InputTokens: 3, OutputTokens: 2})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	event, err := NewResponseCompletedEvent(1, StopReasonPauseTurn, "", usage)
	if err != nil {
		t.Fatalf("NewResponseCompletedEvent() error = %v", err)
	}
	if event.StopReason() != StopReasonPauseTurn {
		t.Fatalf("StopReason() = %q, want %q", event.StopReason(), StopReasonPauseTurn)
	}
}
