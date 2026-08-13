package aihserver_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
)

// TestRealClaudeResponsesEndToEnd 通过真实 Claude OAuth 账号验收
// Responses→Canonical→Claude Messages→Responses 的文本和工具。
func TestRealClaudeResponsesEndToEnd(t *testing.T) {
	requireRealClaudeHTTP(t)
	budget := newRealClaudeRequestBudget(4)
	fixture := startRealClaudeFixture(t, budget)

	nonStreamText := performRealClaudeResponsesRequest(
		t,
		fixture,
		marshalRealClaudeResponsesTextPayload(t, false),
		false,
	)
	assertRealClaudeResponsesText(t, nonStreamText.body)
	streamText := performRealClaudeResponsesRequest(
		t,
		fixture,
		marshalRealClaudeResponsesTextPayload(t, true),
		true,
	)
	assertRealClaudeResponsesStreamText(t, streamText)

	nonStreamTool := performRealClaudeResponsesRequest(
		t,
		fixture,
		marshalRealClaudeResponsesToolPayload(t, false),
		false,
	)
	assertRealClaudeResponsesTool(t, nonStreamTool.body)
	streamTool := performRealClaudeResponsesRequest(
		t,
		fixture,
		marshalRealClaudeResponsesToolPayload(t, true),
		true,
	)
	assertRealClaudeResponsesStreamTool(t, streamTool)

	assertRealClaudeFixtureState(t, fixture)
	assertRealClaudeRequestCounts(t, budget, realClaudeRequestCounts{
		models:         1,
		messages:       4,
		streamMessages: 4,
		toolMessages:   2,
		lastStatus:     http.StatusOK,
	})
	t.Logf(
		"真实 Claude Responses 验收通过: api=%s text_non_stream=200 text_stream=200 tool_non_stream=200 tool_stream=200 upstream_models=1 upstream_messages=4 source_database_mutations=0",
		fixture.baseURL+"/v1/responses",
	)
}

// TestRealClaudeResponsesReasoningEndToEnd 独立验收 Responses reasoning：
// 高强度自适应 thinking 必须保留可回放的 opaque carrier；公开摘要只在
// 上游真实返回可见 thinking 时出现，不能从 signature 伪造。
func TestRealClaudeResponsesReasoningEndToEnd(t *testing.T) {
	requireRealClaudeHTTP(t)
	budget := newRealClaudeRequestBudget(1)
	fixture := startRealClaudeFixture(t, budget)

	reasoning := performRealClaudeResponsesRequest(
		t,
		fixture,
		marshalRealClaudeResponsesReasoningPayload(t),
		false,
	)
	assertRealClaudeResponsesReasoning(t, reasoning.body)
	assertRealClaudeFixtureState(t, fixture)
	assertRealClaudeRequestCounts(t, budget, realClaudeRequestCounts{
		models:           1,
		messages:         1,
		streamMessages:   1,
		thinkingMessages: 1,
		lastStatus:       http.StatusOK,
	})
	t.Logf(
		"真实 Claude Responses reasoning 验收通过: api=%s reasoning_effort=high reasoning_item=true encrypted_continuity_present=true visible_summary_provider_dependent=true response_status=200 upstream_models=1 upstream_messages=1 source_database_mutations=0",
		fixture.baseURL+"/v1/responses",
	)
}

// TestRealClaudeChatCompletionsEndToEnd 通过真实账号验收 Chat 的文本和工具；
// 客户端 stream 只影响 Renderer，上游固定使用 SSE。
func TestRealClaudeChatCompletionsEndToEnd(t *testing.T) {
	requireRealClaudeHTTP(t)
	budget := newRealClaudeRequestBudget(4)
	fixture := startRealClaudeFixture(t, budget)

	nonStreamText := performRealClaudeChatRequest(
		t,
		fixture,
		marshalRealClaudeChatTextPayload(t, false),
		false,
	)
	assertRealClaudeChatText(t, nonStreamText.body)
	streamText := performRealClaudeChatRequest(
		t,
		fixture,
		marshalRealClaudeChatTextPayload(t, true),
		true,
	)
	assertRealClaudeChatStreamText(t, streamText)

	nonStreamTool := performRealClaudeChatRequest(
		t,
		fixture,
		marshalRealClaudeChatToolPayload(t, false),
		false,
	)
	assertRealClaudeChatTool(t, nonStreamTool.body)
	streamTool := performRealClaudeChatRequest(
		t,
		fixture,
		marshalRealClaudeChatToolPayload(t, true),
		true,
	)
	assertRealClaudeChatStreamTool(t, streamTool)

	assertRealClaudeFixtureState(t, fixture)
	assertRealClaudeRequestCounts(t, budget, realClaudeRequestCounts{
		models:         1,
		messages:       4,
		streamMessages: 4,
		toolMessages:   2,
		lastStatus:     http.StatusOK,
	})
	t.Logf(
		"真实 Claude Chat Completions 验收通过: api=%s text_non_stream=200 text_stream=200 tool_non_stream=200 tool_stream=200 upstream_models=1 upstream_messages=4 source_database_mutations=0",
		fixture.baseURL+"/v1/chat/completions",
	)
}

// TestRealClaudeChatReasoningEndToEnd 验证 reasoning_effort 输入被转成真实
// Claude thinking；Chat 没有 opaque carrier，signature-only 时必须成功省略
// reasoning_content，而不是伪造文本或让整个回答失败。
func TestRealClaudeChatReasoningEndToEnd(t *testing.T) {
	requireRealClaudeHTTP(t)
	budget := newRealClaudeRequestBudget(1)
	fixture := startRealClaudeFixture(t, budget)

	reasoning := performRealClaudeChatRequest(
		t,
		fixture,
		marshalRealClaudeChatReasoningPayload(t),
		false,
	)
	hasVisibleReasoning := assertRealClaudeChatReasoning(t, reasoning.body)
	assertRealClaudeFixtureState(t, fixture)
	assertRealClaudeRequestCounts(t, budget, realClaudeRequestCounts{
		models:           1,
		messages:         1,
		streamMessages:   1,
		thinkingMessages: 1,
		lastStatus:       http.StatusOK,
	})
	t.Logf(
		"真实 Claude Chat reasoning 验收通过: api=%s reasoning_effort=high upstream_thinking=true reasoning_content_present=%t provider_visible_thinking_dependent=true response_status=200 upstream_models=1 upstream_messages=1 source_database_mutations=0",
		fixture.baseURL+"/v1/chat/completions",
		hasVisibleReasoning,
	)
}

// TestRealClaudeAnthropicMessagesEndToEnd 验收同协议 Messages 的文本和工具
// 流式/非流式字节透传，以及 thinking/signature 两轮连续性。
func TestRealClaudeAnthropicMessagesEndToEnd(t *testing.T) {
	requireRealClaudeHTTP(t)
	budget := newRealClaudeRequestBudget(6)
	fixture := startRealClaudeFixture(t, budget)

	nonStreamTextPayload := marshalRealClaudeMessagesTextPayload(t, false)
	nonStreamText := performRealClaudeMessagesRequest(
		t,
		fixture,
		nonStreamTextPayload,
		false,
	)
	assertRealClaudeMessagesText(t, nonStreamText.body)
	streamTextPayload := marshalRealClaudeMessagesTextPayload(t, true)
	streamText := performRealClaudeMessagesRequest(t, fixture, streamTextPayload, true)
	assertRealClaudeMessagesStreamText(t, streamText)

	nonStreamToolPayload := marshalRealClaudeMessagesToolPayload(t, false)
	nonStreamTool := performRealClaudeMessagesRequest(
		t,
		fixture,
		nonStreamToolPayload,
		false,
	)
	assertRealClaudeMessagesTool(t, nonStreamTool.body)
	streamToolPayload := marshalRealClaudeMessagesToolPayload(t, true)
	streamTool := performRealClaudeMessagesRequest(t, fixture, streamToolPayload, true)
	assertRealClaudeMessagesStreamTool(t, streamTool)

	firstPayload := marshalRealClaudeMessagesReasoningPayload(t, false, nil)
	first := performRealClaudeMessagesRequest(t, fixture, firstPayload, false)
	firstContent := assertRealClaudeMessagesReasoning(t, first.body)
	secondPayload := marshalRealClaudeMessagesReasoningPayload(t, false, firstContent)
	second := performRealClaudeMessagesRequest(t, fixture, secondPayload, false)
	assertRealClaudeMessagesContinuity(t, second.body)
	clear(firstContent)
	clear(firstPayload)
	clear(secondPayload)
	assertRealClaudeFixtureState(t, fixture)
	assertRealClaudeRequestCounts(t, budget, realClaudeRequestCounts{
		models:            1,
		messages:          6,
		streamMessages:    2,
		nonStreamMessages: 4,
		toolMessages:      2,
		thinkingMessages:  2,
		lastStatus:        http.StatusOK,
	})
	t.Logf(
		"真实 Claude Anthropic Messages 验收通过: api=%s native_relay=true text_non_stream=200 text_stream=200 tool_non_stream=200 tool_stream=200 thinking_signature_turns=2 continuity_marker=true upstream_models=1 upstream_messages=6 source_database_mutations=0",
		fixture.baseURL+"/v1/messages",
	)
}

// requireRealClaudeHTTP 让真实 HTTP 矩阵默认跳过，避免普通 go test 消耗额度。
func requireRealClaudeHTTP(t *testing.T) {
	t.Helper()
	if strings.TrimSpace(os.Getenv(realClaudeHTTPEnv)) != "1" {
		t.Skip("设置 " + realClaudeHTTPEnv + "=1 后才允许真实 Claude HTTP 请求")
	}
}

// performRealClaudeResponsesRequest 调用公开 Responses 路径。
func performRealClaudeResponsesRequest(
	t *testing.T,
	fixture realClaudeFixture,
	payload []byte,
	stream bool,
) httpExchange {
	t.Helper()
	defer clear(payload)
	exchange := performRequest(t, fixture.client, http.MethodPost,
		fixture.baseURL+"/v1/responses", testClientKey, payload)
	assertRealClaudeClientExchange(t, exchange, stream, fixture.budget)
	return exchange
}

// performRealClaudeChatRequest 调用公开 Chat Completions 路径。
func performRealClaudeChatRequest(
	t *testing.T,
	fixture realClaudeFixture,
	payload []byte,
	stream bool,
) httpExchange {
	t.Helper()
	defer clear(payload)
	exchange := performRequest(t, fixture.client, http.MethodPost,
		fixture.baseURL+"/v1/chat/completions", testClientKey, payload)
	assertRealClaudeClientExchange(t, exchange, stream, fixture.budget)
	return exchange
}

// performRealClaudeMessagesRequest 调用公开 Messages 路径；普通客户端无需伪造
// Claude Code Session Header，Server 会按同协议透传合同补齐官方身份。
func performRealClaudeMessagesRequest(
	t *testing.T,
	fixture realClaudeFixture,
	payload []byte,
	stream bool,
) httpExchange {
	t.Helper()
	accept := "application/json"
	if stream {
		accept = "text/event-stream"
	}
	exchange := performRequestWithHeaders(t, fixture.client, http.MethodPost,
		fixture.baseURL+"/v1/messages", map[string]string{
			"x-api-key":         testClientKey,
			"anthropic-version": "2023-06-01",
			"Accept":            accept,
		}, payload)
	assertRealClaudeClientExchange(t, exchange, stream, fixture.budget)
	return exchange
}

// assertRealClaudeClientExchange 校验客户端所选 JSON 或 SSE 合同。
func assertRealClaudeClientExchange(
	t *testing.T,
	exchange httpExchange,
	stream bool,
	budget *realClaudeRequestBudget,
) {
	t.Helper()
	if exchange.status != http.StatusOK {
		t.Fatalf(
			"真实 Claude HTTP 失败: status=%d response_code=%s budget=%+v stream=%+v rejection=%s",
			exchange.status,
			safeErrorCode(exchange.body),
			budget.snapshot(),
			budget.streamObservation(),
			budget.rejection(),
		)
	}
	if stream {
		assertRealCodexStreamStatus(t, exchange)
		return
	}
	assertRealJSONStatus(t, exchange)
}

// marshalRealClaudeResponsesTextPayload 创建 Responses 文本请求。
func marshalRealClaudeResponsesTextPayload(t *testing.T, stream bool) []byte {
	t.Helper()
	return marshalRealClaudePayload(t, map[string]any{
		"model":        realClaudeTransferModel,
		"instructions": "Return only the exact marker requested by the user.",
		"input":        "Reply with exactly: " + realClaudeTransferMarker,
		"stream":       stream,
	})
}

// marshalRealClaudeResponsesToolPayload 强制 Responses 返回唯一函数调用。
func marshalRealClaudeResponsesToolPayload(t *testing.T, stream bool) []byte {
	t.Helper()
	return marshalRealClaudePayload(t, map[string]any{
		"model": realClaudeTransferModel,
		"input": realClaudeToolMarker +
			". Call get_weather exactly once with city Shenzhen. Do not answer in text.",
		"tools": []map[string]any{{
			"type": "function", "name": realClaudeToolName,
			"description": "Return weather for a city.",
			"parameters": map[string]any{
				"type": "object", "properties": map[string]any{
					"city": map[string]any{"type": "string", "enum": []string{"Shenzhen"}},
				}, "required": []string{"city"}, "additionalProperties": false,
			},
		}},
		"tool_choice": map[string]string{"type": "function", "name": realClaudeToolName},
		"stream":      stream,
	})
}

// marshalRealClaudeResponsesReasoningPayload 请求 Claude 可见 thinking，并在
// Responses 输出中验证其作为 reasoning summary 的公开投影。
func marshalRealClaudeResponsesReasoningPayload(t *testing.T) []byte {
	t.Helper()
	return marshalRealClaudePayloadForModel(t, realClaudeReasoningModel, map[string]any{
		"model": realClaudeReasoningModel,
		"input": "Compute the sum of integers from 1 through 500 that are divisible by 7 or 11 but not both. Verify the calculation, then reply with exactly: " + realClaudeReasoningMarker,
		"reasoning": map[string]string{
			"effort": "high", "summary": "auto",
		},
		"include": []string{"reasoning.encrypted_content"},
		"stream":  false,
	})
}

// marshalRealClaudeChatTextPayload 创建 Chat 文本请求。
func marshalRealClaudeChatTextPayload(t *testing.T, stream bool) []byte {
	t.Helper()
	payload := map[string]any{
		"model": realClaudeTransferModel,
		"messages": []map[string]string{
			{"role": "developer", "content": "Return only the exact marker requested by the user."},
			{"role": "user", "content": "Reply with exactly: " + realClaudeTransferMarker},
		},
		"stream": stream,
	}
	if stream {
		payload["stream_options"] = map[string]bool{"include_usage": true}
	}
	return marshalRealClaudePayload(t, payload)
}

// marshalRealClaudeChatToolPayload 强制 Chat 返回唯一函数调用。
func marshalRealClaudeChatToolPayload(t *testing.T, stream bool) []byte {
	t.Helper()
	payload := map[string]any{
		"model": realClaudeTransferModel,
		"messages": []map[string]string{{
			"role": "user", "content": realClaudeToolMarker +
				". Call get_weather exactly once with city Shenzhen. Do not answer in text.",
		}},
		"tools": []map[string]any{{
			"type": "function", "function": map[string]any{
				"name": realClaudeToolName, "description": "Return weather for a city.",
				"parameters": map[string]any{
					"type": "object", "properties": map[string]any{
						"city": map[string]any{"type": "string", "enum": []string{"Shenzhen"}},
					}, "required": []string{"city"}, "additionalProperties": false,
				},
			},
		}},
		"tool_choice": map[string]any{
			"type": "function", "function": map[string]string{"name": realClaudeToolName},
		},
		"parallel_tool_calls": false,
		"stream":              stream,
	}
	if stream {
		payload["stream_options"] = map[string]bool{"include_usage": true}
	}
	return marshalRealClaudePayload(t, payload)
}

// marshalRealClaudeChatReasoningPayload 验证 reasoning_effort 与
// reasoning_content 的双向映射。
func marshalRealClaudeChatReasoningPayload(t *testing.T) []byte {
	t.Helper()
	return marshalRealClaudePayloadForModel(t, realClaudeReasoningModel, map[string]any{
		"model": realClaudeReasoningModel,
		"messages": []map[string]string{{
			"role": "user", "content": "Compute the sum of integers from 1 through 500 that are divisible by 7 or 11 but not both. Verify the calculation, then include this exact marker in the final answer: " + realClaudeReasoningMarker,
		}},
		"reasoning_effort": "high",
		"stream":           false,
	})
}

// marshalRealClaudeMessagesTextPayload 创建原生 Messages 文本请求。
func marshalRealClaudeMessagesTextPayload(t *testing.T, stream bool) []byte {
	t.Helper()
	return marshalRealClaudePayload(t, map[string]any{
		"model":      realClaudeTransferModel,
		"max_tokens": realAnthropicMaxTokens,
		"system":     "Return only the exact marker requested by the user.",
		"messages": []map[string]string{{
			"role": "user", "content": "Reply with exactly: " + realClaudeTransferMarker,
		}},
		"stream": stream,
	})
}

// marshalRealClaudeMessagesToolPayload 创建原生 Messages 工具请求。
func marshalRealClaudeMessagesToolPayload(t *testing.T, stream bool) []byte {
	t.Helper()
	return marshalRealClaudePayload(t, map[string]any{
		"model":      realClaudeTransferModel,
		"max_tokens": realAnthropicMaxTokens,
		"messages": []map[string]string{{
			"role": "user", "content": realClaudeToolMarker +
				". Call get_weather exactly once with city Shenzhen. Do not answer in text.",
		}},
		"tools": []map[string]any{{
			"name": realClaudeToolName, "description": "Return weather for a city.",
			"input_schema": map[string]any{
				"type": "object", "properties": map[string]any{
					"city": map[string]any{"type": "string", "enum": []string{"Shenzhen"}},
				}, "required": []string{"city"}, "additionalProperties": false,
			},
		}},
		"tool_choice": map[string]any{
			"type": "tool", "name": realClaudeToolName, "disable_parallel_tool_use": true,
		},
		"stream": stream,
	})
}

// marshalRealClaudeMessagesReasoningPayload 创建首轮或连续性回放请求。
func marshalRealClaudeMessagesReasoningPayload(
	t *testing.T,
	stream bool,
	assistantContent json.RawMessage,
) []byte {
	t.Helper()
	messages := make([]any, 0, 2)
	if len(assistantContent) > 0 {
		messages = append(messages, map[string]any{
			"role": "assistant", "content": assistantContent,
		})
		messages = append(messages, map[string]string{
			"role": "user", "content": "Reply with exactly: " + realClaudeContinuityMarker,
		})
	} else {
		messages = append(messages, map[string]string{
			"role": "user", "content": "Compute the sum of integers from 1 through 500 that are divisible by 7 or 11 but not both. Verify the calculation, then include this exact marker in the final answer: " + realClaudeReasoningMarker,
		})
	}
	return marshalRealClaudePayloadForModel(t, realClaudeReasoningModel, map[string]any{
		"model":      realClaudeReasoningModel,
		"max_tokens": realAnthropicMaxTokens,
		"messages":   messages,
		"thinking":   map[string]string{"type": "adaptive"},
		"output_config": map[string]string{
			"effort": "high",
		},
		"stream": stream,
	})
}

// assertRealClaudeResponsesText 校验非流式 Responses 文本。
func assertRealClaudeResponsesText(t *testing.T, body string) {
	t.Helper()
	var document struct {
		Object string            `json:"object"`
		Status string            `json:"status"`
		Model  string            `json:"model"`
		Output []json.RawMessage `json:"output"`
		Usage  json.RawMessage   `json:"usage"`
	}
	decodeRealJSON(t, body, &document)
	if document.Object != "response" || document.Status != "completed" ||
		document.Model != realClaudeTransferModel || len(document.Usage) == 0 ||
		responsesVisibleText(document.Output) != realClaudeTransferMarker {
		t.Fatalf(
			"真实 Claude Responses 文本无效: object=%q status=%q model=%q output_types=%v usage=%t",
			document.Object,
			document.Status,
			document.Model,
			safeRealRawContentTypes(document.Output),
			len(document.Usage) > 0,
		)
	}
}

// assertRealClaudeResponsesStreamText 校验 Responses SSE 终态主结果。
func assertRealClaudeResponsesStreamText(t *testing.T, exchange httpExchange) {
	t.Helper()
	terminal := realClaudeResponsesTerminal(t, exchange)
	assertRealClaudeResponsesText(t, string(terminal))
}

// assertRealClaudeResponsesTool 校验完整函数调用。
func assertRealClaudeResponsesTool(t *testing.T, body string) {
	t.Helper()
	var document struct {
		Status string            `json:"status"`
		Model  string            `json:"model"`
		Output []json.RawMessage `json:"output"`
	}
	decodeRealJSON(t, body, &document)
	if document.Status != "completed" || document.Model != realClaudeTransferModel {
		t.Fatalf(
			"真实 Claude Responses 工具 envelope 无效: status=%q model=%q output_types=%v",
			document.Status,
			document.Model,
			safeRealRawContentTypes(document.Output),
		)
	}
	for _, item := range document.Output {
		var call struct {
			Type      string `json:"type"`
			Status    string `json:"status"`
			CallID    string `json:"call_id"`
			Name      string `json:"name"`
			Arguments string `json:"arguments"`
		}
		if json.Unmarshal(item, &call) == nil && call.Type == "function_call" {
			assertRealClaudeToolCall(t, call.Status, call.CallID, call.Name, call.Arguments)
			return
		}
	}
	t.Fatal("真实 Claude Responses 缺少 function_call")
}

// assertRealClaudeResponsesStreamTool 校验 SSE 终态工具项。
func assertRealClaudeResponsesStreamTool(t *testing.T, exchange httpExchange) {
	t.Helper()
	assertRealClaudeResponsesTool(t, string(realClaudeResponsesTerminal(t, exchange)))
}

// assertRealClaudeResponsesReasoning 校验 reasoning item、可见 summary 和主结果。
func assertRealClaudeResponsesReasoning(t *testing.T, body string) {
	t.Helper()
	var document struct {
		Status string            `json:"status"`
		Model  string            `json:"model"`
		Output []json.RawMessage `json:"output"`
	}
	decodeRealJSON(t, body, &document)
	hasReasoningItem := false
	hasVisibleSummary := false
	hasContinuity := false
	for _, item := range document.Output {
		var value struct {
			Type             string `json:"type"`
			EncryptedContent string `json:"encrypted_content"`
			Summary          []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"summary"`
		}
		if json.Unmarshal(item, &value) != nil || value.Type != "reasoning" {
			continue
		}
		hasReasoningItem = true
		hasContinuity = hasContinuity || value.EncryptedContent != ""
		for _, summary := range value.Summary {
			if summary.Type == "summary_text" && summary.Text != "" {
				hasVisibleSummary = true
			}
		}
	}
	visibleText := responsesVisibleText(document.Output)
	if document.Status != "completed" || document.Model != realClaudeReasoningModel ||
		!hasReasoningItem || !hasContinuity ||
		!strings.Contains(visibleText, realClaudeReasoningMarker) {
		t.Fatalf(
			"真实 Claude Responses reasoning 无效: status=%q model=%q item=%t summary=%t continuity=%t",
			document.Status,
			document.Model,
			hasReasoningItem,
			hasVisibleSummary,
			hasContinuity,
		)
	}
}

// realClaudeResponsesTerminal 提取唯一 response.completed 终态。
func realClaudeResponsesTerminal(t *testing.T, exchange httpExchange) json.RawMessage {
	t.Helper()
	frames := decodeRealResponsesSSE(t, exchange.body)
	var terminal json.RawMessage
	for _, frame := range frames {
		if frame.event != "response.completed" {
			continue
		}
		var envelope struct {
			Response json.RawMessage `json:"response"`
		}
		if json.Unmarshal(frame.data, &envelope) != nil || len(envelope.Response) == 0 || len(terminal) > 0 {
			t.Fatalf(
				"真实 Claude Responses SSE 终态无效: data=%s response_present=%t duplicate=%t",
				safeRealSSEDataDiagnostic(frame.data),
				len(envelope.Response) > 0,
				len(terminal) > 0,
			)
		}
		terminal = append(json.RawMessage(nil), envelope.Response...)
	}
	if len(terminal) == 0 {
		t.Fatal("真实 Claude Responses SSE 缺少 completed")
	}
	return terminal
}

// responsesVisibleText 提取 Responses Assistant output_text。
func responsesVisibleText(output []json.RawMessage) string {
	var text strings.Builder
	for _, item := range output {
		var message struct {
			Type    string `json:"type"`
			Role    string `json:"role"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		}
		if json.Unmarshal(item, &message) != nil || message.Type != "message" || message.Role != "assistant" {
			continue
		}
		for _, content := range message.Content {
			if content.Type == "output_text" {
				text.WriteString(content.Text)
			}
		}
	}
	return strings.TrimSpace(text.String())
}

// assertRealClaudeChatText 校验非流式 Chat 文本。
func assertRealClaudeChatText(t *testing.T, body string) {
	t.Helper()
	document := decodeRealChatCompletion(t, body)
	choice := assertRealClaudeChatEnvelope(t, document)
	if choice.Message.Content == nil || strings.TrimSpace(*choice.Message.Content) != realClaudeTransferMarker ||
		len(choice.Message.ToolCalls) != 0 || choice.FinishReason != "stop" {
		t.Fatalf("真实 Claude Chat 文本无效: %s", safeRealChatChoiceDiagnostic(choice))
	}
}

// assertRealClaudeChatStreamText 校验 Chat SSE 文本和 usage。
func assertRealClaudeChatStreamText(t *testing.T, exchange httpExchange) {
	t.Helper()
	result := decodeRealChatStreamForModel(t, exchange, realClaudeTransferModel)
	if result.model != realClaudeTransferModel || result.role != "assistant" ||
		strings.TrimSpace(result.content) != realClaudeTransferMarker || result.toolID != "" ||
		result.finishReason != "stop" || !result.done || result.chunks < 3 {
		t.Fatalf("真实 Claude Chat 文本 SSE 无效: %s", safeRealChatStreamDiagnostic(result))
	}
	assertRealChatUsage(t, result.usage)
}

// assertRealClaudeChatTool 校验非流式 Chat 工具。
func assertRealClaudeChatTool(t *testing.T, body string) {
	t.Helper()
	document := decodeRealChatCompletion(t, body)
	choice := assertRealClaudeChatEnvelope(t, document)
	if choice.Message.Content != nil || choice.FinishReason != "tool_calls" ||
		len(choice.Message.ToolCalls) != 1 {
		t.Fatalf("真实 Claude Chat 工具无效: %s", safeRealChatChoiceDiagnostic(choice))
	}
	call := choice.Message.ToolCalls[0]
	assertRealClaudeToolCall(t, "completed", call.ID, call.Function.Name, call.Function.Arguments)
}

// assertRealClaudeChatStreamTool 校验 Chat SSE 工具增量。
func assertRealClaudeChatStreamTool(t *testing.T, exchange httpExchange) {
	t.Helper()
	result := decodeRealChatStreamForModel(t, exchange, realClaudeTransferModel)
	if result.model != realClaudeTransferModel || result.role != "assistant" ||
		result.content != "" || result.finishReason != "tool_calls" || !result.done {
		t.Fatalf("真实 Claude Chat 工具 SSE 无效: %s", safeRealChatStreamDiagnostic(result))
	}
	assertRealClaudeToolCall(t, "completed", result.toolID, result.toolName, result.toolArguments)
	assertRealChatUsage(t, result.usage)
}

// assertRealClaudeChatReasoning 校验 Chat reasoning 输入后的最终文本，并返回
// Provider 是否提供了 Chat 可表达的可见 thinking。
func assertRealClaudeChatReasoning(t *testing.T, body string) bool {
	t.Helper()
	var document struct {
		Model   string `json:"model"`
		Choices []struct {
			FinishReason string `json:"finish_reason"`
			Message      struct {
				Content          *string `json:"content"`
				ReasoningContent string  `json:"reasoning_content"`
			} `json:"message"`
		} `json:"choices"`
		Usage json.RawMessage `json:"usage"`
	}
	decodeRealJSON(t, body, &document)
	if document.Model != realClaudeReasoningModel || len(document.Choices) != 1 ||
		document.Choices[0].Message.Content == nil ||
		!strings.Contains(
			strings.TrimSpace(*document.Choices[0].Message.Content),
			realClaudeReasoningMarker,
		) ||
		document.Choices[0].FinishReason != "stop" || len(document.Usage) == 0 {
		choiceShape := "none"
		if len(document.Choices) > 0 {
			choiceShape = fmt.Sprintf(
				"{content:%t,reasoning_bytes:%d,finish_reason:%q}",
				document.Choices[0].Message.Content != nil,
				len(document.Choices[0].Message.ReasoningContent),
				document.Choices[0].FinishReason,
			)
		}
		t.Fatalf(
			"真实 Claude Chat reasoning 无效: model=%q choices=%d choice=%s usage=%t",
			document.Model,
			len(document.Choices),
			choiceShape,
			len(document.Usage) > 0,
		)
	}
	return document.Choices[0].Message.ReasoningContent != ""
}

// assertRealClaudeChatEnvelope 校验 Chat 公共字段，模型使用 Claude 实际 ID。
func assertRealClaudeChatEnvelope(t *testing.T, document realChatCompletion) realChatChoice {
	t.Helper()
	if document.ID == "" || document.Object != "chat.completion" || document.Created <= 0 ||
		document.Model != realClaudeTransferModel || len(document.Choices) != 1 ||
		document.Choices[0].Index != 0 || document.Choices[0].Message.Role != "assistant" {
		t.Fatalf("真实 Claude Chat envelope 无效: %s", safeRealChatCompletionDiagnostic(document))
	}
	assertRealChatUsage(t, document.Usage)
	return document.Choices[0]
}

// assertRealClaudeMessagesText 校验非流式原生文本响应。
func assertRealClaudeMessagesText(t *testing.T, body string) {
	t.Helper()
	message := decodeRealClaudeMessage(t, body)
	if message.StopReason != "end_turn" || message.Model != realClaudeTransferModel ||
		claudeMessageVisibleText(message.Content) != realClaudeTransferMarker {
		t.Fatalf("真实 Claude Messages 文本无效: %s", safeRealClaudeMessageDiagnostic(message))
	}
}

// assertRealClaudeMessagesStreamText 校验 Native SSE 文本。
func assertRealClaudeMessagesStreamText(t *testing.T, exchange httpExchange) {
	t.Helper()
	result := decodeRealAnthropicStreamForModel(t, exchange, realClaudeTransferModel)
	if result.model != realClaudeTransferModel || result.role != "assistant" ||
		strings.TrimSpace(result.content) != realClaudeTransferMarker || result.stopReason != "end_turn" ||
		!result.stopped || !realClaudeBlockTypesEndWith(result.blockTypes, "text") {
		t.Fatalf("真实 Claude Messages 文本 SSE 无效: %s", safeRealAnthropicStreamDiagnostic(result))
	}
	assertRealAnthropicUsage(t, result.usage)
}

// assertRealClaudeMessagesTool 校验非流式原生工具调用。
func assertRealClaudeMessagesTool(t *testing.T, body string) {
	t.Helper()
	message := decodeRealClaudeMessage(t, body)
	if message.StopReason != "tool_use" || message.Model != realClaudeTransferModel ||
		len(message.Content) != 1 {
		t.Fatalf("真实 Claude Messages 工具 envelope 无效: %s", safeRealClaudeMessageDiagnostic(message))
	}
	var call struct {
		Type  string          `json:"type"`
		ID    string          `json:"id"`
		Name  string          `json:"name"`
		Input json.RawMessage `json:"input"`
	}
	if json.Unmarshal(message.Content[0], &call) != nil || call.Type != "tool_use" {
		t.Fatalf("真实 Claude Messages 工具块无效: types=%v", safeRealRawContentTypes(message.Content))
	}
	assertRealClaudeToolCall(t, "completed", call.ID, call.Name, string(call.Input))
}

// assertRealClaudeMessagesStreamTool 校验原生 SSE 工具调用。
func assertRealClaudeMessagesStreamTool(t *testing.T, exchange httpExchange) {
	t.Helper()
	result := decodeRealAnthropicStreamForModel(t, exchange, realClaudeTransferModel)
	if result.model != realClaudeTransferModel || result.role != "assistant" ||
		result.content != "" || result.stopReason != "tool_use" || !result.stopped ||
		!realClaudeBlockTypesEndWith(result.blockTypes, "tool_use") {
		t.Fatalf("真实 Claude Messages 工具 SSE 无效: %s", safeRealAnthropicStreamDiagnostic(result))
	}
	assertRealClaudeToolCall(t, "completed", result.toolID, result.toolName, result.toolArguments)
	assertRealAnthropicUsage(t, result.usage)
}

// realClaudeBlockTypesEndWith 允许 Claude 5 在业务结果块前返回原生 reasoning，
// 但拒绝未知或错序的内容块。
func realClaudeBlockTypesEndWith(types []string, terminal string) bool {
	if len(types) == 0 || types[len(types)-1] != terminal {
		return false
	}
	for _, blockType := range types[:len(types)-1] {
		if blockType != "thinking" && blockType != "redacted_thinking" {
			return false
		}
	}
	return true
}

// assertRealClaudeMessagesReasoning 校验原生 signature 并返回原始内容块回放。
// Claude 当前可能返回空 thinking + 非空 signature；原生协议必须保留该合法形态。
func assertRealClaudeMessagesReasoning(t *testing.T, body string) json.RawMessage {
	t.Helper()
	message := decodeRealClaudeMessageForModel(t, body, realClaudeReasoningModel)
	hasThinking := false
	hasSignature := false
	for _, block := range message.Content {
		var value struct {
			Type      string `json:"type"`
			Thinking  string `json:"thinking"`
			Signature string `json:"signature"`
		}
		if json.Unmarshal(block, &value) == nil && value.Type == "thinking" {
			hasThinking = value.Thinking != ""
			hasSignature = value.Signature != ""
		}
	}
	if message.StopReason != "end_turn" || !hasSignature ||
		!strings.Contains(
			claudeMessageVisibleText(message.Content),
			realClaudeReasoningMarker,
		) {
		t.Fatalf(
			"真实 Claude Messages reasoning 无效: model=%q stop=%q thinking=%t signature=%t",
			message.Model,
			message.StopReason,
			hasThinking,
			hasSignature,
		)
	}
	encoded, err := json.Marshal(message.Content)
	if err != nil {
		t.Fatalf("编码 Claude thinking 回放内容失败: %v", err)
	}
	return encoded
}

// assertRealClaudeMessagesContinuity 校验签名历史被上游接受并完成第二轮。
func assertRealClaudeMessagesContinuity(t *testing.T, body string) {
	t.Helper()
	message := decodeRealClaudeMessageForModel(t, body, realClaudeReasoningModel)
	if message.StopReason != "end_turn" ||
		claudeMessageVisibleText(message.Content) != realClaudeContinuityMarker {
		t.Fatalf(
			"真实 Claude Messages 连续性无效: model=%q stop=%q marker_present=%t content_types=%v",
			message.Model,
			message.StopReason,
			claudeMessageVisibleText(message.Content) == realClaudeContinuityMarker,
			safeRealRawContentTypes(message.Content),
		)
	}
}

// realClaudeMessage 是原生非流式 Message 的最小验收合同。
type realClaudeMessage struct {
	ID         string            `json:"id"`
	Type       string            `json:"type"`
	Role       string            `json:"role"`
	Model      string            `json:"model"`
	Content    []json.RawMessage `json:"content"`
	StopReason string            `json:"stop_reason"`
	Usage      json.RawMessage   `json:"usage"`
}

// decodeRealClaudeMessage 解码原生 Message 并校验公共 envelope。
func decodeRealClaudeMessage(t *testing.T, body string) realClaudeMessage {
	return decodeRealClaudeMessageForModel(t, body, realClaudeTransferModel)
}

// decodeRealClaudeMessageForModel 解码原生 Message 并校验显式真实模型。
func decodeRealClaudeMessageForModel(
	t *testing.T,
	body string,
	expectedModel string,
) realClaudeMessage {
	t.Helper()
	var message realClaudeMessage
	decodeRealJSON(t, body, &message)
	if message.ID == "" || message.Type != "message" || message.Role != "assistant" ||
		message.Model != expectedModel || len(message.Content) == 0 || len(message.Usage) == 0 {
		t.Fatalf("真实 Claude Message envelope 无效: %s", safeRealClaudeMessageDiagnostic(message))
	}
	return message
}

// claudeMessageVisibleText 提取原生 text 内容块。
func claudeMessageVisibleText(content []json.RawMessage) string {
	var text strings.Builder
	for _, block := range content {
		var value struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(block, &value) == nil && value.Type == "text" {
			text.WriteString(value.Text)
		}
	}
	return strings.TrimSpace(text.String())
}

// assertRealClaudeToolCall 校验三种客户端协议恢复出的同一个工具合同。
func assertRealClaudeToolCall(
	t *testing.T,
	status string,
	callID string,
	name string,
	arguments string,
) {
	t.Helper()
	var input struct {
		City string `json:"city"`
	}
	if status != "completed" || callID == "" || name != realClaudeToolName ||
		json.Unmarshal([]byte(arguments), &input) != nil || input.City != "Shenzhen" {
		t.Fatalf(
			"真实 Claude 工具调用无效: status=%q id=%t name=%q arguments_bytes=%d city_match=%t",
			status,
			callID != "",
			name,
			len(arguments),
			input.City == "Shenzhen",
		)
	}
}

// assertRealClaudeFixtureState 校验一次性数据库存在，不触碰源隔离库。
func assertRealClaudeFixtureState(t *testing.T, fixture realClaudeFixture) {
	t.Helper()
	if fixture.accountRef == "" || fixture.importStatus != http.StatusCreated ||
		fixture.modelsStatus != http.StatusOK || fixture.modelCount == 0 {
		t.Fatalf(
			"真实 Claude fixture 状态无效: account_ref=%t import=%d models_status=%d models=%d database_path=<redacted>",
			fixture.accountRef != "",
			fixture.importStatus,
			fixture.modelsStatus,
			fixture.modelCount,
		)
	}
	if info, err := os.Stat(fixture.databasePath()); err != nil || info.IsDir() {
		t.Fatalf("Claude 临时 aih.db 未创建: %v", err)
	}
}

// assertRealClaudeRequestCounts 校验真实请求次数、能力形状和最终上游状态。
func assertRealClaudeRequestCounts(
	t *testing.T,
	budget *realClaudeRequestBudget,
	want realClaudeRequestCounts,
) {
	t.Helper()
	if got := budget.snapshot(); got != want {
		t.Fatalf("真实 Claude 请求预算错误: got=%+v want=%+v rejection=%s", got, want, budget.rejection())
	}
}
