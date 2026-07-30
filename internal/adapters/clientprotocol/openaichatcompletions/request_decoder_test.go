package openaichatcompletions

import (
	"errors"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// TestRequestDecoderMapsChatContractToCanonical 验证 Chat 主干输入语义不会在
// Decoder 边界被静默删除或绑定到具体上游 Provider。
func TestRequestDecoderMapsChatContractToCanonical(t *testing.T) {
	t.Parallel()

	body := []byte(`{
		"model":"gpt-5.6-sol",
		"messages":[
			{"role":"system","content":"系统约束"},
			{"role":"developer","content":[{"type":"text","text":"开发者约束"}]},
			{"role":"user","content":[
				{"type":"text","text":"查看图片"},
				{"type":"image_url","image_url":{"url":"https://example.test/image.png","detail":"high"}}
			]},
			{"role":"assistant","reasoning_content":"先调用工具","content":"处理中","tool_calls":[{
				"id":"call_weather",
				"type":"function",
				"function":{"name":"weather","arguments":"{\"city\":\"深圳\"}"}
			}]},
			{"role":"tool","tool_call_id":"call_weather","content":"晴天"},
			{"role":"user","content":"给出最终答案"}
		],
		"tools":[{
			"type":"function",
			"function":{
				"name":"weather",
				"description":"查询天气",
				"parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]},
				"strict":true
			}
		}],
		"tool_choice":{"type":"function","function":{"name":"weather"}},
		"parallel_tool_calls":true,
		"reasoning_effort":"high",
		"response_format":{
			"type":"json_schema",
			"json_schema":{
				"name":"weather_result",
				"description":"天气结果",
				"schema":{"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false},
				"strict":true
			}
		},
		"stream":true,
		"stream_options":{"include_usage":true},
		"max_completion_tokens":2048,
		"temperature":0.2,
		"top_p":0.9,
		"stop":"END",
		"store":false,
		"user":"user-42"
	}`)

	request, err := NewRequestDecoder().Decode(body)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	if request.ClientProtocol() != inference.ClientProtocolOpenAIChatCompletions ||
		request.Model() != "gpt-5.6-sol" ||
		!request.Stream() ||
		!request.IncludeUsageInStream() ||
		request.MaxOutputTokens() != 2048 {
		t.Fatalf("request 基础字段错误: %#v", request)
	}
	if temperature, ok := request.Temperature(); !ok || temperature != 0.2 {
		t.Fatalf("Temperature() = %v, %v", temperature, ok)
	}
	if topP, ok := request.TopP(); !ok || topP != 0.9 {
		t.Fatalf("TopP() = %v, %v", topP, ok)
	}
	if stop := request.StopSequences(); len(stop) != 1 || stop[0] != "END" {
		t.Fatalf("StopSequences() = %#v", stop)
	}
	if userID, ok := request.UserID(); !ok || userID != "user-42" {
		t.Fatalf("UserID() = %q, %v", userID, ok)
	}
	if store, ok := request.Store(); !ok || store {
		t.Fatalf("Store() = %v, %v", store, ok)
	}
	if reasoning, ok := request.Reasoning(); !ok ||
		reasoning.Mode() != inference.ReasoningModeEffort ||
		reasoning.Effort() != inference.ReasoningEffortHigh {
		t.Fatalf("Reasoning() = %#v, %v", reasoning, ok)
	}
	if structured, ok := request.StructuredOutput(); !ok ||
		structured.Name() != "weather_result" ||
		!structured.Strict() {
		t.Fatalf("StructuredOutput() = %#v, %v", structured, ok)
	}
	if choice, ok := request.ToolChoice(); !ok ||
		choice.Mode() != inference.ToolChoiceNamed ||
		choice.Name() != "weather" {
		t.Fatalf("ToolChoice() = %#v, %v", choice, ok)
	}
	if parallel, ok := request.ParallelToolCalls(); !ok || !parallel {
		t.Fatalf("ParallelToolCalls() = %v, %v", parallel, ok)
	}
	tools := request.Tools()
	if len(tools) != 1 || tools[0].Name() != "weather" {
		t.Fatalf("Tools() = %#v", tools)
	}
	if strict, specified := tools[0].Strict(); !specified || !strict {
		t.Fatalf("tool.Strict() = %v, %v", strict, specified)
	}

	messages := request.Messages()
	if len(messages) != 6 ||
		messages[0].Role() != inference.RoleSystem ||
		messages[1].Role() != inference.RoleDeveloper ||
		messages[2].Role() != inference.RoleUser ||
		messages[3].Role() != inference.RoleAssistant ||
		messages[4].Role() != inference.RoleUser {
		t.Fatalf("Messages() 角色错误: %#v", messages)
	}
	userContents := messages[2].Contents()
	if len(userContents) != 2 ||
		userContents[0].Kind() != inference.ContentText ||
		userContents[1].Kind() != inference.ContentImage {
		t.Fatalf("用户多模态内容错误: %#v", userContents)
	}
	assistantContents := messages[3].Contents()
	if len(assistantContents) != 3 ||
		assistantContents[0].Kind() != inference.ContentReasoning ||
		assistantContents[1].Kind() != inference.ContentText ||
		assistantContents[2].Kind() != inference.ContentToolCall {
		t.Fatalf("Assistant 内容错误: %#v", assistantContents)
	}
	toolResult, ok := messages[4].Contents()[0].(inference.ToolResultContent)
	if !ok || toolResult.CallID() != "call_weather" || toolResult.IsError() {
		t.Fatalf("工具结果错误: %#v", messages[4].Contents())
	}
}

// TestRequestDecoderSupportsStringArrayStopAndDefaultTextFormat 验证 Chat 常用
// 简写不会被迫转换成 Provider 私有结构。
func TestRequestDecoderSupportsStringArrayStopAndDefaultTextFormat(t *testing.T) {
	t.Parallel()

	request, err := NewRequestDecoder().Decode([]byte(`{
		"model":"gpt-5.6-sol",
		"messages":[{"role":"user","content":"hello"}],
		"stop":["A","B"],
		"response_format":{"type":"text"},
		"n":1
	}`))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	if stop := request.StopSequences(); len(stop) != 2 ||
		stop[0] != "A" ||
		stop[1] != "B" {
		t.Fatalf("StopSequences() = %#v", stop)
	}
	if _, ok := request.StructuredOutput(); ok {
		t.Fatal("text response_format 不应创建 StructuredOutput")
	}
}

// TestRequestDecoderSupportsLegacyTokenLimitAndDataURLImage 验证仍在广泛使用的
// max_tokens 与内联图片都进入 Canonical 值对象，而不是保留裸线协议字段。
func TestRequestDecoderSupportsLegacyTokenLimitAndDataURLImage(t *testing.T) {
	t.Parallel()

	request, err := NewRequestDecoder().Decode([]byte(`{
		"model":"gpt-5.6-sol",
		"messages":[{
			"role":"user",
			"content":[{
				"type":"image_url",
				"image_url":{
					"url":"data:image/png;base64,aW1hZ2U=",
					"detail":"low"
				}
			}]
		}],
		"max_tokens":512
	}`))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	if request.MaxOutputTokens() != 512 {
		t.Fatalf("MaxOutputTokens() = %d", request.MaxOutputTokens())
	}
	image, ok := request.Messages()[0].Contents()[0].(inference.ImageContent)
	if !ok ||
		image.Source().Kind() != inference.MediaSourceBase64 ||
		image.Source().MediaType() != "image/png" ||
		image.Detail() != inference.ImageDetailLow {
		t.Fatalf("图片内容错误: %#v", request.Messages()[0].Contents())
	}
}

// TestRequestDecoderRejectsUnsupportedSemanticsExplicitly 验证不能无损表达的
// Chat 字段会失败关闭，而不是伪装成已支持。
func TestRequestDecoderRejectsUnsupportedSemanticsExplicitly(t *testing.T) {
	t.Parallel()

	cases := []string{
		`{"model":"gpt","messages":[{"role":"user","content":"x"}],"n":2}`,
		`{"model":"gpt","messages":[{"role":"user","content":"x"}],"logprobs":true}`,
		`{"model":"gpt","messages":[{"role":"user","content":"x"}],"top_logprobs":3}`,
		`{"model":"gpt","messages":[{"role":"user","content":"x"}],"response_format":{"type":"json_object"}}`,
		`{"model":"gpt","messages":[{"role":"user","content":"x","name":"alice"}]}`,
		`{"model":"gpt","messages":[{"role":"assistant","function_call":{"name":"old","arguments":"{}"}}]}`,
		`{"model":"gpt","messages":[{"role":"user","content":"x"}],"audio":{"voice":"alloy"}}`,
	}
	for _, body := range cases {
		body := body
		t.Run(body, func(t *testing.T) {
			t.Parallel()
			_, err := NewRequestDecoder().Decode([]byte(body))
			if !errors.Is(err, ErrUnsupportedFeature) {
				t.Fatalf("Decode() error = %v, want ErrUnsupportedFeature", err)
			}
		})
	}
}

// TestRequestDecoderRejectsMalformedOrAmbiguousInput 验证未知字段、冲突 token
// 上限、损坏工具参数和错误图片来源不能进入 Canonical 层。
func TestRequestDecoderRejectsMalformedOrAmbiguousInput(t *testing.T) {
	t.Parallel()

	cases := []string{
		`{"model":"gpt","messages":[{"role":"user","content":"x"}],"unknown":true}`,
		`{"model":"gpt","messages":[]}`,
		`{"model":"gpt","messages":[{"role":"user","content":"x"}],"max_tokens":1,"max_completion_tokens":1}`,
		`{"model":"gpt","messages":[{"role":"assistant","tool_calls":[{"id":"call","type":"function","function":{"name":"x","arguments":"{"}}]}]}`,
		`{"model":"gpt","messages":[{"role":"tool","content":"x"}]}`,
		`{"model":"gpt","messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"file:///tmp/x.png"}}]}]}`,
		`{"model":"gpt","messages":[{"role":"user","content":"x"}],"stream_options":{"include_usage":true}}`,
	}
	for _, body := range cases {
		body := body
		t.Run(body, func(t *testing.T) {
			t.Parallel()
			_, err := NewRequestDecoder().Decode([]byte(body))
			if !errors.Is(err, ErrInvalidChatCompletionsRequest) {
				t.Fatalf("Decode() error = %v, want ErrInvalidChatCompletionsRequest", err)
			}
		})
	}
}
