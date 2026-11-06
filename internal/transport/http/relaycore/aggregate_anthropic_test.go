package relaycore

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

// fixedClock 返回真实事故那一秒，便于断言兜底 id 与 created。
func fixedClock() time.Time {
	return time.UnixMilli(1793942042391)
}

// decodeAggregated 把聚合结果解成通用 map，按客户端视角断言字段。
func decodeAggregated(t *testing.T, payload []byte) map[string]any {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("聚合结果不是合法 JSON: %v", err)
	}
	return decoded
}

// numberAt 读取嵌套数值；路径不存在直接失败。
func numberAt(t *testing.T, value map[string]any, path ...string) float64 {
	t.Helper()
	var current any = value
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			t.Fatalf("路径 %v 中途不是对象", path)
		}
		next, exists := object[key]
		if !exists {
			t.Fatalf("路径 %v 缺少字段 %q", path, key)
		}
		current = next
	}
	number, ok := current.(float64)
	if !ok {
		t.Fatalf("路径 %v 不是数值: %T", path, current)
	}
	return number
}

// 事故复现：zcode 对非流式请求直接给整段 Anthropic Message，
// 旧实现把它当 OpenAI SSE 解析，于是 model="unknown"、无 usage、content 为空。
func TestAggregateAnthropicMessageKeepsModelAndUsage(t *testing.T) {
	body := []byte("{\"id\":\"msg_01\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"glm-5.3-flash\"," +
		"\"content\":[{\"type\":\"text\",\"text\":\"你好世界\"}],\"stop_reason\":\"end_turn\"," +
		"\"usage\":{\"input_tokens\":1000,\"output_tokens\":4,\"cache_read_input_tokens\":80,\"cache_creation_input_tokens\":3}}")
	aggregated, ok := aggregateAnthropicMessage(body, AggregateOptions{Clock: fixedClock})
	if !ok {
		t.Fatal("完整 Anthropic Message 未被识别")
	}
	decoded := decodeAggregated(t, aggregated.Payload)
	if got := decoded["model"]; got != "glm-5.3-flash" {
		t.Fatalf("model = %v, want glm-5.3-flash", got)
	}
	if got := decoded["id"]; got != "msg_01" {
		t.Fatalf("id = %v, want 上游 id", got)
	}
	choice := decoded["choices"].([]any)[0].(map[string]any)
	if got := choice["message"].(map[string]any)["content"]; got != "你好世界" {
		t.Fatalf("content = %v", got)
	}
	if got := choice["finish_reason"]; got != "stop" {
		t.Fatalf("finish_reason = %v, want stop", got)
	}
	// Anthropic 的 input_tokens 不含缓存读写：prompt 必须把缓存并进来。
	if got := numberAt(t, decoded, "usage", "prompt_tokens"); got != 1083 {
		t.Fatalf("prompt_tokens = %v, want 1083", got)
	}
	if got := numberAt(t, decoded, "usage", "completion_tokens"); got != 4 {
		t.Fatalf("completion_tokens = %v, want 4", got)
	}
	if got := numberAt(t, decoded, "usage", "total_tokens"); got != 1087 {
		t.Fatalf("total_tokens = %v, want 1087", got)
	}
	if got := numberAt(t, decoded, "usage", "prompt_tokens_details", "cached_tokens"); got != 80 {
		t.Fatalf("cached_tokens = %v, want 80", got)
	}
}

// 上游若无视 stream:false 仍返回事件流，也必须按同一份映射产出 model 与 usage。
func TestAggregateSSEHandlesAnthropicStream(t *testing.T) {
	sse := []byte(strings.Join([]string{
		"data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_02\",\"type\":\"message\",\"model\":\"glm-5.3-flash\",\"content\":[],\"usage\":{\"input_tokens\":1000,\"output_tokens\":1,\"cache_read_input_tokens\":80}}}",
		"data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}",
		"data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"你好\"}}",
		"data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"世界\"}}",
		"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"},\"usage\":{\"output_tokens\":4}}",
		"data: {\"type\":\"message_stop\"}",
		"",
	}, "\n"))
	aggregated := AggregateSSE(sse, AggregateOptions{Clock: fixedClock})
	decoded := decodeAggregated(t, aggregated.Payload)
	if got := decoded["model"]; got != "glm-5.3-flash" {
		t.Fatalf("model = %v, want glm-5.3-flash", got)
	}
	choice := decoded["choices"].([]any)[0].(map[string]any)
	if got := choice["message"].(map[string]any)["content"]; got != "你好世界" {
		t.Fatalf("content = %v, want 你好世界", got)
	}
	if got := choice["finish_reason"]; got != "length" {
		t.Fatalf("finish_reason = %v, want length", got)
	}
	if got := numberAt(t, decoded, "usage", "prompt_tokens"); got != 1080 {
		t.Fatalf("prompt_tokens = %v, want 1080", got)
	}
	if got := numberAt(t, decoded, "usage", "completion_tokens"); got != 4 {
		t.Fatalf("completion_tokens = %v, want 4", got)
	}
}

// 工具调用的分片参数要拼成完整 JSON，finish_reason 也要跟着变。
func TestAggregateAnthropicStreamAssemblesToolCalls(t *testing.T) {
	sse := []byte(strings.Join([]string{
		"data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_03\",\"type\":\"message\",\"model\":\"glm-5.3-flash\",\"content\":[]}}",
		"data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_1\",\"name\":\"read_file\",\"input\":{}}}",
		"data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"path\\\":\"}}",
		"data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"a.txt\\\"}\"}}",
		"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"output_tokens\":9}}",
		"",
	}, "\n"))
	aggregated := AggregateSSE(sse, AggregateOptions{Clock: fixedClock})
	decoded := decodeAggregated(t, aggregated.Payload)
	choice := decoded["choices"].([]any)[0].(map[string]any)
	if got := choice["finish_reason"]; got != "tool_calls" {
		t.Fatalf("finish_reason = %v, want tool_calls", got)
	}
	calls := choice["message"].(map[string]any)["tool_calls"].([]any)
	call := calls[0].(map[string]any)
	if got := call["id"]; got != "toolu_1" {
		t.Fatalf("tool id = %v", got)
	}
	function := call["function"].(map[string]any)
	if got := function["name"]; got != "read_file" {
		t.Fatalf("tool name = %v", got)
	}
	if got := function["arguments"]; got != "{\"path\":\"a.txt\"}" {
		t.Fatalf("arguments = %v", got)
	}
}

// OpenAI SSE 的既有行为不能因为新增协议判定而改变。
func TestAggregateSSEKeepsOpenAIChunks(t *testing.T) {
	sse := []byte(strings.Join([]string{
		"data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-5\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"},\"finish_reason\":null}]}",
		"data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"model\":\"gpt-5\",\"choices\":[],\"usage\":{\"prompt_tokens\":7,\"completion_tokens\":2,\"total_tokens\":9}}",
		"data: [DONE]",
		"",
	}, "\n"))
	aggregated := AggregateSSE(sse, AggregateOptions{Clock: fixedClock})
	decoded := decodeAggregated(t, aggregated.Payload)
	if got := decoded["model"]; got != "gpt-5" {
		t.Fatalf("model = %v, want gpt-5", got)
	}
	if got := numberAt(t, decoded, "usage", "prompt_tokens"); got != 7 {
		t.Fatalf("prompt_tokens = %v, want 7", got)
	}
	if !aggregated.SawDone {
		t.Fatal("SawDone should be true")
	}
}

// 完整 JSON 不能交给聚合器：同协议 chat.completion 要原样交付。
func TestIsSSEPayloadDistinguishesJSONFromStream(t *testing.T) {
	cases := []struct {
		name    string
		header  http.Header
		payload string
		want    bool
	}{
		{"json content type", http.Header{"Content-Type": []string{"application/json; charset=utf-8"}}, "{\"object\":\"chat.completion\"}", false},
		{"event stream content type", http.Header{"Content-Type": []string{"text/event-stream"}}, "data: {}\n\n", true},
		{"missing content type but data prefix", http.Header{}, "data: {}\n\n", true},
		{"missing content type plain json", http.Header{}, "{\"type\":\"message\"}", false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := isSSEPayload(testCase.header, []byte(testCase.payload)); got != testCase.want {
				t.Fatalf("isSSEPayload() = %v, want %v", got, testCase.want)
			}
		})
	}
}

// 事故的回归守卫：非流式客户端 + 上游整段 Anthropic JSON。
//
// 旧口径把纯 JSON 当 SSE 解析，这里只能产出一个空 payload（线上表现为
// model="unknown"、无 usage、content 为空的 chat.completion）。
func TestNonStreamPayloadConvertsAnthropicJSON(t *testing.T) {
	header := http.Header{"Content-Type": []string{"application/json; charset=utf-8"}}
	body := []byte("{\"id\":\"msg_04\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"glm-5.3-flash\"," +
		"\"content\":[{\"type\":\"text\",\"text\":\"好的\"}],\"stop_reason\":\"end_turn\"," +
		"\"usage\":{\"input_tokens\":1083,\"output_tokens\":4}}")
	payload := nonStreamPayload(header, body, AggregateOptions{Clock: fixedClock})
	if len(payload) == 0 {
		t.Fatal("非流式 Anthropic 正文不能产出空 payload")
	}
	decoded := decodeAggregated(t, payload)
	if got := decoded["model"]; got != "glm-5.3-flash" {
		t.Fatalf("model = %v, want glm-5.3-flash", got)
	}
	if got := numberAt(t, decoded, "usage", "prompt_tokens"); got != 1083 {
		t.Fatalf("prompt_tokens = %v, want 1083", got)
	}
	if got := numberAt(t, decoded, "usage", "total_tokens"); got != 1087 {
		t.Fatalf("total_tokens = %v, want 1087", got)
	}
}

// 同协议的完整 JSON 必须逐字节交付：重建会丢掉上游多给的字段。
func TestNonStreamPayloadPassesThroughChatCompletion(t *testing.T) {
	header := http.Header{"Content-Type": []string{"application/json; charset=utf-8"}}
	body := []byte("{\"id\":\"chatcmpl-9\",\"object\":\"chat.completion\",\"model\":\"gpt-5\",\"choices\":[],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2},\"x_vendor\":\"keep-me\"}")
	payload := nonStreamPayload(header, body, AggregateOptions{Clock: fixedClock})
	if string(payload) != string(body) {
		t.Fatalf("同协议 JSON 被改写:\n got: %s\nwant: %s", payload, body)
	}
}

// 上游没声明 model 时必须回落客户端请求的模型，而不是留空或写死占位值。
func TestAggregateAnthropicMessageFallsBackToRequestedModel(t *testing.T) {
	body := []byte("{\"id\":\"msg_05\",\"type\":\"message\",\"role\":\"assistant\"," +
		"\"content\":[{\"type\":\"text\",\"text\":\"好的\"}],\"stop_reason\":\"end_turn\"," +
		"\"usage\":{\"input_tokens\":10,\"output_tokens\":2}}")
	options := AggregateOptions{Clock: fixedClock, RequestedModel: "glm-5.3-flash"}
	aggregated, ok := aggregateAnthropicMessage(body, options)
	if !ok {
		t.Fatal("完整 Anthropic Message 未被识别")
	}
	decoded := decodeAggregated(t, aggregated.Payload)
	if got := decoded["model"]; got != "glm-5.3-flash" {
		t.Fatalf("model = %v, want 请求模型", got)
	}
}

// OpenAI 形态的 SSE 同样按请求模型兜底（旧实现在这里写死 "unknown"）。
func TestAggregateSSEFallsBackToRequestedModel(t *testing.T) {
	sse := []byte(strings.Join([]string{
		"data: {\"id\":\"chatcmpl-2\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"hi\"},\"finish_reason\":\"stop\"}]}",
		"",
	}, "\n"))
	aggregated := AggregateSSE(sse, AggregateOptions{Clock: fixedClock, RequestedModel: "gpt-5"})
	decoded := decodeAggregated(t, aggregated.Payload)
	if got := decoded["model"]; got != "gpt-5" {
		t.Fatalf("model = %v, want 请求模型", got)
	}
}
