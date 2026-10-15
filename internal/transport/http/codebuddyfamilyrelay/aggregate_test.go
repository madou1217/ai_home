package codebuddyfamilyrelay

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// fixedClock 给聚合器一个确定的时钟，让兜底 id/created 可断言。
func fixedClock() time.Time { return time.Unix(1792025000, 0) }

// aggregateChoiceOf 聚合后取出唯一 choice。
func aggregateChoiceOf(t *testing.T, sse string) map[string]json.RawMessage {
	t.Helper()
	result := AggregateSSE([]byte(sse), fixedClock)
	if len(result.Payload) == 0 {
		t.Fatal("聚合结果为空")
	}
	payload, ok := decodeRawObject(result.Payload)
	if !ok {
		t.Fatalf("聚合结果不是对象: %s", result.Payload)
	}
	choices := rawArray(payload["choices"])
	if len(choices) != 1 {
		t.Fatalf("choices 必须恰好一个: %s", payload["choices"])
	}
	choice, ok := decodeRawObject(choices[0])
	if !ok {
		t.Fatalf("choice 不是对象: %s", choices[0])
	}
	return choice
}

// messageOf 取聚合结果里的 message。
func messageOf(t *testing.T, sse string) map[string]json.RawMessage {
	t.Helper()
	choice := aggregateChoiceOf(t, sse)
	message, ok := decodeRawObject(choice["message"])
	if !ok {
		t.Fatalf("message 不是对象: %s", choice["message"])
	}
	return message
}

func TestAggregateSSEConcatenatesContent(t *testing.T) {
	sse := strings.Join([]string{
		`data: {"id":"cmb-1","model":"hy4-preview","created":1792025000,"choices":[{"delta":{"role":"assistant","content":"he"}}]}`,
		`data: {"choices":[{"delta":{"content":"llo"},"finish_reason":null}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}`,
		`data: [DONE]`,
		``,
	}, "\n")
	choice := aggregateChoiceOf(t, sse)
	message := messageOf(t, sse)
	if content, _ := rawString(message["content"]); content != "hello" {
		t.Fatalf("content 拼接错误: %s", message["content"])
	}
	if reason, _ := rawString(choice["finish_reason"]); reason != "stop" {
		t.Fatalf("finish_reason 错误: %s", choice["finish_reason"])
	}
	result := AggregateSSE([]byte(sse), fixedClock)
	if !result.SawDone || !result.SawChunk {
		t.Fatalf("SawDone/SawChunk 应为 true: %+v", result)
	}
}

// ⑦ 非流式聚合不变量：声称要调用工具就必须给出可执行的工具调用。
func TestAggregateSSEToolCallsAreExecutable(t *testing.T) {
	sse := strings.Join([]string{
		`data: {"id":"cmb-2","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"path\":"}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"a.txt\"}"}}]},"finish_reason":"tool_calls"}]}`,
		`data: [DONE]`,
		``,
	}, "\n")
	choice := aggregateChoiceOf(t, sse)
	if reason, _ := rawString(choice["finish_reason"]); reason != "tool_calls" {
		t.Fatalf("finish_reason 应为 tool_calls: %s", choice["finish_reason"])
	}
	calls := rawArray(messageOf(t, sse)["tool_calls"])
	if len(calls) != 1 {
		t.Fatalf("必须给出 1 个可执行工具调用: %s", calls)
	}
	call, ok := decodeRawObject(calls[0])
	if !ok {
		t.Fatalf("工具调用不是对象: %s", calls[0])
	}
	if id, _ := rawString(call["id"]); id != "call_1" {
		t.Fatalf("id 错误: %s", call["id"])
	}
	if callType, _ := rawString(call["type"]); callType != "function" {
		t.Fatalf("type 错误: %s", call["type"])
	}
	function, _ := decodeRawObject(call["function"])
	name, _ := rawString(function["name"])
	arguments, _ := rawString(function["arguments"])
	if name != "read_file" || arguments != `{"path":"a.txt"}` {
		t.Fatalf("工具调用内容错误: name=%q arguments=%q", name, arguments)
	}
	// 非流式形态不带流式分片序号 index（那是 delta 的字段）。
	if _, ok := call["index"]; ok {
		t.Fatal("非流式 tool_calls 不应带 index")
	}
}

func TestAggregateSSEParallelToolCallsAreOrderedByIndex(t *testing.T) {
	sse := strings.Join([]string{
		`data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","function":{"name":"b","arguments":"{}"}}]}}]}`,
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"a","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}`,
		``,
	}, "\n")
	calls := rawArray(messageOf(t, sse)["tool_calls"])
	if len(calls) != 2 {
		t.Fatalf("应有 2 个工具调用: %s", calls)
	}
	first, _ := decodeRawObject(calls[0])
	second, _ := decodeRawObject(calls[1])
	if id, _ := rawString(first["id"]); id != "call_a" {
		t.Fatalf("应按 index 升序排列，实际第一个是 %s", id)
	}
	if id, _ := rawString(second["id"]); id != "call_b" {
		t.Fatalf("应按 index 升序排列，实际第二个是 %s", id)
	}
}

func TestAggregateSSELegacyFunctionCall(t *testing.T) {
	sse := strings.Join([]string{
		`data: {"choices":[{"delta":{"function_call":{"name":"get_weather","arguments":""}}}]}`,
		`data: {"choices":[{"delta":{"function_call":{"name":"","arguments":"{\"city\":"}}}]}`,
		`data: {"choices":[{"delta":{"function_call":{"name":"","arguments":"\"sf\"}"}},"finish_reason":"tool_calls"}]}`,
		``,
	}, "\n")
	message := messageOf(t, sse)
	legacy, ok := decodeRawObject(message["function_call"])
	if !ok {
		t.Fatalf("缺少 function_call: %s", message)
	}
	name, _ := rawString(legacy["name"])
	arguments, _ := rawString(legacy["arguments"])
	if name != "get_weather" || arguments != `{"city":"sf"}` {
		t.Fatalf("function_call 内容错误: name=%q arguments=%q", name, arguments)
	}
}

// 反例守卫：空 tool_calls 不得凭空造出可执行的工具，也不得因此丢掉 finish_reason。
func TestAggregateSSEEmptyToolCallsDoesNotFabricate(t *testing.T) {
	sse := `data: {"choices":[{"delta":{"content":"","tool_calls":[]},"finish_reason":"tool_calls"}]}` + "\n"
	choice := aggregateChoiceOf(t, sse)
	if reason, _ := rawString(choice["finish_reason"]); reason != "tool_calls" {
		t.Fatalf("finish_reason 不得丢失: %s", choice["finish_reason"])
	}
	if _, ok := messageOf(t, sse)["tool_calls"]; ok {
		t.Fatal("空 tool_calls 不得凭空造出字段")
	}
}

// 空占位（上游富字段里的 {name:”,arguments:”}）同样不得造出 function_call。
func TestAggregateSSEEmptyLegacyFunctionCallDoesNotFabricate(t *testing.T) {
	sse := `data: {"choices":[{"delta":{"content":"hi","function_call":{"name":"","arguments":""}},"finish_reason":"stop"}]}` + "\n"
	if _, ok := messageOf(t, sse)["function_call"]; ok {
		t.Fatal("空 function_call 占位不得被照抄")
	}
}

func TestAggregateSSEPassesThroughIdentityAndUsage(t *testing.T) {
	sse := strings.Join([]string{
		`data: {"id":"cmb-9","model":"hy4-preview","created":1792025000,"choices":[{"delta":{"content":"x"}}]}`,
		`data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18}}`,
		``,
	}, "\n")
	payload, ok := decodeRawObject(AggregateSSE([]byte(sse), fixedClock).Payload)
	if !ok {
		t.Fatal("聚合结果不是对象")
	}
	if id, _ := rawString(payload["id"]); id != "cmb-9" {
		t.Fatalf("id 未透传: %s", payload["id"])
	}
	if model, _ := rawString(payload["model"]); model != "hy4-preview" {
		t.Fatalf("model 未透传: %s", payload["model"])
	}
	if created, _ := rawInt64(payload["created"]); created != 1792025000 {
		t.Fatalf("created 未透传: %s", payload["created"])
	}
	if object, _ := rawString(payload["object"]); object != "chat.completion" {
		t.Fatalf("object 必须是 chat.completion: %s", payload["object"])
	}
	// usage 保留上游原始字节，不重建。
	if !strings.Contains(string(payload["usage"]), `"total_tokens":18`) {
		t.Fatalf("usage 未透传: %s", payload["usage"])
	}
}

func TestAggregateSSEFallsBackOnIdentity(t *testing.T) {
	sse := `data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}` + "\n"
	payload, _ := decodeRawObject(AggregateSSE([]byte(sse), fixedClock).Payload)
	if id, _ := rawString(payload["id"]); !strings.HasPrefix(id, "chatcmpl-codebuddy-") {
		t.Fatalf("缺少 id 时必须给兜底 id: %s", payload["id"])
	}
	if model, _ := rawString(payload["model"]); model != "unknown" {
		t.Fatalf("缺少 model 时必须给 unknown: %s", payload["model"])
	}
	if created, _ := rawInt64(payload["created"]); created != 1792025000 {
		t.Fatalf("缺少 created 时必须取当前秒: %s", payload["created"])
	}
}

// 逐字段宽容：坏行、非 JSON 行、类型不符的字段都不得让整条流作废。
func TestAggregateSSEToleratesMalformedInput(t *testing.T) {
	sse := strings.Join([]string{
		`event: message`,
		`data: not-json`,
		`data: {"id":123,"model":null,"choices":"nope"}`,
		`data: {"choices":[{"delta":{"content":42,"tool_calls":"nope"}}]}`,
		`data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}`,
		`data:`,
		``,
	}, "\n")
	result := AggregateSSE([]byte(sse), fixedClock)
	message := messageOf(t, sse)
	if content, _ := rawString(message["content"]); content != "ok" {
		t.Fatalf("合法内容应被保留: %s", message["content"])
	}
	if result.SawDone {
		t.Fatal("没有 [DONE] 时 SawDone 必须为 false")
	}
	if !result.SawChunk {
		t.Fatal("解析出对象时 SawChunk 必须为 true")
	}
}

// 只给 [DONE]（或压根没有 data 行）时不得伪造出 content —— 调用方据此判断上游空响应。
func TestAggregateSSEWithoutChunksKeepsEmptyContent(t *testing.T) {
	for _, sse := range []string{"data: [DONE]\n", "", "event: ping\n"} {
		message := messageOf(t, sse)
		if content, _ := rawString(message["content"]); content != "" {
			t.Fatalf("空流不得伪造 content: %q", content)
		}
	}
}
