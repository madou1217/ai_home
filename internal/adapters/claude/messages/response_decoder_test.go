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

// TestResponseDecoderKeepsRedactedThinkingDistinct 验证 Claude 上游
// redacted_thinking 不会被误标为 Responses encrypted_content。
func TestResponseDecoderKeepsRedactedThinkingDistinct(t *testing.T) {
	t.Parallel()

	var events []inference.StreamEvent
	decoder, err := newResponseDecoder(
		"claude-opus-5",
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("newResponseDecoder() error = %v", err)
	}
	frames := []string{
		`{"type":"message_start","message":{"id":"msg_redacted","type":"message","role":"assistant","model":"claude-opus-5","content":[],"usage":{"input_tokens":2,"output_tokens":0}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"redacted_thinking","data":"redacted-exact-1"}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}`,
		`{"type":"message_stop"}`,
	}
	for index, frame := range frames {
		if err := decoder.Apply("", []byte(frame)); err != nil {
			t.Fatalf("Apply(frame=%d) error = %v", index, err)
		}
	}
	for _, event := range events {
		completed, ok := event.(inference.ReasoningCompletedEvent)
		if !ok {
			continue
		}
		content := completed.Content()
		if content.ReasoningKind() != inference.ReasoningRedacted ||
			content.RedactedData() != "redacted-exact-1" ||
			content.EncryptedData() != "" {
			t.Fatalf("redacted content = %#v", content)
		}
		return
	}
	t.Fatal("missing redacted reasoning completion")
}

// TestResponseDecoderPreservesWebSearchPairingAndCitation 验证服务器搜索调用、
// 隐藏结果块、连续输出索引和网页引用形成一个完整且可验证的生命周期。
func TestResponseDecoderPreservesWebSearchPairingAndCitation(t *testing.T) {
	t.Parallel()

	var events []inference.StreamEvent
	decoder, err := newResponseDecoder(
		"claude-opus-5",
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("newResponseDecoder() error = %v", err)
	}
	frames := []string{
		`{"type":"message_start","message":{"id":"msg_web","type":"message","role":"assistant","model":"claude-opus-5","content":[],"usage":{"input_tokens":3,"output_tokens":0}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{}}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"AIH\"}"}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"content_block_start","index":1,"content_block":{"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[{"type":"web_search_result","encrypted_content":"enc_1","page_age":null,"title":"AIH","url":"https://example.com/aih"}]}}`,
		`{"type":"content_block_stop","index":1}`,
		`{"type":"content_block_start","index":2,"content_block":{"type":"text","text":"","citations":[]}}`,
		`{"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"根据资料"}}`,
		`{"type":"content_block_delta","index":2,"delta":{"type":"citations_delta","citation":{"type":"web_search_result_location","cited_text":"AIH source","encrypted_index":"idx_1","title":"AIH","url":"https://example.com/aih"}}}`,
		`{"type":"content_block_stop","index":2}`,
		`{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":4}}`,
		`{"type":"message_stop"}`,
	}
	for index, frame := range frames {
		if err := decoder.Apply("", []byte(frame)); err != nil {
			t.Fatalf("Apply(frame=%d) error = %v", index, err)
		}
	}
	var outputIndexes []uint32
	var action inference.WebSearchAction
	var citation inference.URLCitation
	for _, event := range events {
		switch typed := event.(type) {
		case inference.OutputItemStartedEvent:
			outputIndexes = append(outputIndexes, typed.OutputIndex())
		case inference.WebSearchCompletedEvent:
			action = typed.Action()
		case inference.URLCitationAddedEvent:
			citation = typed.Citation()
		}
	}
	if len(outputIndexes) != 2 || outputIndexes[0] != 0 || outputIndexes[1] != 1 ||
		action.Kind() != inference.WebSearchActionSearch || action.Query() != "AIH" ||
		citation.StartIndex() != 4 || citation.EndIndex() != 4 ||
		citation.URL() != "https://example.com/aih" || !decoder.Terminal() {
		t.Fatalf(
			"indexes=%v action=%#v citation=%#v terminal=%t",
			outputIndexes,
			action,
			citation,
			decoder.Terminal(),
		)
	}
}

// TestResponseDecoderRejectsUnpairedWebSearch 验证缺失结果块的服务器搜索
// 不会在 message_stop 时被伪装成成功响应。
func TestResponseDecoderRejectsUnpairedWebSearch(t *testing.T) {
	t.Parallel()

	decoder, err := newResponseDecoder(
		"claude-opus-5",
		func(inference.StreamEvent) error { return nil },
	)
	if err != nil {
		t.Fatalf("newResponseDecoder() error = %v", err)
	}
	frames := []string{
		`{"type":"message_start","message":{"id":"msg_unpaired","type":"message","role":"assistant","model":"claude-opus-5","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"server_tool_use","id":"srvtoolu_missing","name":"web_search","input":{}}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"AIH\"}"}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}`,
	}
	for index, frame := range frames {
		if err := decoder.Apply("", []byte(frame)); err != nil {
			t.Fatalf("Apply(frame=%d) error = %v", index, err)
		}
	}
	if err := decoder.Apply("", []byte(`{"type":"message_stop"}`)); !errorsIsInvalidResponse(err) {
		t.Fatalf("Apply(message_stop) error = %v", err)
	}
}

// TestResponseDecoderRestoresNamespacedToolIdentity 验证 Claude 返回的扁平
// 名称通过本次请求映射恢复为准确 namespace，而不是猜测字符串分隔符。
func TestResponseDecoderRestoresNamespacedToolIdentity(t *testing.T) {
	t.Parallel()

	gmailTool := mustNamespacedToolDefinition(t, "gmail", "Gmail", "search")
	calendarTool := mustNamespacedToolDefinition(t, "calendar", "Calendar", "search")
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolOpenAIResponses,
		Model:          "claude",
		Messages: []inference.Message{
			mustMessage(t, inference.RoleUser, mustText(t, "search")),
		},
		Tools: []inference.ToolDefinition{gmailTool, calendarTool},
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	mapper, err := newToolNameMapper(request)
	if err != nil {
		t.Fatalf("newToolNameMapper() error = %v", err)
	}
	wireName, err := mapper.encode(calendarTool.Identity())
	if err != nil {
		t.Fatalf("mapper.encode() error = %v", err)
	}

	var events []inference.StreamEvent
	decoder, err := newResponseDecoder(
		"claude-opus-5",
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
		mapper,
	)
	if err != nil {
		t.Fatalf("newResponseDecoder() error = %v", err)
	}
	frames := []string{
		`{"type":"message_start","message":{"id":"msg_namespace","type":"message","role":"assistant","model":"claude-opus-5","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}`,
		`{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_namespace","name":"` + wireName + `","input":{}}}`,
		`{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"AIH\"}"}}`,
		`{"type":"content_block_stop","index":0}`,
		`{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":1}}`,
		`{"type":"message_stop"}`,
	}
	for index, frame := range frames {
		if err := decoder.Apply("", []byte(frame)); err != nil {
			t.Fatalf("Apply(frame=%d) error = %v", index, err)
		}
	}
	var completed inference.ToolCallCompletedEvent
	for _, event := range events {
		if typed, ok := event.(inference.ToolCallCompletedEvent); ok {
			completed = typed
		}
	}
	namespace, namespaced := completed.Namespace()
	if !namespaced || namespace != "calendar" || completed.Name() != "search" ||
		string(completed.Arguments()) != `{"query":"AIH"}` {
		t.Fatalf("completed = %#v namespace=(%q,%t)", completed, namespace, namespaced)
	}
}

// TestResponseDecoderPreservesNonStreamingWebCitation 验证兼容端点返回完整
// JSON Message 时，搜索调用、隐藏结果和引用与 SSE 路径保持相同语义。
func TestResponseDecoderPreservesNonStreamingWebCitation(t *testing.T) {
	t.Parallel()

	var events []inference.StreamEvent
	decoder, err := newResponseDecoder(
		"claude-opus-5",
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("newResponseDecoder() error = %v", err)
	}
	payload := []byte(`{
		"id":"msg_web_json",
		"type":"message",
		"role":"assistant",
		"model":"claude-opus-5",
		"content":[
			{"type":"server_tool_use","id":"srvtoolu_json","name":"web_search","input":{"query":"AIH"}},
			{"type":"web_search_tool_result","tool_use_id":"srvtoolu_json","content":[{"type":"web_search_result","encrypted_content":"enc_json","page_age":null,"title":"AIH","url":"https://example.com/aih"}]},
			{"type":"text","text":"根据资料","citations":[{"type":"web_search_result_location","cited_text":"AIH source","encrypted_index":"idx_json","title":"AIH","url":"https://example.com/aih"}]}
		],
		"stop_reason":"end_turn",
		"stop_sequence":null,
		"usage":{"input_tokens":3,"output_tokens":4}
	}`)
	if err := decoder.DecodeMessage(payload); err != nil {
		t.Fatalf("DecodeMessage() error = %v", err)
	}

	var outputIndexes []uint32
	var action inference.WebSearchAction
	var citation inference.URLCitation
	for _, event := range events {
		switch typed := event.(type) {
		case inference.OutputItemStartedEvent:
			outputIndexes = append(outputIndexes, typed.OutputIndex())
		case inference.WebSearchCompletedEvent:
			action = typed.Action()
		case inference.URLCitationAddedEvent:
			citation = typed.Citation()
		}
	}
	if len(outputIndexes) != 2 || outputIndexes[0] != 0 || outputIndexes[1] != 1 ||
		action.Kind() != inference.WebSearchActionSearch || action.Query() != "AIH" ||
		citation.StartIndex() != 4 || citation.EndIndex() != 4 ||
		citation.Title() != "AIH" || citation.URL() != "https://example.com/aih" ||
		!decoder.Terminal() {
		t.Fatalf(
			"indexes=%v action=%#v citation=%#v terminal=%t",
			outputIndexes,
			action,
			citation,
			decoder.Terminal(),
		)
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
