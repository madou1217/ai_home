package aihserver_test

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/modelsapi"
	"github.com/madou1217/ai_home/internal/transport/http/openaichatcompletionsapi"
)

// realChatCompletion 是真实非流式 Chat Completion 的最小公开合同。
type realChatCompletion struct {
	ID      string           `json:"id"`
	Object  string           `json:"object"`
	Created int64            `json:"created"`
	Model   string           `json:"model"`
	Choices []realChatChoice `json:"choices"`
	Usage   *realChatUsage   `json:"usage"`
}

// realChatChoice 保存唯一 choice 的完整消息和完成原因。
type realChatChoice struct {
	Index        uint32          `json:"index"`
	Message      realChatMessage `json:"message"`
	FinishReason string          `json:"finish_reason"`
}

// realChatMessage 保存 Assistant 文本或函数调用。
type realChatMessage struct {
	Role      string             `json:"role"`
	Content   *string            `json:"content"`
	ToolCalls []realChatToolCall `json:"tool_calls"`
}

// realChatToolCall 是客户端必须能继续提交结果的完整函数调用。
type realChatToolCall struct {
	ID       string               `json:"id"`
	Type     string               `json:"type"`
	Function realChatFunctionCall `json:"function"`
}

// realChatFunctionCall 保存函数名和完整 JSON 参数字符串。
type realChatFunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// realChatUsage 保存 Chat 协议公开的累计 Token。
type realChatUsage struct {
	PromptTokens     uint64 `json:"prompt_tokens"`
	CompletionTokens uint64 `json:"completion_tokens"`
	TotalTokens      uint64 `json:"total_tokens"`
}

// realChatStreamResult 是按 Chat delta 语义重组的流式终值。
type realChatStreamResult struct {
	responseID    string
	model         string
	role          string
	content       string
	toolID        string
	toolName      string
	toolArguments string
	finishReason  string
	usage         *realChatUsage
	done          bool
	chunks        int
}

// TestRealCodexChatCompletionsEndToEnd 通过真实 Plus OAuth 账号验收
// Chat→Canonical→Codex Responses→Chat 的双向文本和函数工具链。
//
// 默认跳过；显式提供 AIH_REAL_CODEX_AUTH_FILE 后只允许一个模型目录请求和
// 四个推理请求，任何额外重试都会在到达网络前失败。
func TestRealCodexChatCompletionsEndToEnd(t *testing.T) {
	authJSON := readRealCodexAuthFromEnvironment(t)
	defer clear(authJSON)
	authExpiresAt := assertRealCodexAuthReady(t, authJSON)

	upstream := newRealCodexUpstreamBudget(4)
	fixture := startRealCodexFixture(t, authJSON, upstream)

	nonStreamTextPayload := marshalRealChatTextPayload(t, false)
	nonStreamText := performRealChatRequest(t, fixture, nonStreamTextPayload, false)
	nonStreamTextDocument := decodeRealChatCompletion(t, nonStreamText.body)
	assertRealChatText(t, nonStreamTextDocument)
	clear(nonStreamTextPayload)

	streamTextPayload := marshalRealChatTextPayload(t, true)
	streamText := performRealChatRequest(t, fixture, streamTextPayload, true)
	streamTextDocument := decodeRealChatStream(t, streamText)
	assertRealChatStreamText(t, streamTextDocument)
	clear(streamTextPayload)

	nonStreamToolPayload := marshalRealChatToolPayload(t, false)
	nonStreamTool := performRealChatRequest(t, fixture, nonStreamToolPayload, false)
	nonStreamToolDocument := decodeRealChatCompletion(t, nonStreamTool.body)
	assertRealChatTool(t, nonStreamToolDocument)
	clear(nonStreamToolPayload)

	streamToolPayload := marshalRealChatToolPayload(t, true)
	streamTool := performRealChatRequest(t, fixture, streamToolPayload, true)
	streamToolDocument := decodeRealChatStream(t, streamTool)
	assertRealChatStreamTool(t, streamToolDocument)
	clear(streamToolPayload)

	wantCounts := realCodexRequestCounts{models: 1, responses: 4}
	if counts := upstream.snapshot(); counts != wantCounts {
		t.Fatalf("真实 Chat 请求预算错误: got=%+v want=%+v", counts, wantCounts)
	}
	if info, err := os.Stat(fixture.databasePath()); err != nil || info.IsDir() {
		t.Fatalf("临时 aih.db 未创建: %v", err)
	}

	t.Logf(
		strings.Join([]string{
			"真实 Codex Chat Completions 验收通过",
			"api_base: %s",
			"authorization: Bearer <local-test-key-redacted>",
			"import: POST %s status=%d auth_kind=%s auth_mode=<none>",
			"models: GET %s status=%d count=%d contains_%s=true",
			"text_non_stream: POST %s payload=%s status=%d response=%s",
			"text_stream: POST %s payload=%s status=%d result=%s",
			"tool_non_stream: POST %s payload=%s status=%d response=%s",
			"tool_stream: POST %s payload=%s status=%d result=%s",
			"upstream_requests: models=1 responses=4 unexpected=0",
			"oauth_access_expires_at: %s refresh_due=false",
			"temporary_database: created=true cleanup=registered",
		}, "\n"),
		fixture.baseURL,
		fixture.baseURL+accountsapi.NativeImportPath,
		fixture.importStatus,
		fixture.authKind,
		fixture.baseURL+modelsapi.Path,
		fixture.modelsStatus,
		fixture.modelCount,
		realCodexModel,
		fixture.baseURL+openaichatcompletionsapi.Path,
		string(marshalRealChatTextPayload(t, false)),
		nonStreamText.status,
		nonStreamText.body,
		fixture.baseURL+openaichatcompletionsapi.Path,
		string(marshalRealChatTextPayload(t, true)),
		streamText.status,
		marshalRealChatStreamResult(t, streamTextDocument),
		fixture.baseURL+openaichatcompletionsapi.Path,
		string(marshalRealChatToolPayload(t, false)),
		nonStreamTool.status,
		nonStreamTool.body,
		fixture.baseURL+openaichatcompletionsapi.Path,
		string(marshalRealChatToolPayload(t, true)),
		streamTool.status,
		marshalRealChatStreamResult(t, streamToolDocument),
		authExpiresAt.Format(time.RFC3339),
	)
}

// performRealChatRequest 调用临时 Server 的公开 Chat Completions 地址。
func performRealChatRequest(
	t *testing.T,
	fixture realCodexFixture,
	payload []byte,
	stream bool,
) httpExchange {
	t.Helper()

	exchange := performRequest(
		t,
		fixture.client,
		http.MethodPost,
		fixture.baseURL+openaichatcompletionsapi.Path,
		testClientKey,
		payload,
	)
	if stream {
		assertRealCodexStreamStatus(t, exchange)
	} else {
		assertStatus(t, exchange, http.StatusOK)
	}
	return exchange
}

// marshalRealChatTextPayload 创建不带任何输出 Token 上限的固定文本请求。
func marshalRealChatTextPayload(t *testing.T, stream bool) []byte {
	t.Helper()

	payload := map[string]any{
		"model": realCodexModel,
		"messages": []map[string]string{
			{
				"role":    "developer",
				"content": "Return only the exact marker requested by the user.",
			},
			{
				"role":    "user",
				"content": "Reply with exactly: " + realCodexMarker,
			},
		},
		"stream": stream,
	}
	if stream {
		payload["stream_options"] = map[string]bool{"include_usage": true}
	}
	return marshalRealChatPayload(t, payload)
}

// marshalRealChatToolPayload 强制模型调用一个参数受限的函数工具。
func marshalRealChatToolPayload(t *testing.T, stream bool) []byte {
	t.Helper()

	payload := map[string]any{
		"model": realCodexModel,
		"messages": []map[string]string{{
			"role": "user",
			"content": realCodexMarker +
				". Call get_weather exactly once with city Shenzhen. Do not answer in text.",
		}},
		"tools": []map[string]any{{
			"type": "function",
			"function": map[string]any{
				"name":        realCodexToolName,
				"description": "Return weather for the requested city.",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"city": map[string]any{
							"type": "string",
							"enum": []string{"Shenzhen"},
						},
					},
					"required":             []string{"city"},
					"additionalProperties": false,
				},
			},
		}},
		"tool_choice": map[string]any{
			"type": "function",
			"function": map[string]string{
				"name": realCodexToolName,
			},
		},
		"parallel_tool_calls": false,
		"stream":              stream,
	}
	if stream {
		payload["stream_options"] = map[string]bool{"include_usage": true}
	}
	return marshalRealChatPayload(t, payload)
}

// marshalRealChatPayload 编码请求并防止测试意外添加输出上限。
func marshalRealChatPayload(t *testing.T, payload map[string]any) []byte {
	t.Helper()

	if _, found := payload["max_completion_tokens"]; found {
		t.Fatal("真实 Chat 请求不能私自添加 max_completion_tokens")
	}
	if _, found := payload["max_tokens"]; found {
		t.Fatal("真实 Chat 请求不能私自添加 max_tokens")
	}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("编码真实 Chat 请求失败: %v", err)
	}
	return data
}

// decodeRealChatCompletion 解码非流式公开响应。
func decodeRealChatCompletion(t *testing.T, body string) realChatCompletion {
	t.Helper()

	var document realChatCompletion
	if err := json.Unmarshal([]byte(body), &document); err != nil {
		t.Fatalf("真实 Chat Completion JSON 无效: %v body=%s", err, body)
	}
	return document
}

// assertRealChatEnvelope 校验所有非流式 Chat 响应共享的生命周期和 usage。
func assertRealChatEnvelope(t *testing.T, document realChatCompletion) realChatChoice {
	t.Helper()

	if document.ID == "" ||
		document.Object != "chat.completion" ||
		document.Created <= 0 ||
		document.Model != realCodexModel ||
		len(document.Choices) != 1 ||
		document.Choices[0].Index != 0 ||
		document.Choices[0].Message.Role != "assistant" {
		t.Fatalf("真实 Chat Completion envelope 无效: %+v", document)
	}
	assertRealChatUsage(t, document.Usage)
	return document.Choices[0]
}

// assertRealChatText 校验非流式文本和自然停止原因。
func assertRealChatText(t *testing.T, document realChatCompletion) {
	t.Helper()

	choice := assertRealChatEnvelope(t, document)
	if choice.Message.Content == nil ||
		*choice.Message.Content != realCodexMarker ||
		len(choice.Message.ToolCalls) != 0 ||
		choice.FinishReason != "stop" {
		t.Fatalf("真实 Chat 文本响应无效: %+v", choice)
	}
}

// assertRealChatTool 校验非流式函数调用可被客户端继续执行。
func assertRealChatTool(t *testing.T, document realChatCompletion) {
	t.Helper()

	choice := assertRealChatEnvelope(t, document)
	if choice.Message.Content != nil ||
		choice.FinishReason != "tool_calls" ||
		len(choice.Message.ToolCalls) != 1 {
		t.Fatalf("真实 Chat 工具响应无效: %+v", choice)
	}
	assertRealChatToolCall(t, choice.Message.ToolCalls[0])
}

// assertRealChatToolCall 校验工具身份和完整 JSON 参数。
func assertRealChatToolCall(t *testing.T, toolCall realChatToolCall) {
	t.Helper()

	if toolCall.ID == "" ||
		toolCall.Type != "function" ||
		toolCall.Function.Name != realCodexToolName {
		t.Fatalf("真实 Chat 工具身份无效: %+v", toolCall)
	}
	var arguments struct {
		City string `json:"city"`
	}
	if err := json.Unmarshal([]byte(toolCall.Function.Arguments), &arguments); err != nil ||
		arguments.City != "Shenzhen" {
		t.Fatalf(
			"真实 Chat 工具参数无效: arguments=%q err=%v",
			toolCall.Function.Arguments,
			err,
		)
	}
}

// assertRealChatUsage 校验真实 Token 总数保持守恒。
func assertRealChatUsage(t *testing.T, usage *realChatUsage) {
	t.Helper()

	if usage == nil ||
		usage.PromptTokens == 0 ||
		usage.CompletionTokens == 0 ||
		usage.TotalTokens != usage.PromptTokens+usage.CompletionTokens {
		t.Fatalf("真实 Chat usage 无效: %+v", usage)
	}
}

// decodeRealChatStream 按 data-only SSE 合并文本和工具参数增量。
func decodeRealChatStream(t *testing.T, exchange httpExchange) realChatStreamResult {
	t.Helper()

	if !strings.HasPrefix(exchange.header.Get("Content-Type"), "text/event-stream") ||
		strings.Contains(exchange.body, "event:") {
		t.Fatalf("真实 Chat SSE 响应头或帧格式错误: %#v", exchange)
	}
	var result realChatStreamResult
	var content strings.Builder
	var arguments strings.Builder
	for _, line := range strings.Split(strings.ReplaceAll(exchange.body, "\r\n", "\n"), "\n") {
		data, found := strings.CutPrefix(line, "data: ")
		if !found {
			continue
		}
		if data == "[DONE]" {
			result.done = true
			continue
		}
		result.chunks++
		applyRealChatChunk(t, &result, &content, &arguments, []byte(data))
	}
	result.content = content.String()
	result.toolArguments = arguments.String()
	return result
}

// applyRealChatChunk 校验单帧身份并累计唯一 choice。
func applyRealChatChunk(
	t *testing.T,
	result *realChatStreamResult,
	content *strings.Builder,
	arguments *strings.Builder,
	data []byte,
) {
	t.Helper()

	var chunk struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		Created int64  `json:"created"`
		Model   string `json:"model"`
		Choices []struct {
			Index uint32 `json:"index"`
			Delta struct {
				Role      string `json:"role"`
				Content   string `json:"content"`
				ToolCalls []struct {
					Index    uint32 `json:"index"`
					ID       string `json:"id"`
					Type     string `json:"type"`
					Function struct {
						Name      *string `json:"name"`
						Arguments *string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"delta"`
			FinishReason *string `json:"finish_reason"`
		} `json:"choices"`
		Usage *realChatUsage `json:"usage"`
	}
	if err := json.Unmarshal(data, &chunk); err != nil {
		t.Fatalf("真实 Chat SSE JSON 无效: %v data=%s", err, data)
	}
	if chunk.ID == "" ||
		chunk.Object != "chat.completion.chunk" ||
		chunk.Created <= 0 ||
		chunk.Model != realCodexModel {
		t.Fatalf("真实 Chat SSE envelope 无效: %+v", chunk)
	}
	if result.responseID == "" {
		result.responseID, result.model = chunk.ID, chunk.Model
	} else if result.responseID != chunk.ID || result.model != chunk.Model {
		t.Fatalf("真实 Chat SSE 身份漂移: %+v", chunk)
	}
	if len(chunk.Choices) == 0 {
		if chunk.Usage == nil {
			t.Fatalf("真实 Chat SSE 空 choices 缺少 usage: %s", data)
		}
		result.usage = chunk.Usage
		return
	}
	if len(chunk.Choices) != 1 || chunk.Choices[0].Index != 0 {
		t.Fatalf("真实 Chat SSE choice 无效: %+v", chunk.Choices)
	}
	choice := chunk.Choices[0]
	if choice.Delta.Role != "" {
		result.role = choice.Delta.Role
	}
	content.WriteString(choice.Delta.Content)
	if choice.FinishReason != nil {
		result.finishReason = *choice.FinishReason
	}
	for _, toolCall := range choice.Delta.ToolCalls {
		if toolCall.Index != 0 {
			t.Fatalf("真实 Chat SSE 工具索引无效: %d", toolCall.Index)
		}
		if toolCall.ID != "" {
			result.toolID = toolCall.ID
		}
		if toolCall.Type != "" && toolCall.Type != "function" {
			t.Fatalf("真实 Chat SSE 工具类型无效: %q", toolCall.Type)
		}
		if toolCall.Function.Name != nil {
			result.toolName = *toolCall.Function.Name
		}
		if toolCall.Function.Arguments != nil {
			arguments.WriteString(*toolCall.Function.Arguments)
		}
	}
}

// assertRealChatStreamText 校验文本增量、usage 尾块与 DONE。
func assertRealChatStreamText(t *testing.T, result realChatStreamResult) {
	t.Helper()

	if result.responseID == "" ||
		result.role != "assistant" ||
		result.content != realCodexMarker ||
		result.toolID != "" ||
		result.finishReason != "stop" ||
		!result.done ||
		result.chunks < 3 {
		t.Fatalf("真实 Chat 文本 SSE 无效: %+v", result)
	}
	assertRealChatUsage(t, result.usage)
}

// assertRealChatStreamTool 校验工具增量可重组成一个完整函数调用。
func assertRealChatStreamTool(t *testing.T, result realChatStreamResult) {
	t.Helper()

	if result.responseID == "" ||
		result.role != "assistant" ||
		result.content != "" ||
		result.finishReason != "tool_calls" ||
		!result.done ||
		result.chunks < 3 {
		t.Fatalf("真实 Chat 工具 SSE 无效: %+v", result)
	}
	assertRealChatToolCall(t, realChatToolCall{
		ID:   result.toolID,
		Type: "function",
		Function: realChatFunctionCall{
			Name:      result.toolName,
			Arguments: result.toolArguments,
		},
	})
	assertRealChatUsage(t, result.usage)
}

// marshalRealChatStreamResult 生成不含上游原始帧的验收日志摘要。
func marshalRealChatStreamResult(t *testing.T, result realChatStreamResult) string {
	t.Helper()

	data, err := json.Marshal(map[string]any{
		"id_present":      result.responseID != "",
		"model":           result.model,
		"role":            result.role,
		"content":         result.content,
		"tool_id_present": result.toolID != "",
		"tool_name":       result.toolName,
		"tool_arguments":  result.toolArguments,
		"finish_reason":   result.finishReason,
		"usage":           result.usage,
		"done":            result.done,
		"chunks":          result.chunks,
	})
	if err != nil {
		t.Fatalf("编码真实 Chat SSE 摘要失败: %v", err)
	}
	return string(data)
}
