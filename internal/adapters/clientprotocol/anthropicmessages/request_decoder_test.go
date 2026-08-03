package anthropicmessages

import (
	"errors"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// TestRequestDecoderPreservesCompleteMessagesRequest 验证标准 Messages 输入、
// 多模态、thinking、tools、结构化输出和采样配置都进入 Canonical Contract。
func TestRequestDecoderPreservesCompleteMessagesRequest(t *testing.T) {
	t.Parallel()

	request, err := NewRequestDecoder().Decode([]byte(`{
		"model":"claude-opus-4-6",
		"max_tokens":8192,
		"system":[
			{"type":"text","text":"你是严谨的工程助手。","cache_control":{"type":"ephemeral","ttl":"1h","scope":"global"}},
			{"type":"text","text":"所有结论必须可验证。"}
		],
		"messages":[
			{"role":"user","content":[
				{"type":"text","text":"分析附件"},
				{"type":"image","source":{"type":"base64","media_type":"image/png","data":"aGVsbG8="}},
				{"type":"document","source":{"type":"text","media_type":"text/plain","data":"账号状态证据"},"title":"证据","cache_control":{"type":"ephemeral"}}
			]},
			{"role":"assistant","content":[
				{"type":"thinking","thinking":"先读取状态","signature":"sig_exact_1"},
				{"type":"text","text":"我先调用工具。"},
				{"type":"tool_use","id":"toolu_exact_1","name":"lookup","input":{"account":"codex-1"}}
			]},
			{"role":"user","content":[
				{"type":"tool_result","tool_use_id":"toolu_exact_1","content":[
					{"type":"text","text":"available"}
				]}
			]}
		],
		"tools":[{
			"type":"custom",
			"name":"lookup",
			"description":"查询账号",
			"input_schema":{"type":"object","properties":{"account":{"type":"string"}},"required":["account"]},
			"strict":false,
			"allowed_callers":["direct","code_execution_20260120"],
			"defer_loading":true,
			"eager_input_streaming":false,
			"input_examples":[{"account":"codex-1"}],
			"cache_control":{"type":"ephemeral","ttl":"5m"}
		}],
		"tool_choice":{"type":"any","disable_parallel_tool_use":true},
		"thinking":{"type":"adaptive","display":"omitted"},
		"output_config":{
			"effort":"max",
			"format":{"type":"json_schema","schema":{"type":"object","properties":{"ok":{"type":"boolean"}}}}
		},
		"temperature":0.4,
		"top_p":0.9,
		"top_k":64,
		"metadata":{"user_id":"session_exact_1"},
		"cache_control":{"type":"ephemeral","ttl":"1h","scope":"org"},
		"stop_sequences":["\n\nDONE"],
		"stream":true
	}`))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}

	if request.ClientProtocol() != inference.ClientProtocolAnthropicMessages ||
		request.Model() != "claude-opus-4-6" ||
		request.MaxOutputTokens() != 8192 ||
		!request.Stream() {
		t.Fatalf("request basics lost: protocol=%q model=%q max=%d stream=%t",
			request.ClientProtocol(),
			request.Model(),
			request.MaxOutputTokens(),
			request.Stream(),
		)
	}
	messages := request.Messages()
	if len(messages) != 4 ||
		messages[0].Role() != inference.RoleSystem ||
		len(messages[0].Contents()) != 2 {
		t.Fatalf("messages = %#v, want system plus three conversation messages", messages)
	}
	userContents := messages[1].Contents()
	if len(userContents) != 3 ||
		userContents[1].Kind() != inference.ContentImage ||
		userContents[2].Kind() != inference.ContentDocument {
		t.Fatalf("user contents = %#v, want text/image/document", userContents)
	}
	assistantContents := messages[2].Contents()
	thinking, ok := assistantContents[0].(inference.ReasoningContent)
	if !ok ||
		thinking.ReasoningKind() != inference.ReasoningThinking ||
		thinking.Signature() != "sig_exact_1" {
		t.Fatalf("thinking = %#v, want signed thinking", assistantContents[0])
	}
	call, ok := assistantContents[2].(inference.ToolCallContent)
	if !ok || call.CallID() != "toolu_exact_1" || call.Name() != "lookup" {
		t.Fatalf("tool call = %#v, want exact identity", assistantContents[2])
	}
	result, ok := messages[3].Contents()[0].(inference.ToolResultContent)
	if !ok || result.CallID() != "toolu_exact_1" || result.IsError() {
		t.Fatalf("tool result = %#v, want successful exact result", messages[3].Contents()[0])
	}

	tools := request.Tools()
	if len(tools) != 1 || tools[0].Name() != "lookup" {
		t.Fatalf("tools = %#v, want lookup", tools)
	}
	strict, specified := tools[0].Strict()
	if !specified || strict {
		t.Fatalf("Strict() = (%t, %t), want explicit false", strict, specified)
	}
	if callers := tools[0].AllowedCallers(); len(callers) != 2 ||
		callers[0] != inference.ToolCallerDirect ||
		callers[1] != inference.ToolCallerCodeExecution20260120 {
		t.Fatalf("AllowedCallers() = %#v, want exact callers", callers)
	}
	if value, found := tools[0].DeferLoading(); !found || !value {
		t.Fatalf("DeferLoading() = (%t, %t), want explicit true", value, found)
	}
	if value, found := tools[0].EagerInputStreaming(); !found || value {
		t.Fatalf("EagerInputStreaming() = (%t, %t), want explicit false", value, found)
	}
	if examples := tools[0].InputExamples(); len(examples) != 1 ||
		string(examples[0]) != `{"account":"codex-1"}` {
		t.Fatalf("InputExamples() = %q, want exact example", examples)
	}
	choice, found := request.ToolChoice()
	if !found || choice.Mode() != inference.ToolChoiceRequired {
		t.Fatalf("ToolChoice() = (%#v, %t), want required", choice, found)
	}
	parallel, found := request.ParallelToolCalls()
	if !found || parallel {
		t.Fatalf("ParallelToolCalls() = (%t, %t), want disabled", parallel, found)
	}
	reasoning, found := request.Reasoning()
	if !found ||
		reasoning.Mode() != inference.ReasoningModeAdaptive ||
		reasoning.Effort() != inference.ReasoningEffortMax ||
		reasoning.Summary() != inference.ReasoningSummaryNone {
		t.Fatalf("Reasoning() = (%#v, %t), want adaptive max omitted", reasoning, found)
	}
	output, found := request.StructuredOutput()
	if !found ||
		output.Name() != anthropicStructuredOutputName ||
		!output.Strict() ||
		!strings.Contains(string(output.Schema()), `"ok"`) {
		t.Fatalf("StructuredOutput() = (%#v, %t), want JSON schema", output, found)
	}
	if topK, found := request.TopK(); !found || topK != 64 {
		t.Fatalf("TopK() = (%d, %t), want 64", topK, found)
	}
	if userID, found := request.UserID(); !found || userID != "session_exact_1" {
		t.Fatalf("UserID() = (%q, %t), want exact metadata user", userID, found)
	}
	breakpoints := request.PromptCacheBreakpoints()
	if len(breakpoints) != 4 ||
		breakpoints[0].Target() != inference.PromptCacheTargetMessageContent ||
		breakpoints[0].MessageIndex() != 0 ||
		breakpoints[0].ContentIndex() != 0 ||
		breakpoints[1].MessageIndex() != 1 ||
		breakpoints[1].ContentIndex() != 2 ||
		breakpoints[2].Target() != inference.PromptCacheTargetTool ||
		breakpoints[2].ToolIndex() != 0 ||
		breakpoints[3].Target() != inference.PromptCacheTargetRequest {
		t.Fatalf("PromptCacheBreakpoints() = %#v, want system/message/tool/request", breakpoints)
	}
	if breakpoints[0].Control().TTL() != inference.PromptCacheTTL1Hour ||
		breakpoints[0].Control().Scope() != inference.PromptCacheScopeGlobal ||
		breakpoints[3].Control().Scope() != inference.PromptCacheScopeOrganization {
		t.Fatalf("cache controls = %#v, want exact ttl and scope", breakpoints)
	}
	if got := request.StopSequences(); len(got) != 1 || got[0] != "\n\nDONE" {
		t.Fatalf("StopSequences() = %#v, want exact sequence", got)
	}

	required := request.RequiredCapabilities()
	for _, capability := range []inference.Capability{
		inference.CapabilityImageInput,
		inference.CapabilityDocumentInput,
		inference.CapabilityTools,
		inference.CapabilityReasoning,
		inference.CapabilityStructuredOutput,
		inference.CapabilityStreaming,
	} {
		if !required.Has(capability) {
			t.Errorf("RequiredCapabilities() missing %q", capability)
		}
	}
}

// TestRequestDecoderKeepsRedactedThinkingDistinct 验证 Claude 私有 redacted 数据
// 不会进入通用 Responses encrypted_content 语义。
func TestRequestDecoderKeepsRedactedThinkingDistinct(t *testing.T) {
	t.Parallel()

	request, err := NewRequestDecoder().Decode([]byte(`{
		"model":"claude-opus-5",
		"max_tokens":1024,
		"messages":[
			{"role":"assistant","content":[
				{"type":"redacted_thinking","data":"redacted-exact-1"},
				{"type":"text","text":"历史回答"}
			]},
			{"role":"user","content":"继续"}
		]
	}`))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	content, ok := request.Messages()[0].Contents()[0].(inference.ReasoningContent)
	if !ok ||
		content.ReasoningKind() != inference.ReasoningRedacted ||
		content.RedactedData() != "redacted-exact-1" ||
		content.EncryptedData() != "" {
		t.Fatalf("redacted content = %#v", request.Messages()[0].Contents()[0])
	}
}

// TestRequestDecoderPreservesBudgetThinkingAndNamedToolChoice 验证预算 thinking
// 与命名工具选择不会被压缩为 auto。
func TestRequestDecoderPreservesBudgetThinkingAndNamedToolChoice(t *testing.T) {
	t.Parallel()

	request, err := NewRequestDecoder().Decode([]byte(`{
		"model":"claude-sonnet-4-6",
		"max_tokens":4096,
		"system":"只返回事实。",
		"messages":[{"role":"user","content":"查询状态"}],
		"tools":[{
			"name":"lookup",
			"input_schema":{"type":"object"}
		}],
		"tool_choice":{"type":"tool","name":"lookup","disable_parallel_tool_use":false},
		"thinking":{"type":"enabled","budget_tokens":2048,"display":"summarized"},
		"output_config":{"effort":"high"}
	}`))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}

	reasoning, found := request.Reasoning()
	if !found ||
		reasoning.Mode() != inference.ReasoningModeBudget ||
		reasoning.BudgetTokens() != 2048 ||
		reasoning.Effort() != inference.ReasoningEffortHigh ||
		reasoning.Summary() != inference.ReasoningSummaryAuto {
		t.Fatalf("Reasoning() = (%#v, %t), want budget high summarized", reasoning, found)
	}
	choice, found := request.ToolChoice()
	if !found ||
		choice.Mode() != inference.ToolChoiceNamed ||
		choice.Name() != "lookup" {
		t.Fatalf("ToolChoice() = (%#v, %t), want named lookup", choice, found)
	}
	parallel, found := request.ParallelToolCalls()
	if !found || !parallel {
		t.Fatalf("ParallelToolCalls() = (%t, %t), want enabled", parallel, found)
	}
}

// TestRequestDecoderAcceptsEmptyToolResult 验证 Messages 合法的缺省 content
// 不会被适配器伪造成占位字符串。
func TestRequestDecoderAcceptsEmptyToolResult(t *testing.T) {
	t.Parallel()

	request, err := NewRequestDecoder().Decode([]byte(`{
		"model":"claude-sonnet-4-6",
		"max_tokens":1024,
		"messages":[
			{"role":"assistant","content":[
				{"type":"tool_use","id":"toolu_empty_1","name":"lookup","input":{}}
			]},
			{"role":"user","content":[
				{"type":"tool_result","tool_use_id":"toolu_empty_1","is_error":true}
			]}
		]
	}`))
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	result := request.Messages()[1].Contents()[0].(inference.ToolResultContent)
	if !result.IsError() || len(result.Contents()) != 0 {
		t.Fatalf("result = %#v, want empty error payload", result)
	}
}

// TestRequestDecoderRejectsInvalidAndUnsupportedFields 验证错误路径稳定且不会
// 把不支持的 Anthropic 功能静默忽略。
func TestRequestDecoderRejectsInvalidAndUnsupportedFields(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		body      string
		wantKind  error
		wantField string
	}{
		{
			name:      "missing max tokens",
			body:      `{"model":"claude","messages":[{"role":"user","content":"x"}]}`,
			wantKind:  ErrInvalidMessagesRequest,
			wantField: "max_tokens",
		},
		{
			name:      "unknown root",
			body:      `{"model":"claude","max_tokens":1,"messages":[{"role":"user","content":"x"}],"unknown":true}`,
			wantKind:  ErrInvalidMessagesRequest,
			wantField: "$",
		},
		{
			name:      "temperature outside Anthropic range",
			body:      `{"model":"claude","max_tokens":1,"messages":[{"role":"user","content":"x"}],"temperature":1.1}`,
			wantKind:  ErrInvalidMessagesRequest,
			wantField: "temperature",
		},
		{
			name:      "thinking budget below minimum",
			body:      `{"model":"claude","max_tokens":2048,"messages":[{"role":"user","content":"x"}],"thinking":{"type":"enabled","budget_tokens":512}}`,
			wantKind:  ErrInvalidMessagesRequest,
			wantField: "thinking.budget_tokens",
		},
		{
			name:      "thinking budget reaches max tokens",
			body:      `{"model":"claude","max_tokens":2048,"messages":[{"role":"user","content":"x"}],"thinking":{"type":"enabled","budget_tokens":2048}}`,
			wantKind:  ErrInvalidMessagesRequest,
			wantField: "thinking.budget_tokens",
		},
		{
			name:      "orphan tool result",
			body:      `{"model":"claude","max_tokens":1,"messages":[{"role":"user","content":[{"type":"tool_result","tool_use_id":"missing","content":"x"}]}]}`,
			wantKind:  ErrInvalidMessagesRequest,
			wantField: "$",
		},
		{
			name:      "invalid message cache ttl",
			body:      `{"model":"claude","max_tokens":1,"messages":[{"role":"user","content":[{"type":"text","text":"x","cache_control":{"type":"ephemeral","ttl":"forever"}}]}]}`,
			wantKind:  ErrInvalidMessagesRequest,
			wantField: "messages[0].content[0].cache_control",
		},
		{
			name:      "invalid metadata field",
			body:      `{"model":"claude","max_tokens":1,"messages":[{"role":"user","content":"x"}],"metadata":{"email":"x@example.test"}}`,
			wantKind:  ErrInvalidMessagesRequest,
			wantField: "metadata",
		},
		{
			name:      "unsupported built in tool",
			body:      `{"model":"claude","max_tokens":1,"messages":[{"role":"user","content":"x"}],"tools":[{"type":"web_search_20260209","name":"web_search"}]}`,
			wantKind:  ErrUnsupportedFeature,
			wantField: "tools[0].type",
		},
		{
			name:      "invalid tool input example",
			body:      `{"model":"claude","max_tokens":1,"messages":[{"role":"user","content":"x"}],"tools":[{"name":"lookup","input_schema":{"type":"object"},"input_examples":[["not","object"]]}]}`,
			wantKind:  ErrInvalidMessagesRequest,
			wantField: "tools[0]",
		},
		{
			name:      "invalid image media type",
			body:      `{"model":"claude","max_tokens":1,"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/svg+xml","data":"eA=="}}]}]}`,
			wantKind:  ErrInvalidMessagesRequest,
			wantField: "messages[0].content[0].source.media_type",
		},
		{
			name:      "unsupported document content source",
			body:      `{"model":"claude","max_tokens":1,"messages":[{"role":"user","content":[{"type":"document","source":{"type":"content","content":"x"}}]}]}`,
			wantKind:  ErrUnsupportedFeature,
			wantField: "messages[0].content[0].source.type",
		},
	}

	decoder := NewRequestDecoder()
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, err := decoder.Decode([]byte(test.body))
			if !errors.Is(err, test.wantKind) {
				t.Fatalf("Decode() error = %v, want kind %v", err, test.wantKind)
			}
			if err == nil || !strings.Contains(err.Error(), test.wantField) {
				t.Fatalf("Decode() error = %v, want field %q", err, test.wantField)
			}
		})
	}
}

// TestRequestDecoderErrorDoesNotLeakFieldValue 验证低敏错误不会回显请求正文。
func TestRequestDecoderErrorDoesNotLeakFieldValue(t *testing.T) {
	t.Parallel()

	const secret = "sk-ant-sensitive-value"
	_, err := NewRequestDecoder().Decode([]byte(`{
		"model":"claude",
		"max_tokens":1,
		"messages":[{"role":"user","content":"x"}],
		"metadata":{"secret_field":"` + secret + `"}
	}`))
	if err == nil {
		t.Fatal("Decode() error = nil, want invalid metadata")
	}
	if strings.Contains(err.Error(), secret) {
		t.Fatalf("Decode() error leaked secret: %v", err)
	}
}
