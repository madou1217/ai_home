package aihserver_test

import (
	"encoding/json"
	"net/http"
	"os"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/anthropicmessagesapi"
	"github.com/madou1217/ai_home/internal/transport/http/modelsapi"
)

const realAnthropicMaxTokens = 4_096

// realAnthropicMessage 是真实非流式 Messages 响应的最小公开合同。
type realAnthropicMessage struct {
	ID           string             `json:"id"`
	Type         string             `json:"type"`
	Role         string             `json:"role"`
	Model        string             `json:"model"`
	Content      []json.RawMessage  `json:"content"`
	StopReason   *string            `json:"stop_reason"`
	StopSequence *string            `json:"stop_sequence"`
	Usage        realAnthropicUsage `json:"usage"`
}

// realAnthropicUsage 保存 Messages 客户端可见的 Token 分区。
type realAnthropicUsage struct {
	InputTokens              uint64 `json:"input_tokens"`
	CacheCreationInputTokens uint64 `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     uint64 `json:"cache_read_input_tokens"`
	OutputTokens             uint64 `json:"output_tokens"`
}

// realAnthropicStreamResult 按 Messages 内容块语义重组流式终值。
type realAnthropicStreamResult struct {
	responseID    string
	model         string
	role          string
	content       string
	toolID        string
	toolName      string
	toolArguments string
	stopReason    string
	usage         realAnthropicUsage
	events        []string
	blockTypes    []string
	stopped       bool
}

// TestRealCodexAnthropicMessagesEndToEnd 通过真实 Plus OAuth 账号验收
// Messages→Canonical→Codex Responses→Messages 的文本和函数工具链。
//
// Anthropic max_tokens 是客户端必填字段，但 Codex OAuth 上游不接受
// max_output_tokens；真实请求预算会同时锁住该跨协议投影。
func TestRealCodexAnthropicMessagesEndToEnd(t *testing.T) {
	authJSON := readRealCodexAuthFromEnvironment(t)
	defer clear(authJSON)
	authExpiresAt := assertRealCodexAuthReady(t, authJSON)

	upstream := newRealCodexUpstreamBudget(4)
	fixture := startRealCodexFixture(t, authJSON, upstream)

	nonStreamTextPayload := marshalRealAnthropicTextPayload(t, false)
	nonStreamText := performRealAnthropicRequest(
		t,
		fixture,
		nonStreamTextPayload,
		false,
	)
	nonStreamTextDocument := decodeRealAnthropicMessage(t, nonStreamText.body)
	assertRealAnthropicText(t, nonStreamTextDocument)
	clear(nonStreamTextPayload)

	streamTextPayload := marshalRealAnthropicTextPayload(t, true)
	streamText := performRealAnthropicRequest(t, fixture, streamTextPayload, true)
	streamTextDocument := decodeRealAnthropicStream(t, streamText)
	assertRealAnthropicStreamText(t, streamTextDocument)
	clear(streamTextPayload)

	nonStreamToolPayload := marshalRealAnthropicToolPayload(t, false)
	nonStreamTool := performRealAnthropicRequest(
		t,
		fixture,
		nonStreamToolPayload,
		false,
	)
	nonStreamToolDocument := decodeRealAnthropicMessage(t, nonStreamTool.body)
	assertRealAnthropicTool(t, nonStreamToolDocument)
	clear(nonStreamToolPayload)

	streamToolPayload := marshalRealAnthropicToolPayload(t, true)
	streamTool := performRealAnthropicRequest(t, fixture, streamToolPayload, true)
	streamToolDocument := decodeRealAnthropicStream(t, streamTool)
	assertRealAnthropicStreamTool(t, streamToolDocument)
	clear(streamToolPayload)

	wantCounts := realCodexRequestCounts{models: 1, responses: 4}
	if counts := upstream.snapshot(); counts != wantCounts {
		t.Fatalf("真实 Messages 请求预算错误: got=%+v want=%+v", counts, wantCounts)
	}
	if info, err := os.Stat(fixture.databasePath()); err != nil || info.IsDir() {
		t.Fatalf("临时 aih.db 未创建: %v", err)
	}

	t.Logf(
		strings.Join([]string{
			"真实 Codex Anthropic Messages 验收通过",
			"api_base: %s",
			"authentication: x-api-key <local-test-key-redacted>",
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
		fixture.baseURL+anthropicmessagesapi.Path,
		string(marshalRealAnthropicTextPayload(t, false)),
		nonStreamText.status,
		nonStreamText.body,
		fixture.baseURL+anthropicmessagesapi.Path,
		string(marshalRealAnthropicTextPayload(t, true)),
		streamText.status,
		marshalRealAnthropicStreamResult(t, streamTextDocument),
		fixture.baseURL+anthropicmessagesapi.Path,
		string(marshalRealAnthropicToolPayload(t, false)),
		nonStreamTool.status,
		nonStreamTool.body,
		fixture.baseURL+anthropicmessagesapi.Path,
		string(marshalRealAnthropicToolPayload(t, true)),
		streamTool.status,
		marshalRealAnthropicStreamResult(t, streamToolDocument),
		authExpiresAt.Format(time.RFC3339),
	)
}

// TestRealCodexAnthropicThinkingEndToEnd 使用真实 Plus OAuth 验证 thinking
// 请求的 JSON/SSE 主结果。Codex 私有摘要和密文不会伪造成 Claude 内容块。
func TestRealCodexAnthropicThinkingEndToEnd(t *testing.T) {
	authJSON := readRealCodexAuthFromEnvironment(t)
	defer clear(authJSON)
	authExpiresAt := assertRealCodexAuthReady(t, authJSON)

	upstream := newRealCodexUpstreamBudget(2)
	fixture := startRealCodexFixture(t, authJSON, upstream)

	nonStreamPayload := marshalRealAnthropicThinkingPayload(t, false)
	nonStream := performRealAnthropicRequest(t, fixture, nonStreamPayload, false)
	nonStreamDocument := decodeRealAnthropicMessage(t, nonStream.body)
	assertRealAnthropicText(t, nonStreamDocument)
	clear(nonStreamPayload)

	streamPayload := marshalRealAnthropicThinkingPayload(t, true)
	stream := performRealAnthropicRequest(t, fixture, streamPayload, true)
	streamDocument := decodeRealAnthropicStream(t, stream)
	assertRealAnthropicStreamText(t, streamDocument)
	clear(streamPayload)

	wantCounts := realCodexRequestCounts{
		models:              1,
		responses:           2,
		summarizedReasoning: 2,
	}
	if counts := upstream.snapshot(); counts != wantCounts {
		t.Fatalf("真实 Messages thinking 请求预算错误: got=%+v want=%+v", counts, wantCounts)
	}

	t.Logf(
		strings.Join([]string{
			"真实 Codex Anthropic thinking 验收通过",
			"api_base: %s",
			"authentication: x-api-key <local-test-key-redacted>",
			"thinking_non_stream: POST %s payload=%s status=%d response=%s",
			"thinking_stream: POST %s payload=%s status=%d result=%s",
			"upstream_requests: models=1 responses=2 summarized_reasoning=2 unexpected=0",
			"oauth_access_expires_at: %s refresh_due=false",
			"temporary_database: created=true cleanup=registered",
		}, "\n"),
		fixture.baseURL,
		fixture.baseURL+anthropicmessagesapi.Path,
		string(marshalRealAnthropicThinkingPayload(t, false)),
		nonStream.status,
		nonStream.body,
		fixture.baseURL+anthropicmessagesapi.Path,
		string(marshalRealAnthropicThinkingPayload(t, true)),
		stream.status,
		marshalRealAnthropicStreamResult(t, streamDocument),
		authExpiresAt.Format(time.RFC3339),
	)
}

// marshalRealAnthropicThinkingPayload 创建带显式预算和摘要意图的请求。
// Codex 可执行 reasoning，但 Responses 私有连续性不能伪造成 Claude 内容块。
func marshalRealAnthropicThinkingPayload(t *testing.T, stream bool) []byte {
	t.Helper()

	return marshalRealAnthropicPayload(t, map[string]any{
		"model":      realCodexModel,
		"max_tokens": realAnthropicMaxTokens,
		"system":     "Return only the exact marker requested by the user.",
		"messages": []map[string]string{{
			"role":    "user",
			"content": "Think carefully, then reply with exactly: " + realCodexMarker,
		}},
		"thinking": map[string]any{
			"type":          "enabled",
			"budget_tokens": 1_024,
			"display":       "summarized",
		},
		"output_config": map[string]string{"effort": "low"},
		"stream":        stream,
	})
}

// performRealAnthropicRequest 用 Anthropic 公开鉴权头调用临时 Server。
func performRealAnthropicRequest(
	t *testing.T,
	fixture realCodexFixture,
	payload []byte,
	stream bool,
) httpExchange {
	t.Helper()

	exchange := performRequestWithHeaders(
		t,
		fixture.client,
		http.MethodPost,
		fixture.baseURL+anthropicmessagesapi.Path,
		map[string]string{
			"anthropic-version": "2023-06-01",
			"x-api-key":         testClientKey,
		},
		payload,
	)
	if stream {
		assertRealCodexStreamStatus(t, exchange)
	} else {
		assertStatus(t, exchange, http.StatusOK)
	}
	return exchange
}

// marshalRealAnthropicTextPayload 创建使用必填 max_tokens 的固定文本请求。
func marshalRealAnthropicTextPayload(t *testing.T, stream bool) []byte {
	t.Helper()

	return marshalRealAnthropicPayload(t, map[string]any{
		"model":      realCodexModel,
		"max_tokens": realAnthropicMaxTokens,
		"system":     "Return only the exact marker requested by the user.",
		"messages": []map[string]string{{
			"role":    "user",
			"content": "Reply with exactly: " + realCodexMarker,
		}},
		"stream": stream,
	})
}

// marshalRealAnthropicToolPayload 创建强制单个函数工具的 Messages 请求。
func marshalRealAnthropicToolPayload(t *testing.T, stream bool) []byte {
	t.Helper()

	return marshalRealAnthropicPayload(t, map[string]any{
		"model":      realCodexModel,
		"max_tokens": realAnthropicMaxTokens,
		"messages": []map[string]string{{
			"role": "user",
			"content": realCodexMarker +
				". Call get_weather exactly once with city Shenzhen. Do not answer in text.",
		}},
		"tools": []map[string]any{{
			"name":        realCodexToolName,
			"description": "Return weather for the requested city.",
			"input_schema": map[string]any{
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
		}},
		"tool_choice": map[string]any{
			"type":                      "tool",
			"name":                      realCodexToolName,
			"disable_parallel_tool_use": true,
		},
		"stream": stream,
	})
}

// marshalRealAnthropicPayload 编码请求并锁住 Anthropic/Codex 字段边界。
func marshalRealAnthropicPayload(t *testing.T, payload map[string]any) []byte {
	t.Helper()

	if payload["max_tokens"] != realAnthropicMaxTokens {
		t.Fatal("真实 Messages 请求必须使用已确认的 max_tokens")
	}
	if _, found := payload["max_output_tokens"]; found {
		t.Fatal("Messages 客户端请求不能出现 Codex max_output_tokens")
	}
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("编码真实 Messages 请求失败: %v", err)
	}
	return data
}

// decodeRealAnthropicMessage 解码非流式公开响应。
func decodeRealAnthropicMessage(t *testing.T, body string) realAnthropicMessage {
	t.Helper()

	var message realAnthropicMessage
	if err := json.Unmarshal([]byte(body), &message); err != nil {
		t.Fatalf("真实 Messages JSON 无效: %v body=%s", err, body)
	}
	return message
}

// assertRealAnthropicEnvelope 校验非流式 Messages 的公共终态。
func assertRealAnthropicEnvelope(
	t *testing.T,
	message realAnthropicMessage,
	wantStopReason string,
) {
	t.Helper()

	if message.ID == "" ||
		message.Type != "message" ||
		message.Role != "assistant" ||
		message.Model != realCodexModel ||
		message.StopReason == nil ||
		*message.StopReason != wantStopReason ||
		message.StopSequence != nil {
		t.Fatalf("真实 Messages envelope 无效: %+v", message)
	}
	assertRealAnthropicUsage(t, message.Usage)
}

// assertRealAnthropicText 校验非流式文本内容块。
func assertRealAnthropicText(t *testing.T, message realAnthropicMessage) {
	t.Helper()

	assertRealAnthropicEnvelope(t, message, "end_turn")
	if len(message.Content) != 1 {
		t.Fatalf("真实 Messages 文本块数量错误: %s", message.Content)
	}
	var block struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(message.Content[0], &block); err != nil ||
		block.Type != "text" ||
		block.Text != realCodexMarker {
		t.Fatalf("真实 Messages 文本块无效: block=%s err=%v", message.Content[0], err)
	}
}

// assertRealAnthropicTool 校验非流式工具内容块。
func assertRealAnthropicTool(t *testing.T, message realAnthropicMessage) {
	t.Helper()

	assertRealAnthropicEnvelope(t, message, "tool_use")
	if len(message.Content) != 1 {
		t.Fatalf("真实 Messages 工具块数量错误: %s", message.Content)
	}
	assertRealAnthropicToolBlock(t, message.Content[0])
}

// assertRealAnthropicToolBlock 校验客户端可继续提交结果的完整工具块。
func assertRealAnthropicToolBlock(t *testing.T, data json.RawMessage) {
	t.Helper()

	var block struct {
		Type  string          `json:"type"`
		ID    string          `json:"id"`
		Name  string          `json:"name"`
		Input json.RawMessage `json:"input"`
	}
	if err := json.Unmarshal(data, &block); err != nil ||
		block.Type != "tool_use" ||
		block.ID == "" ||
		block.Name != realCodexToolName {
		t.Fatalf("真实 Messages 工具身份无效: block=%s err=%v", data, err)
	}
	assertRealAnthropicToolInput(t, block.Input)
}

// assertRealAnthropicToolInput 校验工具参数是完整的 JSON 对象。
func assertRealAnthropicToolInput(t *testing.T, data json.RawMessage) {
	t.Helper()

	var input struct {
		City string `json:"city"`
	}
	if err := json.Unmarshal(data, &input); err != nil || input.City != "Shenzhen" {
		t.Fatalf("真实 Messages 工具参数无效: input=%s err=%v", data, err)
	}
}

// assertRealAnthropicUsage 校验真实 Token 分区存在且不下溢。
func assertRealAnthropicUsage(t *testing.T, usage realAnthropicUsage) {
	t.Helper()

	if usage.InputTokens+
		usage.CacheCreationInputTokens+
		usage.CacheReadInputTokens == 0 ||
		usage.OutputTokens == 0 {
		t.Fatalf("真实 Messages usage 无效: %+v", usage)
	}
}

// decodeRealAnthropicStream 解析带 event 名的 Messages SSE 并重组内容块。
func decodeRealAnthropicStream(
	t *testing.T,
	exchange httpExchange,
) realAnthropicStreamResult {
	t.Helper()

	if !strings.HasPrefix(exchange.header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("真实 Messages SSE Content-Type 错误: %#v", exchange)
	}
	var result realAnthropicStreamResult
	var content strings.Builder
	var arguments strings.Builder
	var eventName string
	for _, line := range strings.Split(
		strings.ReplaceAll(exchange.body, "\r\n", "\n"),
		"\n",
	) {
		switch {
		case strings.HasPrefix(line, "event: "):
			eventName = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			if eventName == "" {
				t.Fatalf("真实 Messages SSE data 缺少 event: %s", line)
			}
			applyRealAnthropicEvent(
				t,
				&result,
				&content,
				&arguments,
				eventName,
				[]byte(strings.TrimPrefix(line, "data: ")),
			)
			eventName = ""
		}
	}
	if eventName != "" {
		t.Fatalf("真实 Messages SSE event 缺少 data: %s", eventName)
	}
	result.content = content.String()
	result.toolArguments = arguments.String()
	return result
}

// applyRealAnthropicEvent 校验单帧类型并累计公开字段。
func applyRealAnthropicEvent(
	t *testing.T,
	result *realAnthropicStreamResult,
	content *strings.Builder,
	arguments *strings.Builder,
	eventName string,
	data []byte,
) {
	t.Helper()

	var event struct {
		Type         string                `json:"type"`
		Message      *realAnthropicMessage `json:"message"`
		Index        *uint32               `json:"index"`
		ContentBlock json.RawMessage       `json:"content_block"`
		Delta        json.RawMessage       `json:"delta"`
		Usage        *realAnthropicUsage   `json:"usage"`
	}
	if err := json.Unmarshal(data, &event); err != nil {
		t.Fatalf("真实 Messages SSE JSON 无效: %v data=%s", err, data)
	}
	if event.Type != eventName {
		t.Fatalf("真实 Messages SSE event/type 漂移: event=%s data=%s", eventName, data)
	}
	result.events = append(result.events, eventName)

	switch eventName {
	case "message_start":
		if event.Message == nil ||
			event.Message.ID == "" ||
			event.Message.Model != realCodexModel ||
			event.Message.Role != "assistant" {
			t.Fatalf("真实 Messages message_start 无效: %s", data)
		}
		result.responseID = event.Message.ID
		result.model = event.Message.Model
		result.role = event.Message.Role
		result.usage = event.Message.Usage
	case "content_block_start":
		applyRealAnthropicBlockStart(t, result, event.Index, event.ContentBlock)
	case "content_block_delta":
		applyRealAnthropicBlockDelta(t, content, arguments, event.Index, event.Delta)
	case "content_block_stop":
		if event.Index == nil || int(*event.Index) >= len(result.blockTypes) {
			t.Fatalf("真实 Messages content_block_stop 索引无效: %s", data)
		}
	case "message_delta":
		var delta struct {
			StopReason   string  `json:"stop_reason"`
			StopSequence *string `json:"stop_sequence"`
		}
		if err := json.Unmarshal(event.Delta, &delta); err != nil ||
			delta.StopReason == "" ||
			delta.StopSequence != nil ||
			event.Usage == nil {
			t.Fatalf("真实 Messages message_delta 无效: %s err=%v", data, err)
		}
		result.stopReason = delta.StopReason
		result.usage = *event.Usage
	case "message_stop":
		result.stopped = true
	default:
		t.Fatalf("真实 Messages SSE 出现未声明事件: %s", eventName)
	}
}

// applyRealAnthropicBlockStart 分配文本或工具内容块。
func applyRealAnthropicBlockStart(
	t *testing.T,
	result *realAnthropicStreamResult,
	index *uint32,
	data json.RawMessage,
) {
	t.Helper()

	if index == nil || int(*index) != len(result.blockTypes) {
		t.Fatalf("真实 Messages 内容块起始索引无效: index=%v", index)
	}
	var header struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &header); err != nil {
		t.Fatalf("真实 Messages 内容块头无效: data=%s err=%v", data, err)
	}
	result.blockTypes = append(result.blockTypes, header.Type)
	switch header.Type {
	case "text":
		return
	case "tool_use":
		var block struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if err := json.Unmarshal(data, &block); err != nil ||
			block.ID == "" ||
			block.Name != realCodexToolName {
			t.Fatalf("真实 Messages 工具起始块无效: data=%s err=%v", data, err)
		}
		result.toolID = block.ID
		result.toolName = block.Name
	default:
		t.Fatalf("真实 Messages 内容块类型无效: %s", header.Type)
	}
}

// applyRealAnthropicBlockDelta 累加文本或工具 JSON 增量。
func applyRealAnthropicBlockDelta(
	t *testing.T,
	content *strings.Builder,
	arguments *strings.Builder,
	index *uint32,
	data json.RawMessage,
) {
	t.Helper()

	if index == nil {
		t.Fatal("真实 Messages 内容块增量缺少索引")
	}
	var delta struct {
		Type        string `json:"type"`
		Text        string `json:"text"`
		PartialJSON string `json:"partial_json"`
	}
	if err := json.Unmarshal(data, &delta); err != nil {
		t.Fatalf("真实 Messages 内容块增量无效: data=%s err=%v", data, err)
	}
	switch delta.Type {
	case "text_delta":
		content.WriteString(delta.Text)
	case "input_json_delta":
		arguments.WriteString(delta.PartialJSON)
	default:
		t.Fatalf("真实 Messages 增量类型无效: %s", delta.Type)
	}
}

// assertRealAnthropicStreamEnvelope 校验 Messages SSE 公共生命周期。
func assertRealAnthropicStreamEnvelope(
	t *testing.T,
	result realAnthropicStreamResult,
	wantStopReason string,
) {
	t.Helper()

	if result.responseID == "" ||
		result.model != realCodexModel ||
		result.role != "assistant" ||
		result.stopReason != wantStopReason ||
		!result.stopped ||
		len(result.events) < 6 ||
		result.events[0] != "message_start" ||
		result.events[len(result.events)-1] != "message_stop" ||
		countRealAnthropicEvent(result.events, "message_delta") != 1 {
		t.Fatalf("真实 Messages SSE envelope 无效: %+v", result)
	}
	assertRealAnthropicUsage(t, result.usage)
}

// assertRealAnthropicStreamText 校验文本 SSE 的内容块与终态。
func assertRealAnthropicStreamText(t *testing.T, result realAnthropicStreamResult) {
	t.Helper()

	assertRealAnthropicStreamEnvelope(t, result, "end_turn")
	if !slices.Equal(result.blockTypes, []string{"text"}) ||
		result.content != realCodexMarker ||
		result.toolID != "" {
		t.Fatalf("真实 Messages 文本 SSE 无效: %+v", result)
	}
}

// assertRealAnthropicStreamTool 校验工具 SSE 可重组为完整调用。
func assertRealAnthropicStreamTool(t *testing.T, result realAnthropicStreamResult) {
	t.Helper()

	assertRealAnthropicStreamEnvelope(t, result, "tool_use")
	if !slices.Equal(result.blockTypes, []string{"tool_use"}) ||
		result.content != "" ||
		result.toolID == "" ||
		result.toolName != realCodexToolName {
		t.Fatalf("真实 Messages 工具 SSE 无效: %+v", result)
	}
	assertRealAnthropicToolInput(t, json.RawMessage(result.toolArguments))
}

// countRealAnthropicEvent 统计稳定生命周期事件的出现次数。
func countRealAnthropicEvent(events []string, target string) int {
	count := 0
	for _, event := range events {
		if event == target {
			count++
		}
	}
	return count
}

// marshalRealAnthropicStreamResult 生成不含上游原始帧的验收日志摘要。
func marshalRealAnthropicStreamResult(
	t *testing.T,
	result realAnthropicStreamResult,
) string {
	t.Helper()

	data, err := json.Marshal(map[string]any{
		"id_present":      result.responseID != "",
		"model":           result.model,
		"role":            result.role,
		"content":         result.content,
		"tool_id_present": result.toolID != "",
		"tool_name":       result.toolName,
		"tool_arguments":  result.toolArguments,
		"stop_reason":     result.stopReason,
		"usage":           result.usage,
		"events":          result.events,
		"block_types":     result.blockTypes,
		"stopped":         result.stopped,
	})
	if err != nil {
		t.Fatalf("编码真实 Messages SSE 摘要失败: %v", err)
	}
	return string(data)
}
