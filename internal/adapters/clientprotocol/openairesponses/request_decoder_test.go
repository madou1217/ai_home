package openairesponses

import (
	"errors"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// TestRequestDecoderPreservesSupportedResponsesSemantics 验证 Responses 文本、图片、
// 文档、工具、reasoning、结构化输出和流式意图完整进入 Canonical Request。
func TestRequestDecoderPreservesSupportedResponsesSemantics(t *testing.T) {
	t.Parallel()

	body := []byte(`{
		"model":"gpt-5.6-sol",
		"instructions":"严格按照工具结果回答。",
		"input":[
			{
				"type":"message",
				"role":"user",
				"content":[
					{"type":"input_text","text":"检查账号状态"},
					{"type":"input_image","file_id":"file_image_1","detail":"original"},
					{"type":"input_file","file_url":"https://example.test/status.pdf","filename":"status.pdf","detail":"high"}
				]
			},
			{"type":"function_call","call_id":"call_exact_1","name":"lookup","arguments":"{\"account\":\"A\"}"},
			{"type":"function_call_output","call_id":"call_exact_1","output":[{"type":"input_text","text":"账号可用"}]},
			{"type":"message","role":"assistant","phase":"commentary","content":[{"type":"output_text","text":"已检查工具结果"}]}
		],
		"tools":[
			{
				"type":"function",
				"name":"lookup",
				"description":"查询账号",
				"parameters":{"type":"object","properties":{"account":{"type":"string"}}},
				"strict":false
			}
		],
		"tool_choice":{"type":"function","name":"lookup"},
		"parallel_tool_calls":false,
		"reasoning":{"effort":"xhigh","summary":"concise"},
		"text":{
			"format":{
				"type":"json_schema",
				"name":"account_status",
				"description":"账号状态",
				"schema":{"type":"object"},
				"strict":true
			}
		},
		"stream":true,
		"max_output_tokens":2048,
		"temperature":0.4,
		"top_p":0.9,
		"store":false,
		"include":["reasoning.encrypted_content"],
		"truncation":"disabled"
	}`)

	request, err := NewRequestDecoder().Decode(body)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	if request.ClientProtocol() != inference.ClientProtocolOpenAIResponses ||
		request.Model() != "gpt-5.6-sol" ||
		!request.Stream() ||
		request.MaxOutputTokens() != 2048 {
		t.Fatalf("request basics = (%q, %q, %t, %d)", request.ClientProtocol(), request.Model(), request.Stream(), request.MaxOutputTokens())
	}
	if store, specified := request.Store(); !specified || store {
		t.Fatalf("Request.Store() = (%t, %t), want (false, true)", store, specified)
	}
	if !request.IncludeEncryptedReasoning() {
		t.Fatal("Request.IncludeEncryptedReasoning() 应保留 include 意图")
	}
	if truncation, found := request.Truncation(); !found || truncation != inference.TruncationDisabled {
		t.Fatalf("Request.Truncation() = (%q, %t), want disabled", truncation, found)
	}

	messages := request.Messages()
	if len(messages) != 5 {
		t.Fatalf("len(Request.Messages()) = %d, want 5", len(messages))
	}
	if messages[0].Role() != inference.RoleDeveloper {
		t.Fatalf("instructions role = %q, want developer", messages[0].Role())
	}
	userContents := messages[1].Contents()
	if len(userContents) != 3 ||
		userContents[1].(inference.ImageContent).Detail() != inference.ImageDetailOriginal ||
		userContents[2].(inference.DocumentContent).Detail() != inference.DocumentDetailHigh {
		t.Fatalf("user contents = %#v, want text/image/document", userContents)
	}
	if messages[4].Phase() != inference.MessagePhaseCommentary {
		t.Fatalf("assistant phase = %q, want commentary", messages[4].Phase())
	}

	tools := request.Tools()
	if len(tools) != 1 || tools[0].Name() != "lookup" {
		t.Fatalf("Request.Tools() = %#v, want lookup", tools)
	}
	if strict, specified := tools[0].Strict(); !specified || strict {
		t.Fatalf("Tool.Strict() = (%t, %t), want explicit false", strict, specified)
	}
	choice, found := request.ToolChoice()
	if !found || choice.Mode() != inference.ToolChoiceNamed || choice.Name() != "lookup" {
		t.Fatalf("Request.ToolChoice() = (%#v, %t), want named lookup", choice, found)
	}
	reasoning, found := request.Reasoning()
	if !found || reasoning.Effort() != inference.ReasoningEffortXHigh || reasoning.Summary() != inference.ReasoningSummaryConcise {
		t.Fatalf("Request.Reasoning() = (%#v, %t), want xhigh/concise", reasoning, found)
	}
	output, found := request.StructuredOutput()
	if !found || output.Name() != "account_status" || !output.Strict() {
		t.Fatalf("Request.StructuredOutput() = (%#v, %t), want strict schema", output, found)
	}
}

// TestRequestDecoderSupportsPreviousResponseToolOutput 验证 previous_response_id
// 允许精确引用历史 call ID，但不会生成或猜测调用标识。
func TestRequestDecoderSupportsPreviousResponseToolOutput(t *testing.T) {
	t.Parallel()

	body := []byte(`{
		"model":"gpt-5.6-sol",
		"previous_response_id":"resp_exact_1",
		"input":[
			{"type":"function_call_output","call_id":"call_external_1","output":"工具执行成功"}
		]
	}`)
	request, err := NewRequestDecoder().Decode(body)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	continuation, found := request.Continuation()
	if !found ||
		continuation.Kind() != inference.ContinuationPreviousResponse ||
		continuation.ID() != "resp_exact_1" {
		t.Fatalf("Request.Continuation() = (%#v, %t), want previous response", continuation, found)
	}
	result := request.Messages()[0].Contents()[0].(inference.ToolResultContent)
	if result.CallID() != "call_external_1" {
		t.Fatalf("ToolResultContent.CallID() = %q, want exact ID", result.CallID())
	}
}

// TestRequestDecoderSupportsStringAndDataURLInput 验证 Responses 简写文本和 data URL
// 图片都转换为类型化内容，不保留裸 data URL。
func TestRequestDecoderSupportsStringAndDataURLInput(t *testing.T) {
	t.Parallel()

	textRequest, err := NewRequestDecoder().Decode([]byte(`{"model":"gpt-5.6-sol","input":"你好"}`))
	if err != nil {
		t.Fatalf("Decode() string input error = %v", err)
	}
	text := textRequest.Messages()[0].Contents()[0].(inference.TextContent)
	if text.Text() != "你好" {
		t.Fatalf("TextContent.Text() = %q, want 你好", text.Text())
	}

	imageRequest, err := NewRequestDecoder().Decode([]byte(`{
		"model":"gpt-5.6-sol",
		"input":[
			{"role":"user","content":[
				{"type":"input_image","image_url":"data:image/png;base64,aW1hZ2U=","detail":"auto"}
			]}
		]
	}`))
	if err != nil {
		t.Fatalf("Decode() data URL error = %v", err)
	}
	image := imageRequest.Messages()[0].Contents()[0].(inference.ImageContent)
	if image.Source().Kind() != inference.MediaSourceBase64 ||
		image.Source().MediaType() != "image/png" ||
		image.Source().Value() != "aW1hZ2U=" {
		t.Fatalf("ImageContent.Source() = %#v, want parsed base64 source", image.Source())
	}
}

// TestRequestDecoderRejectsUnsupportedSemanticsExplicitly 验证尚未建立共同抽象的字段
// 会明确失败，不会被静默删除。
func TestRequestDecoderRejectsUnsupportedSemanticsExplicitly(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		body string
	}{
		{
			name: "built-in tool",
			body: `{"model":"gpt-5.6-sol","input":"x","tools":[{"type":"web_search"}]}`,
		},
		{
			name: "prompt cache options",
			body: `{"model":"gpt-5.6-sol","input":"x","prompt_cache_options":{"mode":"explicit","ttl":"30m"}}`,
		},
		{
			name: "context management",
			body: `{"model":"gpt-5.6-sol","input":"x","context_management":[{"type":"compaction"}]}`,
		},
		{
			name: "json object mode",
			body: `{"model":"gpt-5.6-sol","input":"x","text":{"format":{"type":"json_object"}}}`,
		},
	}
	for _, testCase := range cases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			_, err := NewRequestDecoder().Decode([]byte(testCase.body))
			if !errors.Is(err, ErrUnsupportedFeature) {
				t.Fatalf("Decode() error = %v, want ErrUnsupportedFeature", err)
			}
		})
	}
}

// TestRequestDecoderRejectsMalformedOrAmbiguousInput 验证未知字段、未知内容块、
// 双重媒体来源和损坏工具参数都失败关闭。
func TestRequestDecoderRejectsMalformedOrAmbiguousInput(t *testing.T) {
	t.Parallel()

	cases := []string{
		`{"model":"gpt-5.6-sol","input":"x","unknown_field":true}`,
		`{"model":"gpt-5.6-sol","input":[{"role":"user","content":[{"type":"unknown","text":"x"}]}]}`,
		`{"model":"gpt-5.6-sol","input":[{"role":"user","content":[{"type":"input_image","file_id":"file_1","image_url":"https://example.test/x.png"}]}]}`,
		`{"model":"gpt-5.6-sol","input":[{"type":"function_call","call_id":"call_1","name":"lookup","arguments":"{"}]}`,
		`{"model":"gpt-5.6-sol","input":[{"type":"function_call_output","output":"x"}]}`,
		`{"model":"gpt-5.6-sol","input":"x"} trailing`,
	}
	for _, body := range cases {
		if _, err := NewRequestDecoder().Decode([]byte(body)); !errors.Is(err, ErrInvalidResponsesRequest) {
			t.Fatalf("Decode(%s) error = %v, want ErrInvalidResponsesRequest", body, err)
		}
	}
}
