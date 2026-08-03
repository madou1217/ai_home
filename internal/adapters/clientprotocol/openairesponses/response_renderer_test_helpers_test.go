package openairesponses

import (
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// newRendererTestRequest 创建 Renderer 测试共用的最小 Canonical Request。
func newRendererTestRequest(t testing.TB, stream bool) inference.Request {
	return newRendererReasoningTestRequest(t, stream, false)
}

// newRendererReasoningTestRequest 创建可显式控制 opaque continuity 输出的请求。
func newRendererReasoningTestRequest(
	t testing.TB,
	stream bool,
	includeEncryptedReasoning bool,
) inference.Request {
	t.Helper()

	content, err := inference.NewTextContent("你好")
	if err != nil {
		t.Fatalf("NewTextContent() error = %v", err)
	}
	message, err := inference.NewMessage(inference.RoleUser, content)
	if err != nil {
		t.Fatalf("NewMessage() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol:            inference.ClientProtocolOpenAIResponses,
		Model:                     "gpt-5.6-sol",
		Messages:                  []inference.Message{message},
		Stream:                    stream,
		IncludeEncryptedReasoning: includeEncryptedReasoning,
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	return request
}

// newTextResponseEvents 创建包含完整生命周期的文本响应事件。
func newTextResponseEvents(t testing.TB) []inference.StreamEvent {
	t.Helper()

	started, err := inference.NewResponseStartedEvent(0, "resp_exact_1", "gpt-5.6-sol")
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	itemStarted, err := inference.NewOutputItemStartedEvent(1, 0, "msg_exact_1", inference.OutputItemMessage)
	if err != nil {
		t.Fatalf("NewOutputItemStartedEvent() error = %v", err)
	}
	blockStarted, err := inference.NewContentBlockStartedEvent(2, 0, 0, inference.ContentText)
	if err != nil {
		t.Fatalf("NewContentBlockStartedEvent() error = %v", err)
	}
	delta, err := inference.NewTextDeltaEvent(3, 0, 0, "你")
	if err != nil {
		t.Fatalf("NewTextDeltaEvent() error = %v", err)
	}
	textCompleted, err := inference.NewTextCompletedEvent(4, 0, 0, "你好")
	if err != nil {
		t.Fatalf("NewTextCompletedEvent() error = %v", err)
	}
	blockCompleted := inference.NewContentBlockCompletedEvent(5, 0, 0)
	itemCompleted, err := inference.NewOutputItemCompletedEvent(6, 0, "msg_exact_1")
	if err != nil {
		t.Fatalf("NewOutputItemCompletedEvent() error = %v", err)
	}
	usage, err := inference.NewUsage(inference.UsageInput{InputTokens: 4, OutputTokens: 3})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	usageUpdated, err := inference.NewUsageUpdatedEvent(7, usage)
	if err != nil {
		t.Fatalf("NewUsageUpdatedEvent() error = %v", err)
	}
	completed, err := inference.NewResponseCompletedEvent(8, inference.StopReasonEndTurn, "", usage)
	if err != nil {
		t.Fatalf("NewResponseCompletedEvent() error = %v", err)
	}
	return []inference.StreamEvent{
		started,
		itemStarted,
		blockStarted,
		delta,
		textCompleted,
		blockCompleted,
		itemCompleted,
		usageUpdated,
		completed,
	}
}

// newToolResponseEvents 创建包含参数增量和完整参数的函数调用事件。
func newToolResponseEvents(t testing.TB) []inference.StreamEvent {
	t.Helper()

	started, err := inference.NewResponseStartedEvent(0, "resp_tool_1", "gpt-5.6-sol")
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	itemStarted, err := inference.NewOutputItemStartedEvent(1, 0, "fc_exact_1", inference.OutputItemToolCall)
	if err != nil {
		t.Fatalf("NewOutputItemStartedEvent() error = %v", err)
	}
	callStarted, err := inference.NewToolCallStartedEvent(2, 0, 0, "call_exact_1", "lookup")
	if err != nil {
		t.Fatalf("NewToolCallStartedEvent() error = %v", err)
	}
	argumentsDelta, err := inference.NewToolArgumentsDeltaEvent(3, 0, 0, "call_exact_1", `{"query"`)
	if err != nil {
		t.Fatalf("NewToolArgumentsDeltaEvent() error = %v", err)
	}
	callCompleted, err := inference.NewToolCallCompletedEvent(
		4,
		0,
		0,
		"call_exact_1",
		"lookup",
		[]byte(`{"query":"codex"}`),
	)
	if err != nil {
		t.Fatalf("NewToolCallCompletedEvent() error = %v", err)
	}
	itemCompleted, err := inference.NewOutputItemCompletedEvent(5, 0, "fc_exact_1")
	if err != nil {
		t.Fatalf("NewOutputItemCompletedEvent() error = %v", err)
	}
	usage, err := inference.NewUsage(inference.UsageInput{InputTokens: 3, OutputTokens: 2})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	completed, err := inference.NewResponseCompletedEvent(6, inference.StopReasonToolUse, "", usage)
	if err != nil {
		t.Fatalf("NewResponseCompletedEvent() error = %v", err)
	}
	return []inference.StreamEvent{
		started,
		itemStarted,
		callStarted,
		argumentsDelta,
		callCompleted,
		itemCompleted,
		completed,
	}
}

// newRefusalResponseEvents 创建包含拒绝增量和完整拒绝终值的事件流。
func newRefusalResponseEvents(t testing.TB) []inference.StreamEvent {
	t.Helper()

	started, err := inference.NewResponseStartedEvent(
		0,
		"resp_refusal_1",
		"gpt-5.6-sol",
	)
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	itemStarted, err := inference.NewOutputItemStartedEvent(
		1,
		0,
		"msg_refusal_1",
		inference.OutputItemMessage,
	)
	if err != nil {
		t.Fatalf("NewOutputItemStartedEvent() error = %v", err)
	}
	blockStarted, err := inference.NewContentBlockStartedEvent(
		2,
		0,
		0,
		inference.ContentRefusal,
	)
	if err != nil {
		t.Fatalf("NewContentBlockStartedEvent() error = %v", err)
	}
	delta, err := inference.NewRefusalDeltaEvent(3, 0, 0, "不")
	if err != nil {
		t.Fatalf("NewRefusalDeltaEvent() error = %v", err)
	}
	refusalCompleted, err := inference.NewRefusalCompletedEvent(4, 0, 0, "不能")
	if err != nil {
		t.Fatalf("NewRefusalCompletedEvent() error = %v", err)
	}
	blockCompleted := inference.NewContentBlockCompletedEvent(5, 0, 0)
	itemCompleted, err := inference.NewOutputItemCompletedEvent(
		6,
		0,
		"msg_refusal_1",
	)
	if err != nil {
		t.Fatalf("NewOutputItemCompletedEvent() error = %v", err)
	}
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:  4,
		OutputTokens: 2,
	})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	completed, err := inference.NewResponseCompletedEvent(
		7,
		inference.StopReasonContentFilter,
		"",
		usage,
	)
	if err != nil {
		t.Fatalf("NewResponseCompletedEvent() error = %v", err)
	}
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

// newReasoningPrefixEvents 创建 reasoning 输出项和内容块的合法前缀。
func newReasoningPrefixEvents(t testing.TB) []inference.StreamEvent {
	t.Helper()

	started, err := inference.NewResponseStartedEvent(
		0,
		"resp_reasoning_1",
		"gpt-5.6-sol",
	)
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	itemStarted, err := inference.NewOutputItemStartedEvent(
		1,
		0,
		"rs_reasoning_1",
		inference.OutputItemReasoning,
	)
	if err != nil {
		t.Fatalf("NewOutputItemStartedEvent() error = %v", err)
	}
	blockStarted, err := inference.NewContentBlockStartedEvent(
		2,
		0,
		0,
		inference.ContentReasoning,
	)
	if err != nil {
		t.Fatalf("NewContentBlockStartedEvent() error = %v", err)
	}
	return []inference.StreamEvent{started, itemStarted, blockStarted}
}

// newReasoningResponseEvents 创建包含摘要增量和完整摘要的事件流。
func newReasoningResponseEvents(t testing.TB) []inference.StreamEvent {
	t.Helper()

	events := newReasoningPrefixEvents(t)
	delta, err := inference.NewReasoningDeltaEvent(
		3,
		0,
		0,
		inference.ReasoningDeltaThinking,
		"先",
	)
	if err != nil {
		t.Fatalf("NewReasoningDeltaEvent() error = %v", err)
	}
	content, err := inference.NewReasoningSummaryContent("先分析")
	if err != nil {
		t.Fatalf("NewReasoningSummaryContent() error = %v", err)
	}
	reasoningCompleted, err := inference.NewReasoningCompletedEvent(
		4,
		0,
		0,
		content,
	)
	if err != nil {
		t.Fatalf("NewReasoningCompletedEvent() error = %v", err)
	}
	blockCompleted := inference.NewContentBlockCompletedEvent(5, 0, 0)
	itemCompleted, err := inference.NewOutputItemCompletedEvent(
		6,
		0,
		"rs_reasoning_1",
	)
	if err != nil {
		t.Fatalf("NewOutputItemCompletedEvent() error = %v", err)
	}
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:     5,
		OutputTokens:    4,
		ReasoningTokens: 3,
	})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	completed, err := inference.NewResponseCompletedEvent(
		7,
		inference.StopReasonEndTurn,
		"",
		usage,
	)
	if err != nil {
		t.Fatalf("NewResponseCompletedEvent() error = %v", err)
	}
	return append(events,
		delta,
		reasoningCompleted,
		blockCompleted,
		itemCompleted,
		completed,
	)
}

// newSignedReasoningResponseEvents 创建包含真实 Claude 形态签名的完整事件流。
func newSignedReasoningResponseEvents(t testing.TB) []inference.StreamEvent {
	t.Helper()

	events := newReasoningPrefixEvents(t)
	thinking, err := inference.NewReasoningDeltaEvent(
		3,
		0,
		0,
		inference.ReasoningDeltaThinking,
		"可继续",
	)
	if err != nil {
		t.Fatalf("NewReasoningDeltaEvent(thinking) error = %v", err)
	}
	signature, err := inference.NewReasoningDeltaEvent(
		4,
		0,
		0,
		inference.ReasoningDeltaSignature,
		"opaque-signature",
	)
	if err != nil {
		t.Fatalf("NewReasoningDeltaEvent(signature) error = %v", err)
	}
	content, err := inference.NewThinkingContent("可继续", "opaque-signature")
	if err != nil {
		t.Fatalf("NewThinkingContent() error = %v", err)
	}
	completed, err := inference.NewReasoningCompletedEvent(5, 0, 0, content)
	if err != nil {
		t.Fatalf("NewReasoningCompletedEvent() error = %v", err)
	}
	blockCompleted := inference.NewContentBlockCompletedEvent(6, 0, 0)
	itemCompleted, err := inference.NewOutputItemCompletedEvent(
		7,
		0,
		"rs_reasoning_1",
	)
	if err != nil {
		t.Fatalf("NewOutputItemCompletedEvent() error = %v", err)
	}
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:     5,
		OutputTokens:    4,
		ReasoningTokens: 3,
	})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	responseCompleted, err := inference.NewResponseCompletedEvent(
		8,
		inference.StopReasonEndTurn,
		"",
		usage,
	)
	if err != nil {
		t.Fatalf("NewResponseCompletedEvent() error = %v", err)
	}
	return append(
		events,
		thinking,
		signature,
		completed,
		blockCompleted,
		itemCompleted,
		responseCompleted,
	)
}

// renderTestEvents 渲染完整测试事件流并合并所有生成帧。
func renderTestEvents(
	t testing.TB,
	renderer *StreamRenderer,
	events []inference.StreamEvent,
) []RenderedEvent {
	t.Helper()

	var frames []RenderedEvent
	for _, event := range events {
		rendered, err := renderer.Render(event)
		if err != nil {
			t.Fatalf("Render(%q) error = %v", event.Kind(), err)
		}
		frames = append(frames, rendered...)
	}
	return frames
}

// assertRenderedNames 校验 SSE 事件名及顺序。
func assertRenderedNames(
	t testing.TB,
	frames []RenderedEvent,
	expected []string,
) {
	t.Helper()

	names := make([]string, len(frames))
	for index, frame := range frames {
		names[index] = frame.Name()
	}
	if strings.Join(names, ",") != strings.Join(expected, ",") {
		t.Fatalf("frame names = %#v, want %#v", names, expected)
	}
}
