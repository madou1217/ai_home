package responses

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// TestResponseDecoderPreservesFullResponsesLifecycle 验证 output_item.done
// 能补齐缺失文本，并保留 reasoning、function/custom tool 和 usage。
func TestResponseDecoderPreservesFullResponsesLifecycle(t *testing.T) {
	t.Parallel()

	events := make([]inference.StreamEvent, 0, 40)
	decoder, err := newResponseDecoder(
		"gpt-5.6-sol",
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("newResponseDecoder() error = %v", err)
	}
	stream := []string{
		`{"type":"response.created","response":{"id":"resp_full","model":"gpt-5.6-sol","status":"in_progress"}}`,
		`{"type":"response.output_item.added","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","status":"in_progress","content":[]}}`,
		`{"type":"response.output_item.done","output_index":0,"item":{"id":"msg_1","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"你好，世界"}]}}`,
		`{"type":"response.output_item.added","output_index":1,"item":{"id":"rs_1","type":"reasoning","status":"in_progress","summary":[]}}`,
		`{"type":"response.reasoning_summary_part.added","output_index":1,"summary_index":0,"item_id":"rs_1","part":{"type":"summary_text","text":""}}`,
		`{"type":"response.reasoning_summary_text.delta","output_index":1,"summary_index":0,"item_id":"rs_1","delta":"先"}`,
		`{"type":"response.reasoning_summary_text.done","output_index":1,"summary_index":0,"item_id":"rs_1","text":"先分析"}`,
		`{"type":"response.reasoning_summary_part.done","output_index":1,"summary_index":0,"item_id":"rs_1","part":{"type":"summary_text","text":"先分析"}}`,
		`{"type":"response.output_item.done","output_index":1,"item":{"id":"rs_1","type":"reasoning","status":"completed","summary":[{"type":"summary_text","text":"先分析"}],"encrypted_content":"encrypted_state"}}`,
		`{"type":"response.output_item.added","output_index":2,"item":{"id":"fc_1","type":"function_call","status":"in_progress","call_id":"call_1","name":"get_weather","arguments":""}}`,
		`{"type":"response.function_call_arguments.delta","output_index":2,"item_id":"fc_1","call_id":"call_1","delta":"{\"city\":"}`,
		`{"type":"response.function_call_arguments.done","output_index":2,"item_id":"fc_1","call_id":"call_1","arguments":"{\"city\":\"上海\"}"}`,
		`{"type":"response.output_item.done","output_index":2,"item":{"id":"fc_1","type":"function_call","status":"completed","call_id":"call_1","name":"get_weather","arguments":"{\"city\":\"上海\"}"}}`,
		`{"type":"response.output_item.added","output_index":3,"item":{"id":"ct_1","type":"custom_tool_call","status":"in_progress","call_id":"call_2","name":"shell","input":""}}`,
		`{"type":"response.custom_tool_call_input.delta","output_index":3,"item_id":"ct_1","call_id":"call_2","delta":"echo "}`,
		`{"type":"response.custom_tool_call_input.done","output_index":3,"item_id":"ct_1","call_id":"call_2","input":"echo hi"}`,
		`{"type":"response.output_item.done","output_index":3,"item":{"id":"ct_1","type":"custom_tool_call","status":"completed","call_id":"call_2","name":"shell","input":"echo hi"}}`,
		`{"type":"response.completed","response":{"id":"resp_full","model":"gpt-5.6-sol","status":"completed","end_turn":false,"output":[],"usage":{"input_tokens":11,"input_tokens_details":{"cached_tokens":3},"output_tokens":7,"output_tokens_details":{"reasoning_tokens":2},"total_tokens":18}}}`,
	}
	for index, payload := range stream {
		var wire streamEventDTO
		if err := json.Unmarshal([]byte(payload), &wire); err != nil {
			t.Fatalf("json.Unmarshal(%d) error = %v", index, err)
		}
		if err := decoder.Apply(wire); err != nil {
			t.Fatalf("Apply(%d, %s) error = %v", index, wire.Type, err)
		}
	}
	if !decoder.Terminal() {
		t.Fatal("decoder.Terminal() = false")
	}
	for index, event := range events {
		if event.Sequence() != uint64(index) {
			t.Fatalf(
				"events[%d].Sequence() = %d",
				index,
				event.Sequence(),
			)
		}
	}
	assertDecodedText(t, events, "你好，世界")
	assertDecodedReasoning(t, events)
	assertDecodedTools(t, events)
	terminal, ok := events[len(events)-1].(inference.ResponseCompletedEvent)
	if !ok ||
		terminal.StopReason() != inference.StopReasonToolUse ||
		terminal.Usage().TotalTokens() != 18 ||
		terminal.Usage().CachedInputTokens() != 3 ||
		terminal.Usage().ReasoningTokens() != 2 {
		t.Fatalf("terminal = %#v", events[len(events)-1])
	}
	t.Logf(
		"canonical events=%d terminal=%s usage=%d",
		len(events),
		terminal.StopReason(),
		terminal.Usage().TotalTokens(),
	)
}

// TestResponseDecoderReconstructsNonStreamIncomplete 验证完整 JSON
// 响应复用同一状态机，并把 max_output_tokens 映射为规范终态。
func TestResponseDecoderReconstructsNonStreamIncomplete(t *testing.T) {
	t.Parallel()

	events := make([]inference.StreamEvent, 0, 10)
	decoder, err := newResponseDecoder(
		"gpt-5.6-sol",
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("newResponseDecoder() error = %v", err)
	}
	raw := `{
		"type":"response.incomplete",
		"response":{
			"id":"resp_incomplete",
			"model":"gpt-5.6-sol",
			"status":"incomplete",
			"output":[{
				"id":"msg_limit",
				"type":"message",
				"role":"assistant",
				"status":"completed",
				"content":[{"type":"output_text","text":"部分答案"}]
			}],
			"usage":{"input_tokens":4,"output_tokens":8,"total_tokens":12},
			"incomplete_details":{"reason":"max_output_tokens"}
		}
	}`
	var event streamEventDTO
	if err := json.Unmarshal([]byte(raw), &event); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if err := decoder.Apply(event); err != nil {
		t.Fatalf("Apply() error = %v", err)
	}
	terminal := events[len(events)-1].(inference.ResponseCompletedEvent)
	if terminal.StopReason() != inference.StopReasonMaxTokens ||
		terminal.Usage().TotalTokens() != 12 {
		t.Fatalf(
			"terminal stop=%s usage=%d",
			terminal.StopReason(),
			terminal.Usage().TotalTokens(),
		)
	}
}

// TestResponseDecoderPropagatesEventSinkBackpressure 验证调用方错误不被
// 错误分类为 Provider malformed response。
func TestResponseDecoderPropagatesEventSinkBackpressure(t *testing.T) {
	t.Parallel()

	backpressure := errors.New("test sink stopped")
	decoder, err := newResponseDecoder(
		"gpt-5.6-sol",
		func(inference.StreamEvent) error {
			return backpressure
		},
	)
	if err != nil {
		t.Fatalf("newResponseDecoder() error = %v", err)
	}
	var event streamEventDTO
	if err := json.Unmarshal(
		[]byte(`{"type":"response.created","response":{"id":"resp_backpressure","model":"gpt-5.6-sol"}}`),
		&event,
	); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	err = decoder.Apply(event)
	var sinkErr eventSinkError
	if !errors.As(err, &sinkErr) ||
		!errors.Is(sinkErr.Cause(), backpressure) {
		t.Fatalf("Apply() error = %v", err)
	}
}

// TestResponseDecoderHandlesStreamingContentVariants 验证 message text、
// refusal 和 raw reasoning 的 added/delta/done 顺序，以及重复终态校验。
func TestResponseDecoderHandlesStreamingContentVariants(t *testing.T) {
	t.Parallel()

	events := make([]inference.StreamEvent, 0, 40)
	decoder, err := newResponseDecoder(
		"gpt-5.6-sol",
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("newResponseDecoder() error = %v", err)
	}
	stream := []string{
		`{"type":"response.created","response":{"id":"resp_variants","model":"gpt-5.6-sol"}}`,
		`{"type":"response.output_item.added","output_index":0,"item":{"id":"msg_text","type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":""}]}}`,
		`{"type":"response.content_part.added","output_index":0,"content_index":0,"item_id":"msg_text","part":{"type":"output_text","text":""}}`,
		`{"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg_text","delta":"进度"}`,
		`{"type":"response.output_text.done","output_index":0,"content_index":0,"item_id":"msg_text","text":"进度完成"}`,
		`{"type":"response.content_part.done","output_index":0,"content_index":0,"item_id":"msg_text","part":{"type":"output_text","text":"进度完成"}}`,
		`{"type":"response.output_item.done","output_index":0,"item":{"id":"msg_text","type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"进度完成"}]}}`,
		`{"type":"response.output_item.added","output_index":1,"item":{"id":"msg_refusal","type":"message","role":"assistant","content":[]}}`,
		`{"type":"response.content_part.added","output_index":1,"content_index":0,"item_id":"msg_refusal","part":{"type":"refusal","refusal":""}}`,
		`{"type":"response.refusal.delta","output_index":1,"content_index":0,"item_id":"msg_refusal","delta":"不能"}`,
		`{"type":"response.refusal.done","output_index":1,"content_index":0,"item_id":"msg_refusal","refusal":"不能执行"}`,
		`{"type":"response.content_part.done","output_index":1,"content_index":0,"item_id":"msg_refusal","part":{"type":"refusal","refusal":"不能执行"}}`,
		`{"type":"response.output_item.done","output_index":1,"item":{"id":"msg_refusal","type":"message","role":"assistant","content":[{"type":"refusal","refusal":"不能执行"}]}}`,
		`{"type":"response.output_item.added","output_index":2,"item":{"id":"rs_raw","type":"reasoning","content":[{"type":"reasoning_text","text":""}]}}`,
		`{"type":"response.reasoning_text.delta","output_index":2,"content_index":0,"item_id":"rs_raw","delta":"检查"}`,
		`{"type":"response.reasoning_text.done","output_index":2,"content_index":0,"item_id":"rs_raw","text":"检查完成"}`,
		`{"type":"response.output_item.done","output_index":2,"item":{"id":"rs_raw","type":"reasoning","content":[{"type":"reasoning_text","text":"检查完成"}]}}`,
		`{"type":"response.completed","response":{"id":"resp_variants","model":"gpt-5.6-sol","status":"completed","end_turn":true,"output":[{"id":"msg_text","type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"进度完成"}]},{"id":"msg_refusal","type":"message","role":"assistant","content":[{"type":"refusal","refusal":"不能执行"}]},{"id":"rs_raw","type":"reasoning","content":[{"type":"reasoning_text","text":"检查完成"}]}],"usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7}}}`,
	}
	for index, payload := range stream {
		var event streamEventDTO
		if err := json.Unmarshal([]byte(payload), &event); err != nil {
			t.Fatalf("json.Unmarshal(%d) error = %v", index, err)
		}
		if err := decoder.Apply(event); err != nil {
			t.Fatalf("Apply(%d, %s) error = %v", index, event.Type, err)
		}
	}
	var refusal string
	var rawReasoning string
	for _, event := range events {
		switch typed := event.(type) {
		case inference.RefusalCompletedEvent:
			refusal = typed.Refusal()
		case inference.ReasoningCompletedEvent:
			if typed.Content().ReasoningKind() == inference.ReasoningSummary {
				rawReasoning = typed.Content().Text()
			}
		}
	}
	if refusal != "不能执行" ||
		rawReasoning != "检查完成" ||
		!decoder.Terminal() {
		t.Fatalf(
			"refusal=%q reasoning=%q terminal=%t",
			refusal,
			rawReasoning,
			decoder.Terminal(),
		)
	}
}

// TestResponseDecoderRejectsTerminalSnapshotOmissions 验证终态不能遗漏已经
// 通过流式事件完成的 message 或 reasoning 内容块。
func TestResponseDecoderRejectsTerminalSnapshotOmissions(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		events []string
	}{
		{
			name: "message",
			events: []string{
				`{"type":"response.created","response":{"id":"resp_message_omission","model":"gpt-5.6-sol"}}`,
				`{"type":"response.output_item.added","output_index":0,"item":{"id":"msg_omission","type":"message","role":"assistant","content":[]}}`,
				`{"type":"response.content_part.done","output_index":0,"content_index":0,"item_id":"msg_omission","part":{"type":"output_text","text":"不能遗漏"}}`,
				`{"type":"response.output_item.done","output_index":0,"item":{"id":"msg_omission","type":"message","role":"assistant","content":[]}}`,
			},
		},
		{
			name: "reasoning",
			events: []string{
				`{"type":"response.created","response":{"id":"resp_reasoning_omission","model":"gpt-5.6-sol"}}`,
				`{"type":"response.output_item.added","output_index":0,"item":{"id":"rs_omission","type":"reasoning","summary":[]}}`,
				`{"type":"response.reasoning_summary_part.done","output_index":0,"summary_index":0,"item_id":"rs_omission","part":{"type":"summary_text","text":"不能遗漏"}}`,
				`{"type":"response.output_item.done","output_index":0,"item":{"id":"rs_omission","type":"reasoning","summary":[]}}`,
			},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			decoder, err := newResponseDecoder(
				"gpt-5.6-sol",
				func(inference.StreamEvent) error {
					return nil
				},
			)
			if err != nil {
				t.Fatalf("newResponseDecoder() error = %v", err)
			}
			for index, payload := range test.events {
				var event streamEventDTO
				if err := json.Unmarshal([]byte(payload), &event); err != nil {
					t.Fatalf("json.Unmarshal(%d) error = %v", index, err)
				}
				err = decoder.Apply(event)
				if index == len(test.events)-1 {
					if !errors.Is(err, ErrInvalidUpstreamResponse) {
						t.Fatalf("Apply(%d) error = %v", index, err)
					}
					return
				}
				if err != nil {
					t.Fatalf("Apply(%d) error = %v", index, err)
				}
			}
			t.Fatal("终态遗漏未被拒绝")
		})
	}
}

// TestResponseDecoderRejectsMismatchedDoneItemID 验证事件外层 item_id
// 不能与完成快照中的稳定身份冲突。
func TestResponseDecoderRejectsMismatchedDoneItemID(t *testing.T) {
	t.Parallel()

	decoder, err := newResponseDecoder(
		"gpt-5.6-sol",
		func(inference.StreamEvent) error {
			return nil
		},
	)
	if err != nil {
		t.Fatalf("newResponseDecoder() error = %v", err)
	}
	var created streamEventDTO
	if err := json.Unmarshal(
		[]byte(`{"type":"response.created","response":{"id":"resp_item_id","model":"gpt-5.6-sol"}}`),
		&created,
	); err != nil {
		t.Fatalf("json.Unmarshal(created) error = %v", err)
	}
	if err := decoder.Apply(created); err != nil {
		t.Fatalf("Apply(created) error = %v", err)
	}
	var done streamEventDTO
	if err := json.Unmarshal(
		[]byte(`{"type":"response.output_item.done","output_index":0,"item_id":"msg_other","item":{"id":"msg_exact","type":"message","role":"assistant","content":[]}}`),
		&done,
	); err != nil {
		t.Fatalf("json.Unmarshal(done) error = %v", err)
	}
	if err := decoder.Apply(done); !errors.Is(
		err,
		ErrInvalidUpstreamResponse,
	) {
		t.Fatalf("Apply(done) error = %v", err)
	}
}

// BenchmarkResponseDecoderTextStream 测量完整文本流进入 Canonical 事件的成本。
func BenchmarkResponseDecoderTextStream(benchmark *testing.B) {
	payloads := []string{
		`{"type":"response.created","response":{"id":"resp_bench","model":"gpt-5.6-sol"}}`,
		`{"type":"response.output_item.added","output_index":0,"item":{"id":"msg_bench","type":"message","role":"assistant","content":[]}}`,
		`{"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg_bench","delta":"hello "}`,
		`{"type":"response.output_text.delta","output_index":0,"content_index":0,"item_id":"msg_bench","delta":"world"}`,
		`{"type":"response.output_item.done","output_index":0,"item":{"id":"msg_bench","type":"message","role":"assistant","content":[{"type":"output_text","text":"hello world"}]}}`,
		`{"type":"response.completed","response":{"id":"resp_bench","model":"gpt-5.6-sol","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}`,
	}
	wireEvents := make([]streamEventDTO, len(payloads))
	for index, payload := range payloads {
		if err := json.Unmarshal([]byte(payload), &wireEvents[index]); err != nil {
			benchmark.Fatalf("json.Unmarshal(%d) error = %v", index, err)
		}
	}
	benchmark.ReportAllocs()
	benchmark.ResetTimer()
	for iteration := 0; iteration < benchmark.N; iteration++ {
		decoder, err := newResponseDecoder(
			"gpt-5.6-sol",
			func(inference.StreamEvent) error {
				return nil
			},
		)
		if err != nil {
			benchmark.Fatalf("newResponseDecoder() error = %v", err)
		}
		for _, event := range wireEvents {
			if err := decoder.Apply(event); err != nil {
				benchmark.Fatalf("Apply() error = %v", err)
			}
		}
	}
}

// assertDecodedText 验证 done 快照补出了文本增量和终值。
func assertDecodedText(
	t *testing.T,
	events []inference.StreamEvent,
	want string,
) {
	t.Helper()

	var delta string
	var completed string
	for _, event := range events {
		switch typed := event.(type) {
		case inference.TextDeltaEvent:
			delta += typed.Delta()
		case inference.TextCompletedEvent:
			completed = typed.Text()
		}
	}
	if delta != want || completed != want {
		t.Fatalf("text delta=%q completed=%q", delta, completed)
	}
}

// assertDecodedReasoning 验证摘要和 encrypted continuity 分属不同块。
func assertDecodedReasoning(
	t *testing.T,
	events []inference.StreamEvent,
) {
	t.Helper()

	var summary string
	var encrypted string
	for _, event := range events {
		completed, ok := event.(inference.ReasoningCompletedEvent)
		if !ok {
			continue
		}
		switch completed.Content().ReasoningKind() {
		case inference.ReasoningSummary:
			summary = completed.Content().Text()
		case inference.ReasoningEncrypted:
			encrypted = completed.Content().EncryptedData()
		}
	}
	if summary != "先分析" || encrypted != "encrypted_state" {
		t.Fatalf("reasoning summary=%q encrypted=%q", summary, encrypted)
	}
}

// assertDecodedTools 验证 function 和 custom tool 都形成合法 JSON 参数。
func assertDecodedTools(
	t *testing.T,
	events []inference.StreamEvent,
) {
	t.Helper()

	arguments := make(map[string]string)
	for _, event := range events {
		completed, ok := event.(inference.ToolCallCompletedEvent)
		if !ok {
			continue
		}
		arguments[completed.CallID()] = string(completed.Arguments())
	}
	if arguments["call_1"] != `{"city":"上海"}` ||
		arguments["call_2"] != `{"input":"echo hi"}` {
		t.Fatalf("tool arguments = %#v", arguments)
	}
}
