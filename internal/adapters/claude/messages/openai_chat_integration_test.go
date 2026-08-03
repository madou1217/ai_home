package messages

import (
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/openaichatcompletions"
)

// TestClaudeReasoningAndToolRendersAsChat 验证 Claude thinking、文本和工具调用
// 能通过 Canonical 事件流进入 Chat renderer，而不是在协议边界变成 502。
func TestClaudeReasoningAndToolRendersAsChat(t *testing.T) {
	t.Parallel()

	request, err := openaichatcompletions.NewRequestDecoder().Decode([]byte(`{
		"model":"claude-sonnet-4",
		"messages":[{"role":"user","content":"查询天气"}],
		"tools":[{"type":"function","function":{"name":"weather","parameters":{"type":"object"}}}],
		"reasoning_effort":"high",
		"stream":true
	}`))
	if err != nil {
		t.Fatalf("Chat Decode() error = %v", err)
	}
	encoded, err := encodeRequest(request, request.Model())
	if err != nil {
		t.Fatalf("encodeRequest() error = %v", err)
	}
	renderer := openaichatcompletions.NewStreamRenderer(
		request,
		time.Unix(1_700_000_000, 0).UTC(),
	)
	var lastEvent inference.EventKind
	decoder, err := newResponseDecoder(
		request.Model(),
		func(event inference.StreamEvent) error {
			lastEvent = event.Kind()
			_, renderErr := renderer.Render(event)
			return renderErr
		},
		encoded.toolNames,
	)
	if err != nil {
		t.Fatalf("newResponseDecoder() error = %v", err)
	}

	frames := []string{
		`{"type":"message_start","message":{"id":"msg_chat_claude","type":"message","role":"assistant","model":"claude-sonnet-4","content":[],"usage":{"input_tokens":11,"output_tokens":0}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先分析"}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"claude-signature-live"}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
		`{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"准备调用工具"}}`,
		`{"type":"content_block_stop","index":1}`,
		`{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_weather_new","name":"weather","input":{}}}`,
		`{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"city\":"}}`,
		`{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"上海\"}"}}`,
		`{"type":"content_block_stop","index":2}`,
		`{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":9}}`,
		`{"type":"message_stop"}`,
	}
	for index, frame := range frames {
		if err := decoder.Apply("", []byte(frame)); err != nil {
			t.Fatalf(
				"decoder.Apply(frame=%d last_event=%s) error = %v",
				index,
				lastEvent,
				err,
			)
		}
	}
	if !decoder.Terminal() || !renderer.Terminal() {
		t.Fatalf(
			"terminal decoder=%t renderer=%t",
			decoder.Terminal(),
			renderer.Terminal(),
		)
	}
}
