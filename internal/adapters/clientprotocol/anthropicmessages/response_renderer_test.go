package anthropicmessages

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// TestStreamRendererProducesExactTextLifecycle 验证文本后缀、内容索引、usage
// 拆分和 Messages 生命周期事件完整。
func TestStreamRendererProducesExactTextLifecycle(t *testing.T) {
	t.Parallel()

	frames := renderAll(t, NewStreamRenderer(newRendererTestRequest(t)), newTextResponseEvents(t))
	assertEventNames(t, frames, []string{
		"message_start",
		"content_block_start",
		"content_block_delta",
		"content_block_delta",
		"content_block_stop",
		"message_delta",
		"message_stop",
	})

	var firstDelta streamEventWireDTO
	if err := json.Unmarshal(frames[2].Data(), &firstDelta); err != nil {
		t.Fatalf("unmarshal first delta error = %v", err)
	}
	var firstText textDeltaWireDTO
	if err := json.Unmarshal(firstDelta.Delta, &firstText); err != nil {
		t.Fatalf("unmarshal first text error = %v", err)
	}
	var suffixDelta streamEventWireDTO
	if err := json.Unmarshal(frames[3].Data(), &suffixDelta); err != nil {
		t.Fatalf("unmarshal suffix delta error = %v", err)
	}
	var suffixText textDeltaWireDTO
	if err := json.Unmarshal(suffixDelta.Delta, &suffixText); err != nil {
		t.Fatalf("unmarshal suffix text error = %v", err)
	}
	if firstText.Text != "你" || suffixText.Text != "好" {
		t.Fatalf("text deltas = (%q, %q), want exact suffixes", firstText.Text, suffixText.Text)
	}

	var completed streamEventWireDTO
	if err := json.Unmarshal(frames[5].Data(), &completed); err != nil {
		t.Fatalf("unmarshal message_delta error = %v", err)
	}
	var delta messageDeltaWireDTO
	if err := json.Unmarshal(completed.Delta, &delta); err != nil {
		t.Fatalf("unmarshal completion delta error = %v", err)
	}
	if delta.StopReason != "end_turn" || delta.StopSequence != nil {
		t.Fatalf("completion delta = %#v, want end_turn", delta)
	}
	if completed.Usage == nil ||
		completed.Usage.InputTokens != 70 ||
		completed.Usage.CacheCreationInputTokens != 10 ||
		completed.Usage.CacheReadInputTokens != 20 ||
		completed.Usage.OutputTokens != 2 {
		t.Fatalf("usage = %#v, want Anthropic partition", completed.Usage)
	}
}

// TestResponseAggregatorProducesCompleteMessage 验证非流式响应与流式 Renderer
// 复用同一事件解释，并输出当前 Messages SDK 的完整基础字段。
func TestResponseAggregatorProducesCompleteMessage(t *testing.T) {
	t.Parallel()

	aggregator := NewResponseAggregator(newRendererTestRequest(t))
	for _, event := range newTextResponseEvents(t) {
		if err := aggregator.Add(event); err != nil {
			t.Fatalf("Add(%q) error = %v", event.Kind(), err)
		}
	}
	data, err := aggregator.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	var message messageWireDTO
	if err := json.Unmarshal(data, &message); err != nil {
		t.Fatalf("unmarshal message error = %v", err)
	}
	if message.ID != "msg_exact_1" ||
		message.Type != "message" ||
		message.Role != "assistant" ||
		message.Model != "claude-opus-4-6" ||
		message.StopReason == nil ||
		*message.StopReason != "end_turn" ||
		message.Container != nil {
		t.Fatalf("message basics = %#v, want completed Message", message)
	}
	if len(message.Content) != 1 {
		t.Fatalf("content length = %d, want 1", len(message.Content))
	}
	var text textBlockWireDTO
	if err := json.Unmarshal(message.Content[0], &text); err != nil {
		t.Fatalf("unmarshal text block error = %v", err)
	}
	if text.Type != "text" || text.Text != "你好" || text.Citations != nil {
		t.Fatalf("text block = %#v, want exact text with null citations", text)
	}
	if message.Usage.InputTokens != 70 ||
		message.Usage.CacheCreationInputTokens != 10 ||
		message.Usage.CacheReadInputTokens != 20 ||
		message.Usage.OutputTokens != 2 {
		t.Fatalf("usage = %#v, want exact partition", message.Usage)
	}
}

// TestRenderersPreserveThinkingTextAndToolOrder 验证 signed thinking、普通文本、
// 工具参数和最终 tool_use 原因在流式及非流式输出中顺序一致。
func TestRenderersPreserveThinkingTextAndToolOrder(t *testing.T) {
	t.Parallel()

	request := newRendererTestRequest(t)
	events := newThinkingTextToolResponseEvents(t)
	frames := renderAll(t, NewStreamRenderer(request), events)

	var blockTypes []string
	var blockIndexes []uint32
	var thinkingText strings.Builder
	var signature strings.Builder
	var toolArguments strings.Builder
	var finalReason string
	for _, frame := range frames {
		var wire streamEventWireDTO
		if err := json.Unmarshal(frame.Data(), &wire); err != nil {
			t.Fatalf("unmarshal %q error = %v", frame.Name(), err)
		}
		switch frame.Name() {
		case "content_block_start":
			var header contentHeaderDTO
			if err := json.Unmarshal(wire.ContentBlock, &header); err != nil {
				t.Fatalf("unmarshal content header error = %v", err)
			}
			blockTypes = append(blockTypes, header.Type)
			blockIndexes = append(blockIndexes, *wire.Index)
		case "content_block_delta":
			var header contentHeaderDTO
			if err := json.Unmarshal(wire.Delta, &header); err != nil {
				t.Fatalf("unmarshal delta header error = %v", err)
			}
			switch header.Type {
			case "thinking_delta":
				var delta thinkingDeltaWireDTO
				_ = json.Unmarshal(wire.Delta, &delta)
				thinkingText.WriteString(delta.Thinking)
			case "signature_delta":
				var delta signatureDeltaWireDTO
				_ = json.Unmarshal(wire.Delta, &delta)
				signature.WriteString(delta.Signature)
			case "input_json_delta":
				var delta inputJSONDeltaWireDTO
				_ = json.Unmarshal(wire.Delta, &delta)
				toolArguments.WriteString(delta.PartialJSON)
			}
		case "message_delta":
			var delta messageDeltaWireDTO
			if err := json.Unmarshal(wire.Delta, &delta); err != nil {
				t.Fatalf("unmarshal message delta error = %v", err)
			}
			finalReason = delta.StopReason
		}
	}
	if got, want := strings.Join(blockTypes, ","), "thinking,text,tool_use"; got != want {
		t.Fatalf("content block types = %q, want %q", got, want)
	}
	if len(blockIndexes) != 3 ||
		blockIndexes[0] != 0 ||
		blockIndexes[1] != 1 ||
		blockIndexes[2] != 2 {
		t.Fatalf("block indexes = %#v, want [0 1 2]", blockIndexes)
	}
	if thinkingText.String() != "先想" ||
		signature.String() != "sig_exact" ||
		toolArguments.String() != `{"account":"codex"}` ||
		finalReason != "tool_use" {
		t.Fatalf("stream values = thinking:%q signature:%q args:%q reason:%q",
			thinkingText.String(),
			signature.String(),
			toolArguments.String(),
			finalReason,
		)
	}

	aggregator := NewResponseAggregator(request)
	for _, event := range events {
		if err := aggregator.Add(event); err != nil {
			t.Fatalf("Add(%q) error = %v", event.Kind(), err)
		}
	}
	data, err := aggregator.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	var message messageWireDTO
	if err := json.Unmarshal(data, &message); err != nil {
		t.Fatalf("unmarshal message error = %v", err)
	}
	if len(message.Content) != 3 {
		t.Fatalf("content length = %d, want 3", len(message.Content))
	}
	var thinking thinkingBlockWireDTO
	var text textBlockWireDTO
	var tool toolUseBlockWireDTO
	if err := json.Unmarshal(message.Content[0], &thinking); err != nil {
		t.Fatalf("unmarshal thinking error = %v", err)
	}
	if err := json.Unmarshal(message.Content[1], &text); err != nil {
		t.Fatalf("unmarshal text error = %v", err)
	}
	if err := json.Unmarshal(message.Content[2], &tool); err != nil {
		t.Fatalf("unmarshal tool error = %v", err)
	}
	if thinking.Thinking != "先想" ||
		thinking.Signature != "sig_exact" ||
		text.Text != "完成" ||
		tool.ID != "toolu_exact_1" ||
		tool.Name != "lookup" ||
		string(tool.Input) != `{"account":"codex"}` {
		t.Fatalf("aggregated content = thinking:%#v text:%#v tool:%#v", thinking, text, tool)
	}
}

// TestRenderersPreserveRedactedThinkingAndPauseTurn 验证加密 reasoning 不会被
// 转成普通文本，pause_turn 也不会被降级为 end_turn。
func TestRenderersPreserveRedactedThinkingAndPauseTurn(t *testing.T) {
	t.Parallel()

	request := newRendererTestRequest(t)
	events := newRedactedResponseEvents(t)
	frames := renderAll(t, NewStreamRenderer(request), events)
	assertEventNames(t, frames, []string{
		"message_start",
		"content_block_start",
		"content_block_stop",
		"message_delta",
		"message_stop",
	})
	var blockStart streamEventWireDTO
	if err := json.Unmarshal(frames[1].Data(), &blockStart); err != nil {
		t.Fatalf("unmarshal block start error = %v", err)
	}
	var redacted redactedThinkingBlockWireDTO
	if err := json.Unmarshal(blockStart.ContentBlock, &redacted); err != nil {
		t.Fatalf("unmarshal redacted block error = %v", err)
	}
	if redacted.Type != "redacted_thinking" || redacted.Data != "encrypted_exact_1" {
		t.Fatalf("redacted = %#v, want exact encrypted continuity", redacted)
	}
	var messageDelta streamEventWireDTO
	if err := json.Unmarshal(frames[3].Data(), &messageDelta); err != nil {
		t.Fatalf("unmarshal message delta error = %v", err)
	}
	var delta messageDeltaWireDTO
	_ = json.Unmarshal(messageDelta.Delta, &delta)
	if delta.StopReason != "pause_turn" {
		t.Fatalf("stop reason = %q, want pause_turn", delta.StopReason)
	}

	aggregator := NewResponseAggregator(request)
	for _, event := range events {
		if err := aggregator.Add(event); err != nil {
			t.Fatalf("Add(%q) error = %v", event.Kind(), err)
		}
	}
	data, err := aggregator.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	var message messageWireDTO
	_ = json.Unmarshal(data, &message)
	if message.StopReason == nil || *message.StopReason != "pause_turn" {
		t.Fatalf("non-stream stop reason = %#v, want pause_turn", message.StopReason)
	}
}

// TestRefusalRendersAsTextWithRefusalStopReason 验证 Anthropic 没有 refusal
// 内容块时使用 text 传输内容，并由 stop_reason 保留拒绝语义。
func TestRefusalRendersAsTextWithRefusalStopReason(t *testing.T) {
	t.Parallel()

	events := newRefusalResponseEvents(t)
	frames := renderAll(t, NewStreamRenderer(newRendererTestRequest(t)), events)
	assertEventNames(t, frames, []string{
		"message_start",
		"content_block_start",
		"content_block_delta",
		"content_block_delta",
		"content_block_stop",
		"message_delta",
		"message_stop",
	})
	var messageDelta streamEventWireDTO
	_ = json.Unmarshal(frames[5].Data(), &messageDelta)
	var delta messageDeltaWireDTO
	_ = json.Unmarshal(messageDelta.Delta, &delta)
	if delta.StopReason != "refusal" {
		t.Fatalf("stop reason = %q, want refusal", delta.StopReason)
	}
}

// TestResponseFailureUsesAnthropicErrorEvent 验证失败只输出低敏错误类型，
// 非流式聚合器不会伪造成功 Message。
func TestResponseFailureUsesAnthropicErrorEvent(t *testing.T) {
	t.Parallel()

	request := newRendererTestRequest(t)
	started, err := inference.NewResponseStartedEvent(0, "msg_failed_1", "claude-opus-4-6")
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	failure, err := inference.NewResponseFailure("upstream_529", "capacity unavailable", true)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	failed, err := inference.NewResponseFailedEvent(1, failure)
	if err != nil {
		t.Fatalf("NewResponseFailedEvent() error = %v", err)
	}
	events := []inference.StreamEvent{started, failed}

	frames := renderAll(t, NewStreamRenderer(request), events)
	assertEventNames(t, frames, []string{"message_start", "error"})
	var errorEvent streamEventWireDTO
	if err := json.Unmarshal(frames[1].Data(), &errorEvent); err != nil {
		t.Fatalf("unmarshal error event error = %v", err)
	}
	if errorEvent.Error == nil ||
		errorEvent.Error.Type != "overloaded_error" ||
		errorEvent.Error.Message != "capacity unavailable" {
		t.Fatalf("error = %#v, want low-sensitive overloaded error", errorEvent.Error)
	}

	aggregator := NewResponseAggregator(request)
	for _, event := range events {
		if err := aggregator.Add(event); err != nil {
			t.Fatalf("Add(%q) error = %v", event.Kind(), err)
		}
	}
	if _, err := aggregator.Marshal(); !errors.Is(err, ErrResponseFailed) {
		t.Fatalf("Marshal() error = %v, want ErrResponseFailed", err)
	}
}

// TestRenderersRejectUnrepresentableReasoningSummary 验证无签名 summary 不会被
// 冒充为可回传的 Claude thinking。
func TestRenderersRejectUnrepresentableReasoningSummary(t *testing.T) {
	t.Parallel()

	request := newRendererTestRequest(t)
	started, _ := inference.NewResponseStartedEvent(0, "msg_summary_1", "claude-opus-4-6")
	itemStarted, _ := inference.NewOutputItemStartedEvent(
		1,
		0,
		"reasoning_summary_1",
		inference.OutputItemReasoning,
	)
	blockStarted, _ := inference.NewContentBlockStartedEvent(
		2,
		0,
		0,
		inference.ContentReasoning,
	)
	summary, err := inference.NewReasoningSummaryContent("可见摘要")
	if err != nil {
		t.Fatalf("NewReasoningSummaryContent() error = %v", err)
	}
	completed, err := inference.NewReasoningCompletedEvent(3, 0, 0, summary)
	if err != nil {
		t.Fatalf("NewReasoningCompletedEvent() error = %v", err)
	}

	renderer := NewStreamRenderer(request)
	for _, event := range []inference.StreamEvent{started, itemStarted, blockStarted} {
		if _, err := renderer.Render(event); err != nil {
			t.Fatalf("Render(%q) error = %v", event.Kind(), err)
		}
	}
	if _, err := renderer.Render(completed); !errors.Is(err, ErrUnsupportedResponseEvent) {
		t.Fatalf("Render(summary) error = %v, want ErrUnsupportedResponseEvent", err)
	}

	aggregator := NewResponseAggregator(request)
	for _, event := range []inference.StreamEvent{started, itemStarted, blockStarted} {
		if err := aggregator.Add(event); err != nil {
			t.Fatalf("Add(%q) error = %v", event.Kind(), err)
		}
	}
	if err := aggregator.Add(completed); !errors.Is(err, ErrUnsupportedResponseEvent) {
		t.Fatalf("Add(summary) error = %v, want ErrUnsupportedResponseEvent", err)
	}
}

// TestResponseStateRejectsBrokenSequencesAndUsageRegression 验证乱序、未完成输出
// 和累计 usage 回退都会失败关闭。
func TestResponseStateRejectsBrokenSequencesAndUsageRegression(t *testing.T) {
	t.Parallel()

	request := newRendererTestRequest(t)
	itemStarted, _ := inference.NewOutputItemStartedEvent(
		1,
		0,
		"item_1",
		inference.OutputItemMessage,
	)
	if _, err := NewStreamRenderer(request).Render(itemStarted); !errors.Is(err, ErrInvalidEventSequence) {
		t.Fatalf("first item error = %v, want ErrInvalidEventSequence", err)
	}

	renderer := NewStreamRenderer(request)
	started, _ := inference.NewResponseStartedEvent(0, "msg_order_1", "claude-opus-4-6")
	if _, err := renderer.Render(started); err != nil {
		t.Fatalf("Render(started) error = %v", err)
	}
	usageHigh, _ := inference.NewUsage(inference.UsageInput{InputTokens: 10, OutputTokens: 5})
	usageEvent, _ := inference.NewUsageUpdatedEvent(1, usageHigh)
	if _, err := renderer.Render(usageEvent); err != nil {
		t.Fatalf("Render(usage high) error = %v", err)
	}
	usageLow, _ := inference.NewUsage(inference.UsageInput{InputTokens: 9, OutputTokens: 5})
	regression, _ := inference.NewUsageUpdatedEvent(2, usageLow)
	if _, err := renderer.Render(regression); !errors.Is(err, ErrInvalidEventSequence) {
		t.Fatalf("Render(usage regression) error = %v, want ErrInvalidEventSequence", err)
	}
}

// TestRenderedEventDataIsImmutable 验证传输层不能修改 Renderer 已保存的帧。
func TestRenderedEventDataIsImmutable(t *testing.T) {
	t.Parallel()

	started, _ := inference.NewResponseStartedEvent(0, "msg_copy_1", "claude-opus-4-6")
	frames, err := NewStreamRenderer(newRendererTestRequest(t)).Render(started)
	if err != nil {
		t.Fatalf("Render() error = %v", err)
	}
	first := frames[0].Data()
	first[0] = '['
	if frames[0].Data()[0] != '{' {
		t.Fatal("RenderedEvent.Data() exposed internal buffer")
	}
}

// renderAll 把完整 Canonical 流渲染为连续 Messages 帧。
func renderAll(
	t *testing.T,
	renderer *StreamRenderer,
	events []inference.StreamEvent,
) []RenderedEvent {
	t.Helper()

	frames := make([]RenderedEvent, 0)
	for _, event := range events {
		rendered, err := renderer.Render(event)
		if err != nil {
			t.Fatalf("Render(%q, seq=%d) error = %v", event.Kind(), event.Sequence(), err)
		}
		frames = append(frames, rendered...)
	}
	return frames
}

// assertEventNames 验证客户端可观察的 SSE 生命周期精确。
func assertEventNames(t *testing.T, frames []RenderedEvent, expected []string) {
	t.Helper()

	names := make([]string, len(frames))
	for index, frame := range frames {
		names[index] = frame.Name()
	}
	if strings.Join(names, ",") != strings.Join(expected, ",") {
		t.Fatalf("event names = %#v, want %#v", names, expected)
	}
}

// newRefusalResponseEvents 创建内容策略拒绝响应。
func newRefusalResponseEvents(t *testing.T) []inference.StreamEvent {
	t.Helper()

	started, _ := inference.NewResponseStartedEvent(0, "msg_refusal_1", "claude-opus-4-6")
	itemStarted, _ := inference.NewOutputItemStartedEvent(
		1,
		0,
		"message_refusal_1",
		inference.OutputItemMessage,
	)
	blockStarted, _ := inference.NewContentBlockStartedEvent(
		2,
		0,
		0,
		inference.ContentRefusal,
	)
	delta, _ := inference.NewRefusalDeltaEvent(3, 0, 0, "不")
	refusalCompleted, _ := inference.NewRefusalCompletedEvent(4, 0, 0, "不能")
	blockCompleted := inference.NewContentBlockCompletedEvent(5, 0, 0)
	itemCompleted, _ := inference.NewOutputItemCompletedEvent(6, 0, "message_refusal_1")
	usage, _ := inference.NewUsage(inference.UsageInput{InputTokens: 2, OutputTokens: 1})
	completed, _ := inference.NewResponseCompletedEvent(
		7,
		inference.StopReasonContentFilter,
		"",
		usage,
	)
	return []inference.StreamEvent{
		started,
		itemStarted,
		blockStarted,
		delta,
		refusalCompleted,
		blockCompleted,
		itemCompleted,
		completed,
	}
}
