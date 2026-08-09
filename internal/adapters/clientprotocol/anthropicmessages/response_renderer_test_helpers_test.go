package anthropicmessages

import (
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// newRendererTestRequest 创建只供响应 Renderer 测试使用的 Anthropic 请求。
func newRendererTestRequest(t testing.TB) inference.Request {
	t.Helper()

	request, err := NewRequestDecoder().Decode([]byte(`{
		"model":"claude-opus-4-6",
		"max_tokens":4096,
		"messages":[{"role":"user","content":"你好"}],
		"stream":true
	}`))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	return request
}

// newTextResponseEvents 创建包含增量后缀和缓存 usage 的完整文本响应。
func newTextResponseEvents(t *testing.T) []inference.StreamEvent {
	t.Helper()

	started, err := inference.NewResponseStartedEvent(0, "msg_exact_1", "claude-opus-4-6")
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	itemStarted, err := inference.NewOutputItemStartedEvent(
		1,
		0,
		"item_text_1",
		inference.OutputItemMessage,
	)
	if err != nil {
		t.Fatalf("NewOutputItemStartedEvent() error = %v", err)
	}
	blockStarted, err := inference.NewContentBlockStartedEvent(
		2,
		0,
		0,
		inference.ContentText,
	)
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
	itemCompleted, err := inference.NewOutputItemCompletedEvent(6, 0, "item_text_1")
	if err != nil {
		t.Fatalf("NewOutputItemCompletedEvent() error = %v", err)
	}
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:           100,
		OutputTokens:          2,
		CachedInputTokens:     20,
		CacheWriteInputTokens: 10,
	})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	usageUpdated, err := inference.NewUsageUpdatedEvent(7, usage)
	if err != nil {
		t.Fatalf("NewUsageUpdatedEvent() error = %v", err)
	}
	completed, err := inference.NewResponseCompletedEvent(
		8,
		inference.StopReasonEndTurn,
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
		textCompleted,
		blockCompleted,
		itemCompleted,
		usageUpdated,
		completed,
	}
}

// newThinkingTextToolResponseEvents 创建 signed thinking、文本和工具调用混合响应。
func newThinkingTextToolResponseEvents(t testing.TB) []inference.StreamEvent {
	t.Helper()

	events := make([]inference.StreamEvent, 0, 21)
	appendEvent := func(event inference.StreamEvent, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("create event error = %v", err)
		}
		events = append(events, event)
	}

	started, err := inference.NewResponseStartedEvent(0, "msg_mixed_1", "claude-sonnet-4-6")
	appendEvent(started, err)
	reasoningItem, err := inference.NewOutputItemStartedEvent(
		1,
		0,
		"reasoning_1",
		inference.OutputItemReasoning,
	)
	appendEvent(reasoningItem, err)
	reasoningBlock, err := inference.NewContentBlockStartedEvent(
		2,
		0,
		0,
		inference.ContentReasoning,
	)
	appendEvent(reasoningBlock, err)
	thinkingDelta, err := inference.NewReasoningDeltaEvent(
		3,
		0,
		0,
		inference.ReasoningDeltaThinking,
		"先",
	)
	appendEvent(thinkingDelta, err)
	signatureDelta, err := inference.NewReasoningDeltaEvent(
		4,
		0,
		0,
		inference.ReasoningDeltaSignature,
		"sig_",
	)
	appendEvent(signatureDelta, err)
	thinking, err := inference.NewThinkingContent("先想", "sig_exact")
	if err != nil {
		t.Fatalf("NewThinkingContent() error = %v", err)
	}
	reasoningCompleted, err := inference.NewReasoningCompletedEvent(5, 0, 0, thinking)
	appendEvent(reasoningCompleted, err)
	events = append(events, inference.NewContentBlockCompletedEvent(6, 0, 0))
	reasoningItemCompleted, err := inference.NewOutputItemCompletedEvent(
		7,
		0,
		"reasoning_1",
	)
	appendEvent(reasoningItemCompleted, err)

	messageItem, err := inference.NewPhasedOutputItemStartedEvent(
		8,
		1,
		"message_1",
		inference.MessagePhaseFinalAnswer,
	)
	appendEvent(messageItem, err)
	textBlock, err := inference.NewContentBlockStartedEvent(
		9,
		1,
		0,
		inference.ContentText,
	)
	appendEvent(textBlock, err)
	textDelta, err := inference.NewTextDeltaEvent(10, 1, 0, "完成")
	appendEvent(textDelta, err)
	textCompleted, err := inference.NewTextCompletedEvent(11, 1, 0, "完成")
	appendEvent(textCompleted, err)
	events = append(events, inference.NewContentBlockCompletedEvent(12, 1, 0))
	messageItemCompleted, err := inference.NewOutputItemCompletedEvent(13, 1, "message_1")
	appendEvent(messageItemCompleted, err)

	toolItem, err := inference.NewOutputItemStartedEvent(
		14,
		2,
		"tool_item_1",
		inference.OutputItemToolCall,
	)
	appendEvent(toolItem, err)
	toolStarted, err := inference.NewToolCallStartedEvent(
		15,
		2,
		0,
		"toolu_exact_1",
		"lookup",
	)
	appendEvent(toolStarted, err)
	argumentsDelta, err := inference.NewToolArgumentsDeltaEvent(
		16,
		2,
		0,
		"toolu_exact_1",
		`{"account"`,
	)
	appendEvent(argumentsDelta, err)
	toolCompleted, err := inference.NewToolCallCompletedEvent(
		17,
		2,
		0,
		"toolu_exact_1",
		"lookup",
		[]byte(`{"account":"codex"}`),
	)
	appendEvent(toolCompleted, err)
	toolItemCompleted, err := inference.NewOutputItemCompletedEvent(
		18,
		2,
		"tool_item_1",
	)
	appendEvent(toolItemCompleted, err)
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:     12,
		OutputTokens:    8,
		ReasoningTokens: 2,
	})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	usageUpdated, err := inference.NewUsageUpdatedEvent(19, usage)
	appendEvent(usageUpdated, err)
	completed, err := inference.NewResponseCompletedEvent(
		20,
		inference.StopReasonToolUse,
		"",
		usage,
	)
	appendEvent(completed, err)
	return events
}

// newRedactedResponseEvents 创建只有 redacted thinking 的 pause_turn 响应。
func newRedactedResponseEvents(t *testing.T) []inference.StreamEvent {
	t.Helper()

	started, err := inference.NewResponseStartedEvent(0, "msg_redacted_1", "claude-opus-4-6")
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	itemStarted, err := inference.NewOutputItemStartedEvent(
		1,
		0,
		"reasoning_redacted_1",
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
	redacted, err := inference.NewRedactedReasoningContent("encrypted_exact_1")
	if err != nil {
		t.Fatalf("NewRedactedReasoningContent() error = %v", err)
	}
	reasoningCompleted, err := inference.NewReasoningCompletedEvent(3, 0, 0, redacted)
	if err != nil {
		t.Fatalf("NewReasoningCompletedEvent() error = %v", err)
	}
	blockCompleted := inference.NewContentBlockCompletedEvent(4, 0, 0)
	itemCompleted, err := inference.NewOutputItemCompletedEvent(
		5,
		0,
		"reasoning_redacted_1",
	)
	if err != nil {
		t.Fatalf("NewOutputItemCompletedEvent() error = %v", err)
	}
	usage, err := inference.NewUsage(inference.UsageInput{InputTokens: 4, OutputTokens: 2})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	completed, err := inference.NewResponseCompletedEvent(
		6,
		inference.StopReasonPauseTurn,
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
		reasoningCompleted,
		blockCompleted,
		itemCompleted,
		completed,
	}
}

// newPrivateReasoningTextResponseEvents 创建 Codex 摘要、加密连续性和公开文本
// 混合响应，验证 Anthropic 边界只省略不可表达的 Provider 私有块。
func newPrivateReasoningTextResponseEvents(t testing.TB) []inference.StreamEvent {
	t.Helper()

	events := make([]inference.StreamEvent, 0, 17)
	appendEvent := func(event inference.StreamEvent, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("create event error = %v", err)
		}
		events = append(events, event)
	}

	started, err := inference.NewResponseStartedEvent(0, "msg_private_1", "gpt-5.6-sol")
	appendEvent(started, err)
	reasoningItem, err := inference.NewOutputItemStartedEvent(
		1,
		0,
		"reasoning_private_1",
		inference.OutputItemReasoning,
	)
	appendEvent(reasoningItem, err)
	summaryBlock, err := inference.NewContentBlockStartedEvent(
		2,
		0,
		0,
		inference.ContentReasoning,
	)
	appendEvent(summaryBlock, err)
	summaryDelta, err := inference.NewReasoningDeltaEvent(
		3,
		0,
		0,
		inference.ReasoningDeltaSummary,
		"私有摘要",
	)
	appendEvent(summaryDelta, err)
	summary, err := inference.NewReasoningSummaryContent("私有摘要完整")
	if err != nil {
		t.Fatalf("NewReasoningSummaryContent() error = %v", err)
	}
	summaryCompleted, err := inference.NewReasoningCompletedEvent(4, 0, 0, summary)
	appendEvent(summaryCompleted, err)
	events = append(events, inference.NewContentBlockCompletedEvent(5, 0, 0))
	encryptedBlock, err := inference.NewContentBlockStartedEvent(
		6,
		0,
		1,
		inference.ContentReasoning,
	)
	appendEvent(encryptedBlock, err)
	encrypted, err := inference.NewEncryptedReasoningContent("codex-private-continuity")
	if err != nil {
		t.Fatalf("NewEncryptedReasoningContent() error = %v", err)
	}
	encryptedCompleted, err := inference.NewReasoningCompletedEvent(7, 0, 1, encrypted)
	appendEvent(encryptedCompleted, err)
	events = append(events, inference.NewContentBlockCompletedEvent(8, 0, 1))
	reasoningItemCompleted, err := inference.NewOutputItemCompletedEvent(
		9,
		0,
		"reasoning_private_1",
	)
	appendEvent(reasoningItemCompleted, err)

	messageItem, err := inference.NewPhasedOutputItemStartedEvent(
		10,
		1,
		"message_private_1",
		inference.MessagePhaseFinalAnswer,
	)
	appendEvent(messageItem, err)
	textBlock, err := inference.NewContentBlockStartedEvent(
		11,
		1,
		0,
		inference.ContentText,
	)
	appendEvent(textBlock, err)
	textDelta, err := inference.NewTextDeltaEvent(12, 1, 0, "公开回答")
	appendEvent(textDelta, err)
	textCompleted, err := inference.NewTextCompletedEvent(13, 1, 0, "公开回答")
	appendEvent(textCompleted, err)
	events = append(events, inference.NewContentBlockCompletedEvent(14, 1, 0))
	messageItemCompleted, err := inference.NewOutputItemCompletedEvent(
		15,
		1,
		"message_private_1",
	)
	appendEvent(messageItemCompleted, err)
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:     10,
		OutputTokens:    6,
		ReasoningTokens: 4,
	})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	completed, err := inference.NewResponseCompletedEvent(
		16,
		inference.StopReasonEndTurn,
		"",
		usage,
	)
	appendEvent(completed, err)
	return events
}
