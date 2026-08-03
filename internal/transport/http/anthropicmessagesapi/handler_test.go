package anthropicmessagesapi

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
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/anthropicmessages"
)

const testAPIKey = "synthetic-inference-api-key"

// TestHandlerServesNonStreamMessageOverRealHTTP 验证真实 TCP 请求到完整 Messages JSON。
func TestHandlerServesNonStreamMessageOverRealHTTP(t *testing.T) {
	t.Parallel()

	events := newTextEvents(t)
	executor := newScriptedExecutor(events, nil)
	baseURL, client := startMessagesServer(t, executor, 0)
	payload := []byte(`{
		"model":"claude-opus-4-6",
		"max_tokens":4096,
		"messages":[{"role":"user","content":"你好"}]
	}`)
	response := performMessagesRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testAPIKey,
		payload,
	)

	if response.status != http.StatusOK ||
		response.header.Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("response = %#v", response)
	}
	var message struct {
		ID         string `json:"id"`
		Type       string `json:"type"`
		Role       string `json:"role"`
		Model      string `json:"model"`
		StopReason string `json:"stop_reason"`
		Content    []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		Usage struct {
			InputTokens              uint64 `json:"input_tokens"`
			CacheCreationInputTokens uint64 `json:"cache_creation_input_tokens"`
			CacheReadInputTokens     uint64 `json:"cache_read_input_tokens"`
			OutputTokens             uint64 `json:"output_tokens"`
		} `json:"usage"`
	}
	decodeResponseJSON(t, response.body, &message)
	if message.ID != "msg_http_1" ||
		message.Type != "message" ||
		message.Role != "assistant" ||
		message.Model != "claude-opus-4-6" ||
		message.StopReason != "end_turn" ||
		len(message.Content) != 1 ||
		message.Content[0].Text != "你好" ||
		message.Usage.InputTokens != 70 ||
		message.Usage.CacheCreationInputTokens != 10 ||
		message.Usage.CacheReadInputTokens != 20 ||
		message.Usage.OutputTokens != 2 {
		t.Fatalf("message = %#v", message)
	}
	canonicalRequest := executor.LastRequest()
	if canonicalRequest.ClientProtocol() != inference.ClientProtocolAnthropicMessages ||
		canonicalRequest.Stream() ||
		canonicalRequest.Model() != "claude-opus-4-6" {
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

// TestHandlerPropagatesAndValidatesPinnedAccountHeader 验证 Messages 入站保留固定账号约束。
func TestHandlerPropagatesAndValidatesPinnedAccountHeader(t *testing.T) {
	t.Parallel()

	payload := `{"model":"claude-opus-4-6","max_tokens":64,"messages":[{"role":"user","content":"pin"}]}`
	t.Run("valid", func(t *testing.T) {
		executor := newScriptedExecutor(newTextEvents(t), nil)
		baseURL, client := startMessagesServer(t, executor, 0)
		request, err := http.NewRequest(http.MethodPost, baseURL+Path, strings.NewReader(payload))
		if err != nil {
			t.Fatalf("http.NewRequest() error = %v", err)
		}
		request.Header.Set("x-api-key", testAPIKey)
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
		executor := newScriptedExecutor(newTextEvents(t), nil)
		baseURL, client := startMessagesServer(t, executor, 0)
		request, err := http.NewRequest(http.MethodPost, baseURL+Path, strings.NewReader(payload))
		if err != nil {
			t.Fatalf("http.NewRequest() error = %v", err)
		}
		request.Header.Set("x-api-key", testAPIKey)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Account-Ref", "acct_invalid")
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

// TestHandlerStreamsExactAnthropicLifecycleOverRealHTTP 验证 SSE 生命周期和即时协议头。
func TestHandlerStreamsExactAnthropicLifecycleOverRealHTTP(t *testing.T) {
	t.Parallel()

	executor := newScriptedExecutor(newTextEvents(t), nil)
	baseURL, client := startMessagesServer(t, executor, 0)
	response := performMessagesRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testAPIKey,
		[]byte(`{
			"model":"claude-opus-4-6",
			"max_tokens":4096,
			"messages":[{"role":"user","content":"你好"}],
			"stream":true
		}`),
	)

	if response.status != http.StatusOK ||
		response.header.Get("Content-Type") != "text/event-stream" ||
		response.header.Get("X-Accel-Buffering") != "no" {
		t.Fatalf("stream response = %#v", response)
	}
	names := parseSSEEventNames(response.body)
	expected := []string{
		"message_start",
		"content_block_start",
		"content_block_delta",
		"content_block_delta",
		"content_block_stop",
		"message_delta",
		"message_stop",
	}
	if strings.Join(names, ",") != strings.Join(expected, ",") {
		t.Fatalf("SSE events = %#v, want %#v\nbody=%s", names, expected, response.body)
	}
	if !strings.Contains(response.body, `"text":"你"`) ||
		!strings.Contains(response.body, `"text":"好"`) ||
		!strings.Contains(response.body, `"stop_reason":"end_turn"`) {
		t.Fatalf("SSE body 缺少精确增量或终态: %s", response.body)
	}
	t.Logf(
		"真实 SSE smoke: POST %s%s events=%s",
		baseURL,
		Path,
		strings.Join(names, ","),
	)
}

// TestHandlerReturnsCanonicalFailureForNonStreamRequest 验证安全失败保持协议形状和状态码。
func TestHandlerReturnsCanonicalFailureForNonStreamRequest(t *testing.T) {
	t.Parallel()

	started, err := inference.NewResponseStartedEvent(
		0,
		"msg_failed_1",
		"claude-opus-4-6",
	)
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	failure, err := inference.NewResponseFailure(
		"rate_limit_error",
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
	baseURL, client := startMessagesServer(t, executor, 0)
	response := performMessagesRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testAPIKey,
		minimalRequestBody(false),
	)

	if response.status != http.StatusTooManyRequests ||
		!strings.Contains(response.body, `"type":"rate_limit_error"`) ||
		!strings.Contains(response.body, `"message":"Please retry later"`) {
		t.Fatalf("failure response = %#v", response)
	}
}

// TestHandlerReturnsCanonicalFailureBeforeStreamStarts 验证上游在任何
// message_start 之前失败时，客户端收到真实 Messages HTTP 错误而不是 502。
func TestHandlerReturnsCanonicalFailureBeforeStreamStarts(t *testing.T) {
	t.Parallel()

	failure, err := inference.NewResponseFailure(
		"rate_limit_error",
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
	baseURL, client := startMessagesServer(t, executor, 0)
	payload := minimalRequestBody(true)
	response := performMessagesRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testAPIKey,
		payload,
	)

	if response.status != http.StatusTooManyRequests ||
		!strings.HasPrefix(response.header.Get("Content-Type"), "application/json") ||
		!strings.Contains(response.body, `"type":"error"`) ||
		!strings.Contains(response.body, `"type":"rate_limit_error"`) ||
		!strings.Contains(response.body, `"message":"Please retry later"`) ||
		strings.Contains(response.body, "event:") {
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

// TestHandlerKeepsCanonicalFailureInsideStartedStream 验证 Messages SSE
// 已提交后不能改写 HTTP 状态，而是保留合法 error 终态。
func TestHandlerKeepsCanonicalFailureInsideStartedStream(t *testing.T) {
	t.Parallel()

	started, err := inference.NewResponseStartedEvent(
		0,
		"msg_failed_stream",
		"claude-opus-4-6",
	)
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	failure, err := inference.NewResponseFailure(
		"rate_limit_error",
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
	baseURL, client := startMessagesServer(t, executor, 0)
	response := performMessagesRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testAPIKey,
		minimalRequestBody(true),
	)

	names := parseSSEEventNames(response.body)
	if response.status != http.StatusOK ||
		response.header.Get("Content-Type") != "text/event-stream" ||
		strings.Join(names, ",") != "message_start,error" ||
		!strings.Contains(response.body, `"type":"rate_limit_error"`) ||
		!strings.Contains(response.body, `"message":"Please retry later"`) {
		t.Fatalf("started stream failure response = %#v", response)
	}
}

// TestHandlerRejectsInvalidFailureBeforeStreamStarts 验证非零起始序号不会
// 被误认成可信业务失败，仍按损坏的 Canonical 事件流返回 502。
func TestHandlerRejectsInvalidFailureBeforeStreamStarts(t *testing.T) {
	t.Parallel()

	failure, err := inference.NewResponseFailure(
		"rate_limit_error",
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
	baseURL, client := startMessagesServer(t, executor, 0)
	response := performMessagesRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testAPIKey,
		minimalRequestBody(true),
	)

	if response.status != http.StatusBadGateway ||
		!strings.Contains(response.body, `"type":"api_error"`) ||
		strings.Contains(response.body, `"type":"rate_limit_error"`) {
		t.Fatalf("invalid pre-stream failure response = %#v", response)
	}
}

// TestHandlerClosesStartedStreamWithErrorWhenTerminalIsMissing 验证断流不会静默成功。
func TestHandlerClosesStartedStreamWithErrorWhenTerminalIsMissing(t *testing.T) {
	t.Parallel()

	started, err := inference.NewResponseStartedEvent(
		0,
		"msg_truncated_1",
		"claude-opus-4-6",
	)
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	executor := newScriptedExecutor(
		[]inference.StreamEvent{started},
		nil,
	)
	baseURL, client := startMessagesServer(t, executor, 0)
	response := performMessagesRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testAPIKey,
		minimalRequestBody(true),
	)

	if response.status != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.status, response.body)
	}
	names := parseSSEEventNames(response.body)
	if strings.Join(names, ",") != "message_start,error" ||
		!strings.Contains(response.body, "Upstream response ended unexpectedly") {
		t.Fatalf("truncated SSE = %s", response.body)
	}
}

// TestHandlerRejectsUnauthorizedInvalidAndOversizedRequests 验证执行器之前的失败关闭边界。
func TestHandlerRejectsUnauthorizedInvalidAndOversizedRequests(t *testing.T) {
	t.Parallel()

	executor := newScriptedExecutor(nil, errors.New("不应调用执行器"))
	baseURL, client := startMessagesServer(t, executor, 64)
	testCases := []struct {
		name        string
		method      string
		apiKey      string
		contentType string
		body        []byte
		status      int
		errorType   string
	}{
		{
			name:        "未授权",
			method:      http.MethodPost,
			body:        minimalRequestBody(false),
			status:      http.StatusUnauthorized,
			errorType:   "authentication_error",
			contentType: "application/json",
		},
		{
			name:        "错误方法",
			method:      http.MethodGet,
			apiKey:      testAPIKey,
			status:      http.StatusMethodNotAllowed,
			errorType:   "invalid_request_error",
			contentType: "application/json",
		},
		{
			name:        "错误媒体类型",
			method:      http.MethodPost,
			apiKey:      testAPIKey,
			body:        minimalRequestBody(false),
			status:      http.StatusUnsupportedMediaType,
			errorType:   "invalid_request_error",
			contentType: "text/plain",
		},
		{
			name:        "请求体过大",
			method:      http.MethodPost,
			apiKey:      testAPIKey,
			body:        minimalRequestBody(false),
			status:      http.StatusRequestEntityTooLarge,
			errorType:   "request_too_large",
			contentType: "application/json",
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			response := performMessagesRequestWithContentType(
				t,
				client,
				testCase.method,
				baseURL+Path,
				testCase.apiKey,
				testCase.contentType,
				testCase.body,
			)
			if response.status != testCase.status ||
				!strings.Contains(
					response.body,
					`"type":"`+testCase.errorType+`"`,
				) {
				t.Fatalf("response = %#v", response)
			}
		})
	}
	if executor.CallCount() != 0 {
		t.Fatalf("Executor calls = %d, want 0", executor.CallCount())
	}
}

// TestHandlerMapsExecutorSetupFailureBeforeStreamCommit 验证启动错误仍返回 JSON 503。
func TestHandlerMapsExecutorSetupFailureBeforeStreamCommit(t *testing.T) {
	t.Parallel()

	executor := newScriptedExecutor(nil, errors.New("synthetic upstream unavailable"))
	baseURL, client := startMessagesServer(t, executor, 0)
	response := performMessagesRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testAPIKey,
		minimalRequestBody(true),
	)
	if response.status != http.StatusServiceUnavailable ||
		response.header.Get("Content-Type") != "application/json; charset=utf-8" ||
		strings.Contains(response.body, "synthetic upstream") ||
		!strings.Contains(response.body, "Inference service is unavailable") {
		t.Fatalf("setup failure response = %#v", response)
	}
}

// TestHandlerMapsDecoderErrorsWithoutCallingExecutor 验证协议错误不会进入账号和上游链。
func TestHandlerMapsDecoderErrorsWithoutCallingExecutor(t *testing.T) {
	t.Parallel()

	executor := newScriptedExecutor(nil, errors.New("不应调用执行器"))
	baseURL, client := startMessagesServer(t, executor, 0)
	testCases := []struct {
		name    string
		body    []byte
		message string
	}{
		{
			name: "未知字段",
			body: []byte(`{
				"model":"claude-opus-4-6",
				"max_tokens":1024,
				"messages":[{"role":"user","content":"你好"}],
				"unknown_field":true
			}`),
			message: "Invalid request",
		},
		{
			name: "尚未支持字段",
			body: []byte(`{
				"model":"claude-opus-4-6",
				"max_tokens":1024,
				"messages":[{"role":"user","content":"你好"}],
				"service_tier":"auto"
			}`),
			message: "Request feature is not supported",
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			response := performMessagesRequest(
				t,
				client,
				http.MethodPost,
				baseURL+Path,
				testAPIKey,
				testCase.body,
			)
			if response.status != http.StatusBadRequest ||
				!strings.Contains(response.body, testCase.message) {
				t.Fatalf("response = %#v", response)
			}
		})
	}
	if executor.CallCount() != 0 {
		t.Fatalf("Executor calls = %d, want 0", executor.CallCount())
	}
}

// TestNewHandlerRejectsIncompleteDependencies 验证生产装配缺项时不会暴露路由。
func TestNewHandlerRejectsIncompleteDependencies(t *testing.T) {
	t.Parallel()

	registry, err := clientprotocol.NewRegistry(anthropicmessages.NewAdapter())
	if err != nil {
		t.Fatalf("NewRegistry() error = %v", err)
	}
	executor := newScriptedExecutor(nil, nil)
	valid := Dependencies{
		Protocols:  registry,
		Executor:   executor,
		Authorizer: apiKeyAuthorizer{},
	}
	testCases := []Dependencies{
		{},
		{
			Protocols:  registry,
			Authorizer: apiKeyAuthorizer{},
		},
		{
			Protocols: registry,
			Executor:  executor,
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

// LastRequest 返回最后一个不可变 Canonical 请求快照。
func (executor *scriptedExecutor) LastRequest() inference.Request {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	return executor.lastRequest
}

// CallCount 返回执行器被调用次数。
func (executor *scriptedExecutor) CallCount() int {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	return executor.callCount
}

// apiKeyAuthorizer 只接受测试使用的 x-api-key。
type apiKeyAuthorizer struct{}

// Authorized 验证 Anthropic SDK 常用的 x-api-key 请求头。
func (apiKeyAuthorizer) Authorized(request *http.Request) bool {
	return request != nil && request.Header.Get("x-api-key") == testAPIKey
}

// startMessagesServer 创建真实 TCP Listener 和精确 Messages 路由。
func startMessagesServer(
	t *testing.T,
	executor inferencegateway.Executor,
	maxBodySize int64,
) (string, *http.Client) {
	t.Helper()

	registry, err := clientprotocol.NewRegistry(anthropicmessages.NewAdapter())
	if err != nil {
		t.Fatalf("NewRegistry() error = %v", err)
	}
	handler, err := NewHandler(Dependencies{
		Protocols:    registry,
		Executor:     executor,
		Authorizer:   apiKeyAuthorizer{},
		MaxBodyBytes: maxBodySize,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle(Path, handler)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server.URL, &http.Client{Timeout: 3 * time.Second}
}

// httpExchange 保存真实 HTTP 测试需要的响应事实。
type httpExchange struct {
	status int
	header http.Header
	body   string
}

// performMessagesRequest 使用标准 application/json 调用 Messages Handler。
func performMessagesRequest(
	t *testing.T,
	client *http.Client,
	method string,
	url string,
	apiKey string,
	body []byte,
) httpExchange {
	t.Helper()
	return performMessagesRequestWithContentType(
		t,
		client,
		method,
		url,
		apiKey,
		"application/json",
		body,
	)
}

// performMessagesRequestWithContentType 执行真实 HTTP 请求并读取完整响应。
func performMessagesRequestWithContentType(
	t *testing.T,
	client *http.Client,
	method string,
	url string,
	apiKey string,
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
	if apiKey != "" {
		request.Header.Set("x-api-key", apiKey)
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

// minimalRequestBody 创建流式或非流式最小合法请求。
func minimalRequestBody(stream bool) []byte {
	body, _ := json.Marshal(map[string]any{
		"model":      "claude-opus-4-6",
		"max_tokens": 1024,
		"messages": []map[string]any{{
			"role":    "user",
			"content": "你好",
		}},
		"stream": stream,
	})
	return body
}

// parseSSEEventNames 按出现顺序读取 event 字段。
func parseSSEEventNames(body string) []string {
	names := make([]string, 0)
	for _, line := range strings.Split(body, "\n") {
		if value, found := strings.CutPrefix(line, "event: "); found {
			names = append(names, value)
		}
	}
	return names
}

// decodeResponseJSON 解码测试响应。
func decodeResponseJSON(t *testing.T, body string, output any) {
	t.Helper()
	if err := json.Unmarshal([]byte(body), output); err != nil {
		t.Fatalf("json.Unmarshal() error = %v body=%s", err, body)
	}
}

// newTextEvents 创建包含缓存 usage 拆分的完整文本响应。
func newTextEvents(t *testing.T) []inference.StreamEvent {
	t.Helper()

	started, err := inference.NewResponseStartedEvent(
		0,
		"msg_http_1",
		"claude-opus-4-6",
	)
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	itemStarted, err := inference.NewOutputItemStartedEvent(
		1,
		0,
		"item_http_1",
		inference.OutputItemMessage,
	)
	if err != nil {
		t.Fatalf("NewOutputItemStartedEvent() error = %v", err)
	}
	blockStarted, err := inference.NewContentBlockStartedEvent(
		2,
		0,
		0,
		inference.ContentText,
	)
	if err != nil {
		t.Fatalf("NewContentBlockStartedEvent() error = %v", err)
	}
	delta, err := inference.NewTextDeltaEvent(3, 0, 0, "你")
	if err != nil {
		t.Fatalf("NewTextDeltaEvent() error = %v", err)
	}
	textCompleted, err := inference.NewTextCompletedEvent(4, 0, 0, "你好")
	if err != nil {
		t.Fatalf("NewTextCompletedEvent() error = %v", err)
	}
	blockCompleted := inference.NewContentBlockCompletedEvent(5, 0, 0)
	itemCompleted, err := inference.NewOutputItemCompletedEvent(
		6,
		0,
		"item_http_1",
	)
	if err != nil {
		t.Fatalf("NewOutputItemCompletedEvent() error = %v", err)
	}
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:           100,
		OutputTokens:          2,
		CachedInputTokens:     20,
		CacheWriteInputTokens: 10,
	})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	usageUpdated, err := inference.NewUsageUpdatedEvent(7, usage)
	if err != nil {
		t.Fatalf("NewUsageUpdatedEvent() error = %v", err)
	}
	completed, err := inference.NewResponseCompletedEvent(
		8,
		inference.StopReasonEndTurn,
		"",
		usage,
	)
	if err != nil {
		t.Fatalf("NewResponseCompletedEvent() error = %v", err)
	}
	return []inference.StreamEvent{
		started,
		itemStarted,
		blockStarted,
		delta,
		textCompleted,
		blockCompleted,
		itemCompleted,
		usageUpdated,
		completed,
	}
}
