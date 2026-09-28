package openairesponses

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/inference"
)

// 样本来自 Codex CLI 0.158.0-alpha.2.1（ChatGPT.app 捆绑）对 gpt-6-astra 的真实请求，
// 已裁剪说明文字并替换会话标识；first_turn 是首轮，tool_turn 是执行 exec 后的第二轮。

func loadCodex0158Fixture(t *testing.T, name string) []byte {
	t.Helper()
	body, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatalf("read fixture %s: %v", name, err)
	}
	return body
}

// TestRequestDecoderAcceptsCodex0158FirstTurn 验证 additional_tools、namespace 内 freeform
// 工具、reasoning.context 与 text.verbosity 全部进入 Canonical。
func TestRequestDecoderAcceptsCodex0158FirstTurn(t *testing.T) {
	t.Parallel()

	request, err := NewRequestDecoder().Decode(loadCodex0158Fixture(t, "codex_0158_first_turn.json"))
	if err != nil {
		t.Fatalf("Decode(first turn) error = %v", err)
	}
	var exec inference.ToolDefinition
	namespaces := map[string]int{}
	for _, tool := range request.Tools() {
		namespace, _ := tool.Namespace()
		namespaces[namespace]++
		if namespace == "functions" && tool.Name() == "exec" {
			exec = tool
		}
	}
	format, freeform := exec.Freeform()
	syntax, definition, grammar := format.Grammar()
	if !freeform || !grammar || syntax != "lark" || !bytes.Contains([]byte(definition), []byte("SOURCE")) {
		t.Fatalf("functions.exec freeform = %v grammar = %v syntax = %q", freeform, grammar, syntax)
	}
	if namespaces["functions"] == 0 || namespaces["clock"] == 0 || namespaces["collaboration"] == 0 {
		t.Fatalf("tool namespaces = %v", namespaces)
	}
	if verbosity, _ := request.TextVerbosity(); verbosity != inference.TextVerbosityLow {
		t.Fatalf("verbosity = %q", verbosity)
	}
	if context, _ := request.ReasoningContext(); context != inference.ReasoningContextAllTurns {
		t.Fatalf("reasoning context = %q", context)
	}
	if reasoning, _ := request.Reasoning(); reasoning.Effort() != inference.ReasoningEffortXHigh {
		t.Fatalf("effort = %q", reasoning.Effort())
	}
	for _, message := range request.Messages() {
		if message.Role() == inference.RoleUser || message.Role() == inference.RoleDeveloper {
			continue
		}
		t.Fatalf("unexpected first-turn message role %q", message.Role())
	}
}

// TestRequestDecoderAcceptsCodex0158ToolTurn 验证不带 namespace 的 custom_tool_call 还原为
// 已声明的 functions.exec，输入原样进入 {"input":...}，结果与调用精确配对。
func TestRequestDecoderAcceptsCodex0158ToolTurn(t *testing.T) {
	t.Parallel()

	request, err := NewRequestDecoder().Decode(loadCodex0158Fixture(t, "codex_0158_tool_turn.json"))
	if err != nil {
		t.Fatalf("Decode(tool turn) error = %v", err)
	}
	var call inference.ToolCallContent
	var result inference.ToolResultContent
	var callFound, resultFound bool
	for _, message := range request.Messages() {
		for _, content := range message.Contents() {
			switch typed := content.(type) {
			case inference.ToolCallContent:
				call, callFound = typed, true
			case inference.ToolResultContent:
				result, resultFound = typed, true
			}
		}
	}
	if !callFound || !resultFound || call.CallID() != result.CallID() {
		t.Fatalf("call found = %v result found = %v", callFound, resultFound)
	}
	if namespace, _ := call.Namespace(); namespace != "functions" || call.Name() != "exec" {
		t.Fatalf("call identity = %q/%q", namespace, call.Name())
	}
	input, err := inference.FreeformInputFromArguments(call.Arguments())
	if err != nil || input != "1+1" {
		t.Fatalf("call input = %q, %v", input, err)
	}
}

// TestRequestDecoderRejectsUndeclaredOrAmbiguousCustomCall 验证 custom_tool_call 只能引用
// 已声明且名称唯一的 freeform 工具，不猜测身份。
func TestRequestDecoderRejectsUndeclaredOrAmbiguousCustomCall(t *testing.T) {
	t.Parallel()

	grammar := `{"type":"grammar","syntax":"lark","definition":"start: /.+/"}`
	for name, body := range map[string]string{
		"undeclared": `{"model":"m","input":[{"type":"custom_tool_call","call_id":"c1","name":"exec","input":"x"}]}`,
		"ambiguous": `{"model":"m","tools":[` +
			`{"type":"namespace","name":"a","tools":[{"type":"custom","name":"exec","format":` + grammar + `}]},` +
			`{"type":"namespace","name":"b","tools":[{"type":"custom","name":"exec","format":` + grammar + `}]}],` +
			`"input":[{"type":"custom_tool_call","call_id":"c1","name":"exec","input":"x"}]}`,
		"function tool": `{"model":"m","tools":[{"type":"function","name":"exec","parameters":{"type":"object"}}],` +
			`"input":[{"type":"custom_tool_call","call_id":"c1","name":"exec","input":"x"}]}`,
	} {
		if _, err := NewRequestDecoder().Decode([]byte(body)); err == nil {
			t.Fatalf("%s custom call accepted", name)
		}
	}
}

// newCustomToolCallEvents 模拟 Codex 上游返回的 custom_tool_call：只带局部名称 exec，
// 输入按 Canonical 约定包成 {"input":...} 并分片到达。
func newCustomToolCallEvents(t *testing.T) []inference.StreamEvent {
	t.Helper()
	must := func(event inference.StreamEvent, err error) inference.StreamEvent {
		t.Helper()
		if err != nil {
			t.Fatalf("event error = %v", err)
		}
		return event
	}
	usage, err := inference.NewUsage(inference.UsageInput{InputTokens: 3, OutputTokens: 2})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	return []inference.StreamEvent{
		must(inference.NewResponseStartedEvent(0, "resp_custom_1", "gpt-6-astra")),
		must(inference.NewOutputItemStartedEvent(1, 0, "ctc_1", inference.OutputItemToolCall)),
		must(inference.NewToolCallStartedEvent(2, 0, 0, "call_1", "exec")),
		must(inference.NewToolArgumentsDeltaEvent(3, 0, 0, "call_1", `{"input":"1+`)),
		must(inference.NewToolCallCompletedEvent(4, 0, 0, "call_1", "exec", []byte(`{"input":"1+1\n"}`))),
		must(inference.NewOutputItemCompletedEvent(5, 0, "ctc_1")),
		must(inference.NewResponseCompletedEvent(6, inference.StopReasonToolUse, "", usage)),
	}
}

// TestStreamRendererProducesCustomToolCallLifecycle 验证调用声明为 freeform 的工具时，
// 客户端收到 custom_tool_call 与 custom_tool_call_input.*，而不是 function_call。
func TestStreamRendererProducesCustomToolCallLifecycle(t *testing.T) {
	t.Parallel()

	request, err := NewRequestDecoder().Decode(loadCodex0158Fixture(t, "codex_0158_first_turn.json"))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	renderer := NewStreamRenderer(request, time.Unix(1_700_000_000, 0))
	frames := renderTestEvents(t, renderer, newCustomToolCallEvents(t))
	assertRenderedNames(t, frames, []string{
		"response.created",
		"response.in_progress",
		"response.output_item.added",
		"response.custom_tool_call_input.delta",
		"response.custom_tool_call_input.done",
		"response.output_item.done",
		"response.completed",
	})
	var added, done struct {
		Item customToolCallItemWireDTO `json:"item"`
	}
	if err := json.Unmarshal(frames[2].Data(), &added); err != nil {
		t.Fatalf("unmarshal added error = %v", err)
	}
	if err := json.Unmarshal(frames[5].Data(), &done); err != nil {
		t.Fatalf("unmarshal done error = %v", err)
	}
	if added.Item.Type != "custom_tool_call" || added.Item.Name != "exec" || added.Item.Input != "" {
		t.Fatalf("added item = %#v", added.Item)
	}
	if done.Item.Type != "custom_tool_call" || done.Item.CallID != "call_1" || done.Item.Input != "1+1\n" {
		t.Fatalf("done item = %#v", done.Item)
	}
	if bytes.Contains(frames[5].Data(), []byte(`"namespace"`)) {
		t.Fatalf("custom_tool_call must not carry namespace: %s", frames[5].Data())
	}
	var inputDone struct {
		Input string `json:"input"`
	}
	if err := json.Unmarshal(frames[4].Data(), &inputDone); err != nil || inputDone.Input != "1+1\n" {
		t.Fatalf("input.done = %s, %v", frames[4].Data(), err)
	}

	aggregator := NewResponseAggregator(request, time.Unix(1_700_000_000, 0))
	for _, event := range newCustomToolCallEvents(t) {
		if err := aggregator.Add(event); err != nil {
			t.Fatalf("aggregator.Add() error = %v", err)
		}
	}
	body, err := aggregator.Marshal()
	if err != nil {
		t.Fatalf("aggregator.Marshal() error = %v", err)
	}
	var response struct {
		Output    []customToolCallItemWireDTO `json:"output"`
		Reasoning struct {
			Context string `json:"context"`
		} `json:"reasoning"`
		Text struct {
			Verbosity string `json:"verbosity"`
		} `json:"text"`
		Tools []json.RawMessage `json:"tools"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatalf("unmarshal response error = %v", err)
	}
	if len(response.Output) != 1 || response.Output[0].Type != "custom_tool_call" || response.Output[0].Input != "1+1\n" {
		t.Fatalf("aggregated output = %#v", response.Output)
	}
	if response.Reasoning.Context != "all_turns" || response.Text.Verbosity != "low" {
		t.Fatalf("echo reasoning/text = %#v %#v", response.Reasoning, response.Text)
	}
	if !bytes.Contains(body, []byte(`"type":"custom"`)) || !bytes.Contains(body, []byte(`"syntax":"lark"`)) {
		t.Fatalf("custom tool not echoed: %s", body)
	}
}
