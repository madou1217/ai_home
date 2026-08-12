package openairesponses

import (
	"errors"
	"strings"
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

// TestRequestDecoderPreservesNamespaceWebSearchAndMetadata 验证 Codex 0.146.0
// 的 namespace、网络搜索和请求亲和元数据不会在入站层被扁平化或删除。
func TestRequestDecoderPreservesNamespaceWebSearchAndMetadata(t *testing.T) {
	t.Parallel()

	request, err := NewRequestDecoder().Decode([]byte(`{
		"model":"gpt-5.6-sol",
		"input":"检查邮件",
		"tools":[
			{"type":"namespace","name":"gmail","description":"邮箱工具","tools":[
				{"type":"function","name":"search","description":"搜索邮件","parameters":{"type":"object"},"strict":true}
			]},
			{"type":"namespace","name":"calendar","description":"日历工具","tools":[
				{"type":"function","name":"search","description":"搜索日程","parameters":{"type":"object"},"strict":false}
			]},
			{"type":"web_search","external_web_access":true,"filters":{"allowed_domains":["example.com"]},"user_location":{"type":"approximate","country":"CN","city":"上海","timezone":"Asia/Shanghai"}}
		],
		"tool_choice":{"type":"function","namespace":"gmail","name":"search"},
		"prompt_cache_key":"cache_turn_1",
		"client_metadata":{"turn_id":"turn_1","session_id":"session_1"}
	}`))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	tools := request.Tools()
	if len(tools) != 2 || tools[0].Identity() == tools[1].Identity() {
		t.Fatalf("Request.Tools() = %#v, want distinct namespaced identities", tools)
	}
	for index, namespace := range []string{"gmail", "calendar"} {
		actual, found := tools[index].Namespace()
		if !found || actual != namespace || tools[index].Name() != "search" {
			t.Fatalf("tools[%d] = (%q, %q, %t)", index, actual, tools[index].Name(), found)
		}
	}
	choice, found := request.ToolChoice()
	namespace, namespaced := choice.Namespace()
	if !found || !namespaced || namespace != "gmail" || choice.Name() != "search" {
		t.Fatalf("ToolChoice = (%#v, %t), want gmail.search", choice, found)
	}
	webSearch, found := request.WebSearch()
	if !found || len(webSearch.AllowedDomains()) != 1 {
		t.Fatalf("WebSearch = (%#v, %t)", webSearch, found)
	}
	if promptCacheKey, found := request.PromptCacheKey(); !found || promptCacheKey != "cache_turn_1" {
		t.Fatalf("PromptCacheKey = (%q, %t)", promptCacheKey, found)
	}
	metadata := request.ClientMetadata()
	if metadata["turn_id"] != "turn_1" || metadata["session_id"] != "session_1" {
		t.Fatalf("ClientMetadata = %#v", metadata)
	}
}

// TestRequestDecoderRejectsInvalidResponseMetadata 验证公开 metadata 必须符合
// OpenAI Responses 的有界字符串映射合同，不能因为它不进入 Canonical 就跳过校验。
func TestRequestDecoderRejectsInvalidResponseMetadata(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		metadata string
	}{
		{name: "数组", metadata: `[]`},
		{name: "非字符串值", metadata: `{"ticket":42}`},
		{name: "键过长", metadata: `{"` + strings.Repeat("k", 65) + `":"value"}`},
		{name: "值过长", metadata: `{"ticket":"` + strings.Repeat("v", 513) + `"}`},
		{name: "超过十六个条目", metadata: metadataObject(17)},
		{name: "重复键", metadata: `{"ticket":"first","ticket":"second"}`},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			_, err := NewRequestDecoder().Decode([]byte(
				`{"model":"gpt-5.6-sol","input":"hello","metadata":` +
					testCase.metadata + `}`,
			))
			if !errors.Is(err, ErrInvalidResponsesRequest) {
				t.Fatalf("非法 metadata 错误不稳定: %v", err)
			}
		})
	}
}

// TestRequestDecoderAcceptsNullableResponseMetadata 验证空对象和显式 null 都是
// OpenAI Responses 允许的 metadata 表达。
func TestRequestDecoderAcceptsNullableResponseMetadata(t *testing.T) {
	t.Parallel()

	for _, metadata := range []string{`{}`, `null`} {
		_, err := NewRequestDecoder().Decode([]byte(
			`{"model":"gpt-5.6-sol","input":"hello","metadata":` + metadata + `}`,
		))
		if err != nil {
			t.Fatalf("合法 metadata=%s 被拒绝: %v", metadata, err)
		}
	}
}

// metadataObject 创建指定条目数的合法字符串映射。
func metadataObject(entries int) string {
	pairs := make([]string, 0, entries)
	for index := 0; index < entries; index++ {
		pairs = append(pairs, `"key`+string(rune('a'+index))+`":"value"`)
	}
	return `{` + strings.Join(pairs, ",") + `}`
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

// TestRequestDecoderAcceptsCodexClientToolSearch 验证官方 Codex CLI 自动附带的
// 客户端 tool_search 元工具停留在客户端边界，不会被伪造为上游 function tool。
func TestRequestDecoderAcceptsCodexClientToolSearch(t *testing.T) {
	t.Parallel()

	request, err := NewRequestDecoder().Decode([]byte(`{
		"model":"claude-sonnet-5",
		"input":"只返回文本",
		"tools":[
			{"type":"tool_search","execution":"client","description":"发现可用工具","parameters":{"type":"object","properties":{"query":{"type":"string"}}}},
			{"type":"function","name":"lookup","description":"查询","parameters":{"type":"object"}},
			{"type":"web_search","external_web_access":true}
		],
		"tool_choice":"auto",
		"parallel_tool_calls":true,
		"stream":true
	}`))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	tools := request.Tools()
	if len(tools) != 1 || tools[0].Name() != "lookup" {
		t.Fatalf("Request.Tools() = %#v, want only portable lookup", tools)
	}
	if _, found := request.WebSearch(); !found {
		t.Fatal("Request.WebSearch() 未保留服务器侧搜索工具")
	}
}

// TestRequestDecoderRejectsNonClientToolSearch 验证同名 Provider 私有工具不会被
// 误吞，只有官方 execution=client 形态可以越过客户端协议边界。
func TestRequestDecoderRejectsNonClientToolSearch(t *testing.T) {
	t.Parallel()

	_, err := NewRequestDecoder().Decode([]byte(`{
		"model":"gpt-5.6-sol",
		"input":"x",
		"tools":[{"type":"tool_search","execution":"server","description":"发现工具","parameters":{"type":"object"}}]
	}`))
	if !errors.Is(err, ErrInvalidResponsesRequest) {
		t.Fatalf("Decode() error = %v, want invalid request", err)
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
