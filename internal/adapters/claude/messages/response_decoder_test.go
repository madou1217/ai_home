package messages

import (
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// TestResponseDecoderPreservesClaudeLifecycle 验证 signed thinking、文本、
// 工具参数、累计 usage 和明确终态被转换为连续 Canonical 事件。
func TestResponseDecoderPreservesClaudeLifecycle(t *testing.T) {
	t.Parallel()

	events := make([]inference.StreamEvent, 0, 24)
	decoder, err := newResponseDecoder(
		"claude-sonnet-4-6",
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("newResponseDecoder() error = %v", err)
	}
	frames := []string{
		`{"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":10,"cache_creation_input_tokens":3,"cache_read_input_tokens":4,"output_tokens":0}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason"}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"signed"}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"content_block_start","index":1,"content_block":{"type":"text","text":"","citations":[]}}`,
		`{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"AIH_REAL_"}}`,
		`{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"CLAUDE_OK"}}`,
		`{"type":"content_block_stop","index":1}`,
		`{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_123","name":"weather","input":{}}}`,
		`{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"city\":"}}`,
		`{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"Shanghai\"}"}}`,
		`{"type":"content_block_stop","index":2}`,
		`{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":12}}`,
		`{"type":"message_stop"}`,
	}
	for index, frame := range frames {
		if err := decoder.Apply("", []byte(frame)); err != nil {
			t.Fatalf("Apply(frame=%d) error = %v", index, err)
		}
	}
	if !decoder.Terminal() {
		t.Fatal("decoder should be terminal")
	}
	if len(events) == 0 ||
		events[0].Kind() != inference.EventResponseStarted ||
		events[len(events)-1].Kind() != inference.EventResponseCompleted {
		t.Fatalf("events = %v", eventKinds(events))
	}
	var completedText string
	var completedThinking inference.ReasoningContent
	var completedTool inference.ToolCallCompletedEvent
	for _, event := range events {
		switch typed := event.(type) {
		case inference.TextCompletedEvent:
			completedText = typed.Text()
		case inference.ReasoningCompletedEvent:
			completedThinking = typed.Content()
		case inference.ToolCallCompletedEvent:
			completedTool = typed
		}
	}
	if completedText != "AIH_REAL_CLAUDE_OK" ||
		completedThinking.Text() != "reason" ||
		completedThinking.Signature() != "signed" ||
		completedTool.CallID() != "toolu_123" ||
		string(completedTool.Arguments()) != `{"city":"Shanghai"}` {
		t.Fatalf(
			"text=%q thinking=%#v tool=%#v",
			completedText,
			completedThinking,
			completedTool,
		)
	}
	completed := events[len(events)-1].(inference.ResponseCompletedEvent)
	if completed.StopReason() != inference.StopReasonToolUse ||
		completed.Usage().InputTokens() != 17 ||
		completed.Usage().CachedInputTokens() != 4 ||
		completed.Usage().CacheWriteInputTokens() != 3 ||
		completed.Usage().OutputTokens() != 12 {
		t.Fatalf("completed = %#v", completed)
	}
}

// TestResponseDecoderRejectsModifiedThinkingContinuity 验证缺失签名的
// thinking 块不能形成伪造的 Canonical 完成事件。
func TestResponseDecoderRejectsModifiedThinkingContinuity(t *testing.T) {
	t.Parallel()

	decoder, err := newResponseDecoder(
		"claude-sonnet-4-6",
		func(inference.StreamEvent) error { return nil },
	)
	if err != nil {
		t.Fatalf("newResponseDecoder() error = %v", err)
	}
	frames := []string{
		`{"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"reason"}}`,
	}
	for _, frame := range frames {
		if err := decoder.Apply("", []byte(frame)); err != nil {
			t.Fatalf("Apply() error = %v", err)
		}
	}
	if err := decoder.Apply(
		"",
		[]byte(`{"type":"content_block_stop","index":0}`),
	); !errorsIsInvalidResponse(err) {
		t.Fatalf("Apply(content_block_stop) error = %v", err)
	}
}

// BenchmarkResponseDecoderTextStream 测量纯文本 Claude SSE 热路径。
func BenchmarkResponseDecoderTextStream(benchmark *testing.B) {
	frames := [][]byte{
		[]byte(`{"type":"message_start","message":{"id":"msg_bench","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"usage":{"input_tokens":10,"output_tokens":0}}}`),
		[]byte(`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`),
		[]byte(`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"benchmark"}}`),
		[]byte(`{"type":"content_block_stop","index":0}`),
		[]byte(`{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}`),
		[]byte(`{"type":"message_stop"}`),
	}
	benchmark.ReportAllocs()
	for benchmark.Loop() {
		decoder, err := newResponseDecoder(
			"claude-sonnet-4-6",
			func(inference.StreamEvent) error { return nil },
		)
		if err != nil {
			benchmark.Fatal(err)
		}
		for _, frame := range frames {
			if err := decoder.Apply("", frame); err != nil {
				benchmark.Fatal(err)
			}
		}
	}
}

// eventKinds 返回便于断言的事件名称。
func eventKinds(events []inference.StreamEvent) string {
	kinds := make([]string, len(events))
	for index, event := range events {
		kinds[index] = string(event.Kind())
	}
	return strings.Join(kinds, ",")
}

// errorsIsInvalidResponse 避免测试把任何错误都误认为状态机拒绝。
func errorsIsInvalidResponse(err error) bool {
	return err != nil && strings.Contains(err.Error(), "Claude Messages 上游响应无效")
}
