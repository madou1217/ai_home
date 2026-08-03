package openaichatcompletionsapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/openaichatcompletions"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/openairesponses"
)

const testBearerToken = "synthetic-chat-api-key"

// TestHandlerServesNonStreamCompletionOverRealHTTP 验证真实 TCP 请求、Canonical
// 输入和完整 Chat Completion JSON。
func TestHandlerServesNonStreamCompletionOverRealHTTP(t *testing.T) {
	t.Parallel()

	executor := newScriptedExecutor(completeChatEvents(t), nil)
	baseURL, client := startChatServer(t, executor, 0)
	payload := []byte(`{
		"model":"gpt-5.6-sol",
		"messages":[{"role":"user","content":"查询深圳天气"}],
		"stream":false
	}`)
	response := performChatRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testBearerToken,
		"application/json",
		payload,
	)

	if response.status != http.StatusOK ||
		response.header.Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("response = %#v", response)
	}
	var result struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		Created int64  `json:"created"`
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Role             string `json:"role"`
				Content          string `json:"content"`
				ReasoningContent string `json:"reasoning_content"`
				ToolCalls        []struct {
					ID       string `json:"id"`
					Type     string `json:"type"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     uint64 `json:"prompt_tokens"`
			CompletionTokens uint64 `json:"completion_tokens"`
			TotalTokens      uint64 `json:"total_tokens"`
		} `json:"usage"`
	}
	decodeResponseJSON(t, response.body, &result)
	if result.ID != "resp_chat_http_1" ||
		result.Object != "chat.completion" ||
		result.Created != 1_785_110_400 ||
		result.Model != "gpt-5.6-sol" ||
		len(result.Choices) != 1 ||
		result.Choices[0].Message.Role != "assistant" ||
		result.Choices[0].Message.Content != "最终回复" ||
		result.Choices[0].Message.ReasoningContent != "先分析" ||
		result.Choices[0].FinishReason != "tool_calls" ||
		len(result.Choices[0].Message.ToolCalls) != 1 ||
		result.Choices[0].Message.ToolCalls[0].ID != "call_weather" ||
		result.Choices[0].Message.ToolCalls[0].Type != "function" ||
		result.Choices[0].Message.ToolCalls[0].Function.Name != "weather" ||
		result.Choices[0].Message.ToolCalls[0].Function.Arguments !=
			`{"city":"深圳"}` ||
		result.Usage.PromptTokens != 12 ||
		result.Usage.CompletionTokens != 7 ||
		result.Usage.TotalTokens != 19 {
		t.Fatalf("Chat Completion result = %#v", result)
	}
	canonicalRequest := executor.LastRequest()
	if canonicalRequest.ClientProtocol() !=
		inference.ClientProtocolOpenAIChatCompletions ||
		canonicalRequest.Stream() ||
		canonicalRequest.Model() != "gpt-5.6-sol" ||
		len(canonicalRequest.Messages()) != 1 ||
		canonicalRequest.Messages()[0].Role() != inference.RoleUser {
		t.Fatalf("canonical request = %#v", canonicalRequest)
	}
	t.Logf(
		"真实 HTTP smoke: POST %s%s payload=%s response=%s",
		baseURL,
		Path,
		payload,
		response.body,
	)
}

// TestHandlerPropagatesAndValidatesPinnedAccountHeader 验证 Chat 入站保留固定账号约束。
func TestHandlerPropagatesAndValidatesPinnedAccountHeader(t *testing.T) {
	t.Parallel()

	payload := `{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"pin"}],"stream":false}`
	t.Run("valid", func(t *testing.T) {
		executor := newScriptedExecutor(completeChatEvents(t), nil)
		baseURL, client := startChatServer(t, executor, 0)
		request, err := http.NewRequest(http.MethodPost, baseURL+Path, strings.NewReader(payload))
		if err != nil {
			t.Fatalf("http.NewRequest() error = %v", err)
		}
		request.Header.Set("Authorization", "Bearer "+testBearerToken)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Account-Ref", "acct_0123456789abcdef0123")
		response, err := client.Do(request)
		if err != nil {
			t.Fatalf("client.Do() error = %v", err)
		}
		defer func() { _ = response.Body.Close() }()
		if response.StatusCode != http.StatusOK || executor.LastPinnedAccount() != "acct_0123456789abcdef0123" {
			t.Fatalf("status=%d pinned=%q", response.StatusCode, executor.LastPinnedAccount())
		}
	})

	t.Run("invalid", func(t *testing.T) {
		executor := newScriptedExecutor(completeChatEvents(t), nil)
		baseURL, client := startChatServer(t, executor, 0)
		request, err := http.NewRequest(http.MethodPost, baseURL+Path, strings.NewReader(payload))
		if err != nil {
			t.Fatalf("http.NewRequest() error = %v", err)
		}
		request.Header.Set("Authorization", "Bearer "+testBearerToken)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Add("X-Account-Ref", "acct_0123456789abcdef0123")
		request.Header.Add("X-Account-Ref", "acct_1234567890abcdef1234")
		response, err := client.Do(request)
		if err != nil {
			t.Fatalf("client.Do() error = %v", err)
		}
		defer func() { _ = response.Body.Close() }()
		if response.StatusCode != http.StatusBadRequest || executor.CallCount() != 0 {
			t.Fatalf("status=%d executorCalls=%d", response.StatusCode, executor.CallCount())
		}
	})
}

// TestHandlerStreamsDataOnlyChatLifecycleOverRealHTTP 验证真实 TCP SSE 不写
// event 字段，并按 role、reasoning、content、tool、finish、usage、DONE 输出。
func TestHandlerStreamsDataOnlyChatLifecycleOverRealHTTP(t *testing.T) {
	t.Parallel()

	executor := newScriptedExecutor(completeChatEvents(t), nil)
	baseURL, client := startChatServer(t, executor, 0)
	payload := []byte(`{
		"model":"gpt-5.6-sol",
		"messages":[{"role":"user","content":"查询深圳天气"}],
		"stream":true,
		"stream_options":{"include_usage":true}
	}`)
	response := performChatRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testBearerToken,
		"application/json",
		payload,
	)

	if response.status != http.StatusOK ||
		response.header.Get("Content-Type") != "text/event-stream" ||
		response.header.Get("X-Accel-Buffering") != "no" ||
		strings.Contains(response.body, "event:") {
		t.Fatalf("stream response = %#v", response)
	}
	frames := parseSSEData(response.body)
	if len(frames) != 8 {
		t.Fatalf("SSE frame 数量 = %d, want 8\nbody=%s", len(frames), response.body)
	}
	expectFrameContains(t, frames[0], `"role":"assistant"`)
	expectFrameContains(t, frames[1], `"reasoning_content":"先分析"`)
	expectFrameContains(t, frames[2], `"content":"最终回复"`)
	expectFrameContains(
		t,
		frames[3],
		`"id":"call_weather"`,
		`"name":"weather"`,
		`"arguments":""`,
	)
	expectFrameContains(t, frames[4], `"arguments":"{\"city\":\"深圳\"}"`)
	expectFrameContains(t, frames[5], `"finish_reason":"tool_calls"`)
	expectFrameContains(
		t,
		frames[6],
		`"choices":[]`,
		`"prompt_tokens":12`,
		`"total_tokens":19`,
	)
	if frames[7] != "[DONE]" {
		t.Fatalf("final frame = %q, want [DONE]", frames[7])
	}
	canonicalRequest := executor.LastRequest()
	if !canonicalRequest.Stream() || !canonicalRequest.IncludeUsageInStream() {
		t.Fatalf("canonical stream options = %#v", canonicalRequest)
	}
	t.Logf(
		"真实 SSE smoke: POST %s%s payload=%s response=%s",
		baseURL,
		Path,
		payload,
		response.body,
	)
}

// TestHandlerReturnsCanonicalFailureForNonStreamRequest 验证 Canonical 限流
// 失败映射为 Chat 标准 429 JSON，而不是返回半成品 Completion。
func TestHandlerReturnsCanonicalFailureForNonStreamRequest(t *testing.T) {
	t.Parallel()

	started, err := inference.NewResponseStartedEvent(
		0,
		"resp_chat_failed",
		"gpt-5.6-sol",
	)
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	failure, err := inference.NewResponseFailure(
		string(runtimecore.FailureRateLimited),
		"请求频率过高",
		true,
	)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	failed, err := inference.NewResponseFailedEvent(1, failure)
	if err != nil {
		t.Fatalf("NewResponseFailedEvent() error = %v", err)
	}
	executor := newScriptedExecutor(
		[]inference.StreamEvent{started, failed},
		nil,
	)
	baseURL, client := startChatServer(t, executor, 0)
	response := performChatRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testBearerToken,
		"application/json",
		minimalChatRequestBody(false),
	)

	if response.status != http.StatusTooManyRequests ||
		!strings.Contains(response.body, `"type":"rate_limit_error"`) ||
		!strings.Contains(
			response.body,
			`"code":"`+string(runtimecore.FailureRateLimited)+`"`,
		) ||
		!strings.Contains(response.body, `"message":"请求频率过高"`) {
		t.Fatalf("failure response = %#v", response)
	}
}

// TestHandlerReturnsCanonicalFailureBeforeStreamStarts 验证上游在任何 Chat
// chunk 之前失败时，客户端收到真实 HTTP 错误而不是伪造 502。
func TestHandlerReturnsCanonicalFailureBeforeStreamStarts(t *testing.T) {
	t.Parallel()

	failure, err := inference.NewResponseFailure(
		string(runtimecore.FailureRateLimited),
		"Please retry later",
		true,
	)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	failed, err := inference.NewResponseFailedEvent(0, failure)
	if err != nil {
		t.Fatalf("NewResponseFailedEvent() error = %v", err)
	}
	executor := newScriptedExecutor(
		[]inference.StreamEvent{failed},
		nil,
	)
	baseURL, client := startChatServer(t, executor, 0)
	payload := minimalChatRequestBody(true)
	response := performChatRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testBearerToken,
		"application/json",
		payload,
	)

	if response.status != http.StatusTooManyRequests ||
		!strings.HasPrefix(response.header.Get("Content-Type"), "application/json") ||
		!strings.Contains(response.body, `"type":"rate_limit_error"`) ||
		!strings.Contains(response.body, `"code":"rate_limited"`) ||
		!strings.Contains(response.body, `"message":"Please retry later"`) ||
		strings.Contains(response.body, "data:") {
		t.Fatalf("pre-stream failure response = %#v", response)
	}
	t.Logf(
		"真实启动前失败 HTTP smoke: POST %s%s payload=%s response=%s",
		baseURL,
		Path,
		payload,
		response.body,
	)
}

// TestHandlerKeepsCanonicalFailureInsideStartedStream 验证 Chat SSE 已提交后
// 不能改写 HTTP 状态，而是输出低敏错误帧和 DONE 终态。
func TestHandlerKeepsCanonicalFailureInsideStartedStream(t *testing.T) {
	t.Parallel()

	started, err := inference.NewResponseStartedEvent(
		0,
		"resp_chat_failed_stream",
		"gpt-5.6-sol",
	)
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	failure, err := inference.NewResponseFailure(
		string(runtimecore.FailureRateLimited),
		"Please retry later",
		true,
	)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	failed, err := inference.NewResponseFailedEvent(1, failure)
	if err != nil {
		t.Fatalf("NewResponseFailedEvent() error = %v", err)
	}
	executor := newScriptedExecutor(
		[]inference.StreamEvent{started, failed},
		nil,
	)
	baseURL, client := startChatServer(t, executor, 0)
	response := performChatRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testBearerToken,
		"application/json",
		minimalChatRequestBody(true),
	)

	frames := parseSSEData(response.body)
	if response.status != http.StatusOK ||
		response.header.Get("Content-Type") != "text/event-stream" ||
		len(frames) != 3 ||
		!strings.Contains(frames[0], `"role":"assistant"`) ||
		!strings.Contains(frames[1], `"code":"rate_limited"`) ||
		!strings.Contains(frames[1], `"message":"Please retry later"`) ||
		frames[2] != "[DONE]" {
		t.Fatalf("started stream failure response = %#v", response)
	}
}

// TestHandlerRejectsInvalidFailureBeforeStreamStarts 验证非零起始序号不会
// 被误认成可信业务失败，仍按损坏的 Canonical 事件流返回 502。
func TestHandlerRejectsInvalidFailureBeforeStreamStarts(t *testing.T) {
	t.Parallel()

	failure, err := inference.NewResponseFailure(
		string(runtimecore.FailureRateLimited),
		"Please retry later",
		true,
	)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	failed, err := inference.NewResponseFailedEvent(1, failure)
	if err != nil {
		t.Fatalf("NewResponseFailedEvent() error = %v", err)
	}
	executor := newScriptedExecutor(
		[]inference.StreamEvent{failed},
		nil,
	)
	baseURL, client := startChatServer(t, executor, 0)
	response := performChatRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testBearerToken,
		"application/json",
		minimalChatRequestBody(true),
	)

	if response.status != http.StatusBadGateway ||
		!strings.Contains(response.body, `"code":"invalid_upstream_response"`) ||
		strings.Contains(response.body, `"code":"rate_limited"`) {
		t.Fatalf("invalid pre-stream failure response = %#v", response)
	}
}

// TestHandlerTerminatesCommittedBrokenStreamSafely 验证已经提交的 Chat SSE
// 在执行器异常退出时追加安全错误帧和 DONE，且不泄漏内部错误。
func TestHandlerTerminatesCommittedBrokenStreamSafely(t *testing.T) {
	t.Parallel()

	started, err := inference.NewResponseStartedEvent(
		0,
		"resp_chat_broken",
		"gpt-5.6-sol",
	)
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	executor := newScriptedExecutor(
		[]inference.StreamEvent{started},
		errors.New("synthetic private upstream detail"),
	)
	baseURL, client := startChatServer(t, executor, 0)
	response := performChatRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testBearerToken,
		"application/json",
		minimalChatRequestBody(true),
	)

	frames := parseSSEData(response.body)
	if response.status != http.StatusOK ||
		len(frames) != 3 ||
		!strings.Contains(frames[0], `"role":"assistant"`) ||
		!strings.Contains(frames[1], `"code":"upstream_unavailable"`) ||
		!strings.Contains(
			frames[1],
			`"message":"Inference service is unavailable"`,
		) ||
		strings.Contains(response.body, "synthetic private") ||
		frames[2] != "[DONE]" ||
		strings.Contains(response.body, "event:") {
		t.Fatalf("broken stream response = %#v", response)
	}
}

// TestHandlerTerminatesCommittedRenderFailureSafely 验证已提交流遇到 Chat
// 无法表达的 Canonical 事件时，生成协议合法且低敏的失败终态。
func TestHandlerTerminatesCommittedRenderFailureSafely(t *testing.T) {
	t.Parallel()

	events := make([]inference.StreamEvent, 0, 4)
	appendEvent := func(event inference.StreamEvent, eventErr error) {
		t.Helper()
		if eventErr != nil {
			t.Fatalf("创建事件失败: %v", eventErr)
		}
		events = append(events, event)
	}
	appendEvent(inference.NewResponseStartedEvent(
		0,
		"resp_chat_render_failed",
		"gpt-5.6-sol",
	))
	appendEvent(inference.NewOutputItemStartedEvent(
		1,
		0,
		"reasoning_render_failed",
		inference.OutputItemReasoning,
	))
	appendEvent(inference.NewContentBlockStartedEvent(
		2,
		0,
		0,
		inference.ContentReasoning,
	))
	encrypted, err := inference.NewEncryptedReasoningContent(
		"synthetic-private-reasoning",
	)
	if err != nil {
		t.Fatalf("NewEncryptedReasoningContent() error = %v", err)
	}
	appendEvent(inference.NewReasoningCompletedEvent(3, 0, 0, encrypted))

	executor := newScriptedExecutor(events, nil)
	baseURL, client := startChatServer(t, executor, 0)
	response := performChatRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testBearerToken,
		"application/json",
		minimalChatRequestBody(true),
	)

	frames := parseSSEData(response.body)
	if response.status != http.StatusOK ||
		len(frames) != 3 ||
		!strings.Contains(frames[0], `"role":"assistant"`) ||
		!strings.Contains(frames[1], `"code":"invalid_upstream_response"`) ||
		!strings.Contains(frames[1], `"message":"Invalid upstream response"`) ||
		strings.Contains(response.body, "synthetic-private-reasoning") ||
		frames[2] != "[DONE]" {
		t.Fatalf("render failure response = %#v", response)
	}
}

// TestHandlerRejectsInvalidHTTPRequests 验证鉴权、路由和请求体边界都在执行器前失败。
func TestHandlerRejectsInvalidHTTPRequests(t *testing.T) {
	t.Parallel()

	testCases := []struct {
		name        string
		method      string
		path        string
		token       string
		contentType string
		body        []byte
		maxBodySize int64
		wantStatus  int
		wantCode    string
	}{
		{
			name:        "未授权",
			method:      http.MethodPost,
			path:        Path,
			contentType: "application/json",
			body:        minimalChatRequestBody(false),
			wantStatus:  http.StatusUnauthorized,
			wantCode:    "invalid_api_key",
		},
		{
			name:        "错误路径",
			method:      http.MethodPost,
			path:        "/v1/chat/unknown",
			token:       testBearerToken,
			contentType: "application/json",
			body:        minimalChatRequestBody(false),
			wantStatus:  http.StatusNotFound,
			wantCode:    "not_found",
		},
		{
			name:        "错误方法",
			method:      http.MethodGet,
			path:        Path,
			token:       testBearerToken,
			contentType: "application/json",
			body:        minimalChatRequestBody(false),
			wantStatus:  http.StatusMethodNotAllowed,
			wantCode:    "method_not_allowed",
		},
		{
			name:        "查询参数",
			method:      http.MethodPost,
			path:        Path + "?debug=true",
			token:       testBearerToken,
			contentType: "application/json",
			body:        minimalChatRequestBody(false),
			wantStatus:  http.StatusBadRequest,
			wantCode:    "invalid_query",
		},
		{
			name:        "错误媒体类型",
			method:      http.MethodPost,
			path:        Path,
			token:       testBearerToken,
			contentType: "text/plain",
			body:        minimalChatRequestBody(false),
			wantStatus:  http.StatusUnsupportedMediaType,
			wantCode:    "unsupported_media_type",
		},
		{
			name:        "请求体过大",
			method:      http.MethodPost,
			path:        Path,
			token:       testBearerToken,
			contentType: "application/json",
			body:        minimalChatRequestBody(false),
			maxBodySize: 32,
			wantStatus:  http.StatusRequestEntityTooLarge,
			wantCode:    "request_too_large",
		},
		{
			name:        "重复 JSON 键",
			method:      http.MethodPost,
			path:        Path,
			token:       testBearerToken,
			contentType: "application/json",
			body: []byte(`{
				"model":"gpt-5.6-sol",
				"model":"gpt-5.4",
				"messages":[{"role":"user","content":"hello"}]
			}`),
			wantStatus: http.StatusBadRequest,
			wantCode:   "invalid_request_body",
		},
		{
			name:        "未知字段",
			method:      http.MethodPost,
			path:        Path,
			token:       testBearerToken,
			contentType: "application/json",
			body: []byte(`{
				"model":"gpt-5.6-sol",
				"messages":[{"role":"user","content":"hello"}],
				"unknown":true
			}`),
			wantStatus: http.StatusBadRequest,
			wantCode:   "invalid_request",
		},
		{
			name:        "不支持的特性",
			method:      http.MethodPost,
			path:        Path,
			token:       testBearerToken,
			contentType: "application/json",
			body: []byte(`{
				"model":"gpt-5.6-sol",
				"messages":[{"role":"user","content":"hello"}],
				"n":2
			}`),
			wantStatus: http.StatusBadRequest,
			wantCode:   "unsupported_feature",
		},
	}
	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			executor := newScriptedExecutor(completeChatEvents(t), nil)
			baseURL, client := startChatServer(
				t,
				executor,
				testCase.maxBodySize,
			)
			response := performChatRequest(
				t,
				client,
				testCase.method,
				baseURL+testCase.path,
				testCase.token,
				testCase.contentType,
				testCase.body,
			)
			if response.status != testCase.wantStatus ||
				!strings.Contains(
					response.body,
					`"code":"`+testCase.wantCode+`"`,
				) ||
				executor.CallCount() != 0 {
				t.Fatalf("response = %#v calls=%d", response, executor.CallCount())
			}
		})
	}
}

// TestHandlerReturnsJSONWhenExecutorFailsBeforeStreamCommit 验证执行器在首个
// SSE 帧前失败时仍返回 503 JSON，并隐藏内部错误。
func TestHandlerReturnsJSONWhenExecutorFailsBeforeStreamCommit(t *testing.T) {
	t.Parallel()

	executor := newScriptedExecutor(
		nil,
		errors.New("synthetic private executor failure"),
	)
	baseURL, client := startChatServer(t, executor, 0)
	response := performChatRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testBearerToken,
		"application/json",
		minimalChatRequestBody(true),
	)

	if response.status != http.StatusServiceUnavailable ||
		response.header.Get("Content-Type") != "application/json; charset=utf-8" ||
		!strings.Contains(response.body, `"code":"upstream_unavailable"`) ||
		!strings.Contains(
			response.body,
			`"message":"Inference service is unavailable"`,
		) ||
		strings.Contains(response.body, "synthetic private") {
		t.Fatalf("executor failure response = %#v", response)
	}
}

// TestNewHandlerRejectsIncompleteDependencies 验证缺少精确协议、执行器、
// 鉴权策略或合法 body limit 时失败关闭。
func TestNewHandlerRejectsIncompleteDependencies(t *testing.T) {
	t.Parallel()

	chatAdapter := newChatAdapter(t)
	registry, err := clientprotocol.NewRegistry(chatAdapter)
	if err != nil {
		t.Fatalf("clientprotocol.NewRegistry() error = %v", err)
	}
	executor := newScriptedExecutor(nil, nil)
	valid := Dependencies{
		Protocols:  registry,
		Executor:   executor,
		Authorizer: bearerAuthorizer{},
	}
	responsesAdapter, err := openairesponses.NewAdapter(time.Now)
	if err != nil {
		t.Fatalf("openairesponses.NewAdapter() error = %v", err)
	}
	wrongRegistry, err := clientprotocol.NewRegistry(responsesAdapter)
	if err != nil {
		t.Fatalf("clientprotocol.NewRegistry(wrong) error = %v", err)
	}
	testCases := []Dependencies{
		{},
		{
			Executor:   executor,
			Authorizer: bearerAuthorizer{},
		},
		{
			Protocols:  wrongRegistry,
			Executor:   executor,
			Authorizer: bearerAuthorizer{},
		},
		{
			Protocols:  registry,
			Authorizer: bearerAuthorizer{},
		},
		{
			Protocols: registry,
			Executor:  executor,
		},
		{
			Protocols:    valid.Protocols,
			Executor:     valid.Executor,
			Authorizer:   valid.Authorizer,
			MaxBodyBytes: -1,
		},
		{
			Protocols:    valid.Protocols,
			Executor:     valid.Executor,
			Authorizer:   valid.Authorizer,
			MaxBodyBytes: MaxBodyBytesLimit + 1,
		},
	}
	for index, dependencies := range testCases {
		if _, err := NewHandler(dependencies); !errors.Is(
			err,
			ErrInvalidDependencies,
		) {
			t.Fatalf("NewHandler(case %d) error = %v", index, err)
		}
	}
}

// scriptedExecutor 按固定顺序发出事件并记录最后一个 Canonical 请求。
type scriptedExecutor struct {
	mu          sync.Mutex
	events      []inference.StreamEvent
	err         error
	callCount   int
	lastRequest inference.Request
	lastPinned  string
}

// newScriptedExecutor 创建不会持有请求正文或凭据的测试执行器。
func newScriptedExecutor(
	events []inference.StreamEvent,
	err error,
) *scriptedExecutor {
	return &scriptedExecutor{
		events: append([]inference.StreamEvent(nil), events...),
		err:    err,
	}
}

// Execute 记录请求并同步传播 EventSink 背压。
func (executor *scriptedExecutor) Execute(
	ctx context.Context,
	request inference.Request,
	emit inferencegateway.EventSink,
) error {
	executor.mu.Lock()
	executor.callCount++
	executor.lastRequest = request
	if accountRef, found := inferencegateway.PinnedAccount(ctx); found {
		executor.lastPinned = accountRef.String()
	} else {
		executor.lastPinned = ""
	}
	events := append([]inference.StreamEvent(nil), executor.events...)
	executionErr := executor.err
	executor.mu.Unlock()
	for _, event := range events {
		if err := emit(event); err != nil {
			return err
		}
	}
	return executionErr
}

// LastPinnedAccount 返回执行器收到的固定账号，不包含任何凭据。
func (executor *scriptedExecutor) LastPinnedAccount() string {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	return executor.lastPinned
}

// LastRequest 返回最后一个 Canonical 请求快照。
func (executor *scriptedExecutor) LastRequest() inference.Request {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	return executor.lastRequest
}

// CallCount 返回执行器调用次数。
func (executor *scriptedExecutor) CallCount() int {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	return executor.callCount
}

// bearerAuthorizer 只接受测试使用的 Bearer Token。
type bearerAuthorizer struct{}

// Authorized 验证 OpenAI 客户端使用的 Authorization 请求头。
func (bearerAuthorizer) Authorized(request *http.Request) bool {
	return request != nil &&
		request.Header.Get("Authorization") == "Bearer "+testBearerToken
}

// startChatServer 创建真实 TCP Listener 和独立 Chat Handler。
func startChatServer(
	t *testing.T,
	executor inferencegateway.Executor,
	maxBodySize int64,
) (string, *http.Client) {
	t.Helper()

	registry, err := clientprotocol.NewRegistry(newChatAdapter(t))
	if err != nil {
		t.Fatalf("clientprotocol.NewRegistry() error = %v", err)
	}
	handler, err := NewHandler(Dependencies{
		Protocols:    registry,
		Executor:     executor,
		Authorizer:   bearerAuthorizer{},
		MaxBodyBytes: maxBodySize,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server.URL, &http.Client{Timeout: 3 * time.Second}
}

// newChatAdapter 创建使用固定时钟的 Chat Adapter。
func newChatAdapter(t *testing.T) openaichatcompletions.Adapter {
	t.Helper()

	adapter, err := openaichatcompletions.NewAdapter(func() time.Time {
		return time.Date(2026, time.July, 27, 0, 0, 0, 0, time.UTC)
	})
	if err != nil {
		t.Fatalf("openaichatcompletions.NewAdapter() error = %v", err)
	}
	return adapter
}

// httpExchange 保存真实 HTTP 测试需要的响应事实。
type httpExchange struct {
	status int
	header http.Header
	body   string
}

// performChatRequest 执行真实 HTTP 请求并读取完整响应。
func performChatRequest(
	t *testing.T,
	client *http.Client,
	method string,
	url string,
	token string,
	contentType string,
	body []byte,
) httpExchange {
	t.Helper()

	request, err := http.NewRequestWithContext(
		context.Background(),
		method,
		url,
		bytes.NewReader(body),
	)
	if err != nil {
		t.Fatalf("http.NewRequestWithContext() error = %v", err)
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("%s %s error = %v", method, url, err)
	}
	defer func() {
		_ = response.Body.Close()
	}()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("io.ReadAll() error = %v", err)
	}
	return httpExchange{
		status: response.StatusCode,
		header: response.Header.Clone(),
		body:   string(responseBody),
	}
}

// minimalChatRequestBody 创建流式或非流式最小合法 Chat 请求。
func minimalChatRequestBody(stream bool) []byte {
	body, _ := json.Marshal(map[string]any{
		"model": "gpt-5.6-sol",
		"messages": []map[string]any{{
			"role":    "user",
			"content": "hello",
		}},
		"stream": stream,
	})
	return body
}

// parseSSEData 按出现顺序读取 data-only SSE 帧。
func parseSSEData(body string) []string {
	frames := make([]string, 0)
	for _, line := range strings.Split(body, "\n") {
		if value, found := strings.CutPrefix(line, "data: "); found {
			frames = append(frames, value)
		}
	}
	return frames
}

// expectFrameContains 验证一个紧凑 JSON 帧包含所有稳定片段。
func expectFrameContains(t *testing.T, frame string, fragments ...string) {
	t.Helper()

	for _, fragment := range fragments {
		if !strings.Contains(frame, fragment) {
			t.Fatalf("frame = %s, missing %s", frame, fragment)
		}
	}
}

// decodeResponseJSON 解码测试响应。
func decodeResponseJSON(t *testing.T, body string, output any) {
	t.Helper()

	if err := json.Unmarshal([]byte(body), output); err != nil {
		t.Fatalf("json.Unmarshal() error = %v body=%s", err, body)
	}
}

// completeChatEvents 创建 reasoning、文本、工具和 usage 的完整事件序列。
func completeChatEvents(t *testing.T) []inference.StreamEvent {
	t.Helper()

	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:       12,
		OutputTokens:      7,
		CachedInputTokens: 2,
		ReasoningTokens:   3,
	})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	reasoning, err := inference.NewReasoningSummaryContent("先分析")
	if err != nil {
		t.Fatalf("NewReasoningSummaryContent() error = %v", err)
	}
	events := make([]inference.StreamEvent, 0, 20)
	appendEvent := func(event inference.StreamEvent, eventErr error) {
		t.Helper()
		if eventErr != nil {
			t.Fatalf("创建事件失败: %v", eventErr)
		}
		events = append(events, event)
	}
	appendEvent(inference.NewResponseStartedEvent(
		0,
		"resp_chat_http_1",
		"gpt-5.6-sol",
	))
	appendEvent(inference.NewOutputItemStartedEvent(
		1,
		0,
		"reasoning_http_1",
		inference.OutputItemReasoning,
	))
	appendEvent(inference.NewContentBlockStartedEvent(
		2,
		0,
		0,
		inference.ContentReasoning,
	))
	appendEvent(inference.NewReasoningDeltaEvent(
		3,
		0,
		0,
		inference.ReasoningDeltaThinking,
		"先分析",
	))
	appendEvent(inference.NewReasoningCompletedEvent(4, 0, 0, reasoning))
	events = append(events, inference.NewContentBlockCompletedEvent(5, 0, 0))
	appendEvent(inference.NewOutputItemCompletedEvent(
		6,
		0,
		"reasoning_http_1",
	))
	appendEvent(inference.NewOutputItemStartedEvent(
		7,
		1,
		"message_http_1",
		inference.OutputItemMessage,
	))
	appendEvent(inference.NewContentBlockStartedEvent(
		8,
		1,
		0,
		inference.ContentText,
	))
	appendEvent(inference.NewTextDeltaEvent(9, 1, 0, "最终回复"))
	appendEvent(inference.NewTextCompletedEvent(10, 1, 0, "最终回复"))
	events = append(events, inference.NewContentBlockCompletedEvent(11, 1, 0))
	appendEvent(inference.NewOutputItemCompletedEvent(
		12,
		1,
		"message_http_1",
	))
	appendEvent(inference.NewOutputItemStartedEvent(
		13,
		2,
		"tool_http_1",
		inference.OutputItemToolCall,
	))
	appendEvent(inference.NewToolCallStartedEvent(
		14,
		2,
		0,
		"call_weather",
		"weather",
	))
	appendEvent(inference.NewToolArgumentsDeltaEvent(
		15,
		2,
		0,
		"call_weather",
		`{"city":"深圳"}`,
	))
	appendEvent(inference.NewToolCallCompletedEvent(
		16,
		2,
		0,
		"call_weather",
		"weather",
		[]byte(`{"city":"深圳"}`),
	))
	appendEvent(inference.NewOutputItemCompletedEvent(
		17,
		2,
		"tool_http_1",
	))
	appendEvent(inference.NewUsageUpdatedEvent(18, usage))
	appendEvent(inference.NewResponseCompletedEvent(
		19,
		inference.StopReasonToolUse,
		"",
		usage,
	))
	return events
}
