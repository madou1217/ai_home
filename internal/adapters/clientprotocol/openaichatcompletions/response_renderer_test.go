package openaichatcompletions

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
)

// TestResponseAggregatorRendersChatCompletion 验证 Canonical reasoning、文本、
// 工具调用、finish_reason 和 usage 被聚合为一个 Chat Completion。
func TestResponseAggregatorRendersChatCompletion(t *testing.T) {
	t.Parallel()

	request := mustChatRenderRequest(t, false, false)
	adapter := mustChatAdapter(t)
	aggregator := adapter.NewResponseAggregator(request)
	for _, event := range completeChatEvents(t) {
		if err := aggregator.Add(event); err != nil {
			t.Fatalf("Add(%s) error = %v", event.Kind(), err)
		}
	}
	data, err := aggregator.Marshal()
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}

	var document struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		Created int64  `json:"created"`
		Model   string `json:"model"`
		Choices []struct {
			Index   uint32 `json:"index"`
			Message struct {
				Role             string `json:"role"`
				Content          string `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
				ToolCalls        []struct {
					ID       string `json:"id"`
					Type     string `json:"type"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage chatUsageWire `json:"usage"`
	}
	if err := json.Unmarshal(data, &document); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if document.ID != "resp_chat_1" ||
		document.Object != "chat.completion" ||
		document.Created != 1_785_110_400 ||
		document.Model != "gpt-5.6-sol" ||
		len(document.Choices) != 1 {
		t.Fatalf("响应基础字段错误: %s", data)
	}
	choice := document.Choices[0]
	if choice.Index != 0 ||
		choice.Message.Role != "assistant" ||
		choice.Message.Content != "最终回复" ||
		choice.Message.ReasoningContent != "先分析" ||
		choice.FinishReason != "tool_calls" ||
		len(choice.Message.ToolCalls) != 1 {
		t.Fatalf("choice 错误: %#v", choice)
	}
	toolCall := choice.Message.ToolCalls[0]
	if toolCall.ID != "call_weather" ||
		toolCall.Type != "function" ||
		toolCall.Function.Name != "weather" ||
		toolCall.Function.Arguments != `{"city":"深圳"}` {
		t.Fatalf("tool_call 错误: %#v", toolCall)
	}
	if document.Usage.PromptTokens != 12 ||
		document.Usage.CompletionTokens != 7 ||
		document.Usage.TotalTokens != 19 ||
		document.Usage.PromptTokensDetails.CachedTokens != 2 ||
		document.Usage.CompletionTokensDetails.ReasoningTokens != 3 {
		t.Fatalf("usage 错误: %#v", document.Usage)
	}
}

// TestStreamRendererRendersChunksUsageAndDone 验证 Chat SSE 使用 data-only
// frame、增量工具参数、usage 尾块和 [DONE]。
func TestStreamRendererRendersChunksUsageAndDone(t *testing.T) {
	t.Parallel()

	request := mustChatRenderRequest(t, true, true)
	renderer := mustChatAdapter(t).NewStreamRenderer(request)
	var frames []clientprotocol.RenderedEvent
	for _, event := range completeChatEvents(t) {
		rendered, err := renderer.Render(event)
		if err != nil {
			t.Fatalf("Render(%s) error = %v", event.Kind(), err)
		}
		frames = append(frames, rendered...)
	}
	if !renderer.Terminal() {
		t.Fatal("Renderer 未进入终态")
	}
	if len(frames) != 8 {
		t.Fatalf("frame 数量 = %d, want 8", len(frames))
	}
	for index, frame := range frames {
		if frame.Name() != "" {
			t.Fatalf("frame[%d].Name() = %q, want empty", index, frame.Name())
		}
	}

	assertChunk := func(index int, contains ...string) {
		t.Helper()
		data := string(frames[index].Data())
		for _, expected := range contains {
			if !containsJSONFragment(data, expected) {
				t.Fatalf("frame[%d] = %s, missing %s", index, data, expected)
			}
		}
	}
	assertChunk(0, `"object":"chat.completion.chunk"`, `"role":"assistant"`)
	assertChunk(1, `"reasoning_content":"先分析"`)
	assertChunk(2, `"content":"最终回复"`)
	assertChunk(
		3,
		`"id":"call_weather"`,
		`"name":"weather"`,
		`"arguments":""`,
	)
	assertChunk(4, `"arguments":"{\"city\":\"深圳\"}"`)
	assertChunk(5, `"finish_reason":"tool_calls"`)
	assertChunk(6, `"choices":[]`, `"prompt_tokens":12`, `"total_tokens":19`)
	if string(frames[7].Data()) != "[DONE]" {
		t.Fatalf("final frame = %q, want [DONE]", frames[7].Data())
	}
}

// TestRenderersRejectInvalidSequenceAndOpaqueReasoning 验证乱序事件和 Chat
// 无法表达的加密 reasoning 不会被静默吞掉。
func TestRenderersRejectInvalidSequenceAndOpaqueReasoning(t *testing.T) {
	t.Parallel()

	request := mustChatRenderRequest(t, false, false)
	aggregator := mustChatAdapter(t).NewResponseAggregator(request)
	text, err := inference.NewTextDeltaEvent(1, 0, 0, "orphan")
	if err != nil {
		t.Fatalf("NewTextDeltaEvent() error = %v", err)
	}
	if err := aggregator.Add(text); !errors.Is(err, ErrInvalidEventSequence) {
		t.Fatalf("Add(orphan) error = %v", err)
	}

	renderer := mustChatAdapter(t).NewStreamRenderer(request)
	started, err := inference.NewResponseStartedEvent(0, "resp_x", "gpt")
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	if _, err := renderer.Render(started); err != nil {
		t.Fatalf("Render(started) error = %v", err)
	}
	item, err := inference.NewOutputItemStartedEvent(
		1,
		0,
		"reasoning_x",
		inference.OutputItemReasoning,
	)
	if err != nil {
		t.Fatalf("NewOutputItemStartedEvent() error = %v", err)
	}
	if _, err := renderer.Render(item); err != nil {
		t.Fatalf("Render(item) error = %v", err)
	}
	block, err := inference.NewContentBlockStartedEvent(
		2,
		0,
		0,
		inference.ContentReasoning,
	)
	if err != nil {
		t.Fatalf("NewContentBlockStartedEvent() error = %v", err)
	}
	if _, err := renderer.Render(block); err != nil {
		t.Fatalf("Render(block) error = %v", err)
	}
	encrypted, err := inference.NewEncryptedReasoningContent("opaque-data")
	if err != nil {
		t.Fatalf("NewEncryptedReasoningContent() error = %v", err)
	}
	completed, err := inference.NewReasoningCompletedEvent(3, 0, 0, encrypted)
	if err != nil {
		t.Fatalf("NewReasoningCompletedEvent() error = %v", err)
	}
	if _, err := renderer.Render(completed); !errors.Is(
		err,
		ErrUnsupportedResponseEvent,
	) {
		t.Fatalf("Render(encrypted) error = %v", err)
	}
}

// TestStreamRendererEmitsCompletionSuffixAndFailureTerminal 验证上游只在完成
// 事件给出终值时仍不会丢文本，并且已提交流的失败以低敏错误和 DONE 结束。
func TestStreamRendererEmitsCompletionSuffixAndFailureTerminal(t *testing.T) {
	t.Parallel()

	request := mustChatRenderRequest(t, true, false)
	renderer := mustChatAdapter(t).NewStreamRenderer(request)
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:  2,
		OutputTokens: 1,
	})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	events := make([]inference.StreamEvent, 0, 7)
	appendEvent := func(event inference.StreamEvent, eventErr error) {
		t.Helper()
		if eventErr != nil {
			t.Fatalf("创建事件失败: %v", eventErr)
		}
		events = append(events, event)
	}
	appendEvent(inference.NewResponseStartedEvent(0, "resp_suffix", "gpt"))
	appendEvent(inference.NewOutputItemStartedEvent(
		1,
		0,
		"message_suffix",
		inference.OutputItemMessage,
	))
	appendEvent(inference.NewContentBlockStartedEvent(
		2,
		0,
		0,
		inference.ContentText,
	))
	appendEvent(inference.NewTextCompletedEvent(3, 0, 0, "只在终值出现"))
	events = append(events, inference.NewContentBlockCompletedEvent(4, 0, 0))
	appendEvent(inference.NewOutputItemCompletedEvent(5, 0, "message_suffix"))
	appendEvent(inference.NewResponseCompletedEvent(
		6,
		inference.StopReasonEndTurn,
		"",
		usage,
	))

	var frames []clientprotocol.RenderedEvent
	for _, event := range events {
		rendered, renderErr := renderer.Render(event)
		if renderErr != nil {
			t.Fatalf("Render(%s) error = %v", event.Kind(), renderErr)
		}
		frames = append(frames, rendered...)
	}
	if len(frames) != 4 ||
		!containsJSONFragment(string(frames[1].Data()), `"content":"只在终值出现"`) ||
		string(frames[3].Data()) != "[DONE]" {
		t.Fatalf("suffix frames = %#v", frames)
	}

	failedRenderer := mustChatAdapter(t).NewStreamRenderer(request)
	started, err := inference.NewResponseStartedEvent(0, "resp_failed", "gpt")
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	if _, err := failedRenderer.Render(started); err != nil {
		t.Fatalf("Render(started) error = %v", err)
	}
	failure, err := inference.NewResponseFailure(
		"upstream_overloaded",
		"上游暂时过载",
		true,
	)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	failed, err := inference.NewResponseFailedEvent(1, failure)
	if err != nil {
		t.Fatalf("NewResponseFailedEvent() error = %v", err)
	}
	failureFrames, err := failedRenderer.Render(failed)
	if err != nil {
		t.Fatalf("Render(failed) error = %v", err)
	}
	if !failedRenderer.Terminal() ||
		len(failureFrames) != 2 ||
		!containsJSONFragment(
			string(failureFrames[0].Data()),
			`"code":"upstream_overloaded"`,
		) ||
		string(failureFrames[1].Data()) != "[DONE]" {
		t.Fatalf("failure frames = %#v", failureFrames)
	}
}

func mustChatAdapter(t *testing.T) Adapter {
	t.Helper()

	adapter, err := NewAdapter(func() time.Time {
		return time.Date(2026, time.July, 27, 0, 0, 0, 0, time.UTC)
	})
	if err != nil {
		t.Fatalf("NewAdapter() error = %v", err)
	}
	return adapter
}

func mustChatRenderRequest(
	t *testing.T,
	stream bool,
	includeUsage bool,
) inference.Request {
	t.Helper()

	body := `{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"hello"}]`
	if stream {
		body += `,"stream":true`
	}
	if includeUsage {
		body += `,"stream_options":{"include_usage":true}`
	}
	body += `}`
	request, err := NewRequestDecoder().Decode([]byte(body))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	return request
}

func completeChatEvents(t *testing.T) []inference.StreamEvent {
	t.Helper()

	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:       12,
		OutputTokens:      7,
		CachedInputTokens: 2,
		ReasoningTokens:   3,
	})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	reasoning, err := inference.NewReasoningSummaryContent("先分析")
	if err != nil {
		t.Fatalf("NewReasoningSummaryContent() error = %v", err)
	}

	events := make([]inference.StreamEvent, 0, 20)
	appendEvent := func(event inference.StreamEvent, err error) {
		t.Helper()
		if err != nil {
			t.Fatalf("创建事件失败: %v", err)
		}
		events = append(events, event)
	}
	appendEvent(inference.NewResponseStartedEvent(0, "resp_chat_1", "gpt-5.6-sol"))
	appendEvent(inference.NewOutputItemStartedEvent(
		1,
		0,
		"reasoning_1",
		inference.OutputItemReasoning,
	))
	appendEvent(inference.NewContentBlockStartedEvent(
		2,
		0,
		0,
		inference.ContentReasoning,
	))
	appendEvent(inference.NewReasoningDeltaEvent(
		3,
		0,
		0,
		inference.ReasoningDeltaThinking,
		"先分析",
	))
	appendEvent(inference.NewReasoningCompletedEvent(4, 0, 0, reasoning))
	events = append(events, inference.NewContentBlockCompletedEvent(5, 0, 0))
	appendEvent(inference.NewOutputItemCompletedEvent(6, 0, "reasoning_1"))
	appendEvent(inference.NewOutputItemStartedEvent(
		7,
		1,
		"message_1",
		inference.OutputItemMessage,
	))
	appendEvent(inference.NewContentBlockStartedEvent(
		8,
		1,
		0,
		inference.ContentText,
	))
	appendEvent(inference.NewTextDeltaEvent(9, 1, 0, "最终回复"))
	appendEvent(inference.NewTextCompletedEvent(10, 1, 0, "最终回复"))
	events = append(events, inference.NewContentBlockCompletedEvent(11, 1, 0))
	appendEvent(inference.NewOutputItemCompletedEvent(12, 1, "message_1"))
	appendEvent(inference.NewOutputItemStartedEvent(
		13,
		2,
		"tool_1",
		inference.OutputItemToolCall,
	))
	appendEvent(inference.NewToolCallStartedEvent(
		14,
		2,
		0,
		"call_weather",
		"weather",
	))
	appendEvent(inference.NewToolArgumentsDeltaEvent(
		15,
		2,
		0,
		"call_weather",
		`{"city":"深圳"}`,
	))
	appendEvent(inference.NewToolCallCompletedEvent(
		16,
		2,
		0,
		"call_weather",
		"weather",
		[]byte(`{"city":"深圳"}`),
	))
	appendEvent(inference.NewOutputItemCompletedEvent(17, 2, "tool_1"))
	appendEvent(inference.NewUsageUpdatedEvent(18, usage))
	appendEvent(inference.NewResponseCompletedEvent(
		19,
		inference.StopReasonToolUse,
		"",
		usage,
	))
	return events
}

// containsJSONFragment 避免测试依赖字段顺序，同时保持期望片段可读。
func containsJSONFragment(data string, fragment string) bool {
	var document any
	if json.Unmarshal([]byte(data), &document) != nil {
		return false
	}
	encoded, err := json.Marshal(document)
	return err == nil && stringContains(string(encoded), fragment)
}

func stringContains(value string, expected string) bool {
	for index := 0; index+len(expected) <= len(value); index++ {
		if value[index:index+len(expected)] == expected {
			return true
		}
	}
	return false
}
