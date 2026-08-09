package openairesponsesapi

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
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/openairesponses"
)

const testBearerToken = "synthetic-responses-api-key"

// TestHandlerServesNonStreamResponseOverRealHTTP 验证真实 TCP 请求到完整 Responses JSON。
func TestHandlerServesNonStreamResponseOverRealHTTP(t *testing.T) {
	t.Parallel()

	executor := newScriptedExecutor(newTextEvents(t), nil)
	baseURL, client := startResponsesServer(t, executor, 0)
	payload := []byte(`{
		"model":"gpt-5.6-sol",
		"input":"你好",
		"stream":false
	}`)
	response := performResponsesRequest(
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
		ID     string `json:"id"`
		Object string `json:"object"`
		Status string `json:"status"`
		Model  string `json:"model"`
		Output []struct {
			ID      string `json:"id"`
			Type    string `json:"type"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"output"`
		Usage struct {
			InputTokens  uint64 `json:"input_tokens"`
			OutputTokens uint64 `json:"output_tokens"`
			TotalTokens  uint64 `json:"total_tokens"`
		} `json:"usage"`
	}
	decodeResponseJSON(t, response.body, &result)
	if result.ID != "resp_http_1" ||
		result.Object != "response" ||
		result.Status != "completed" ||
		result.Model != "gpt-5.6-sol" ||
		len(result.Output) != 1 ||
		result.Output[0].ID != "msg_http_1" ||
		result.Output[0].Type != "message" ||
		len(result.Output[0].Content) != 1 ||
		result.Output[0].Content[0].Type != "output_text" ||
		result.Output[0].Content[0].Text != "你好" ||
		result.Usage.InputTokens != 4 ||
		result.Usage.OutputTokens != 2 ||
		result.Usage.TotalTokens != 6 {
		t.Fatalf("Responses result = %#v", result)
	}
	canonicalRequest := executor.LastRequest()
	if canonicalRequest.ClientProtocol() != inference.ClientProtocolOpenAIResponses ||
		canonicalRequest.Stream() ||
		canonicalRequest.Model() != "gpt-5.6-sol" {
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

// TestHandlerPreservesResponsesProjectionOverHTTP 验证真实 HTTP 入口使用同一次
// Adapter Exchange 渲染响应，不能在 Canonical 执行后丢失客户端回显字段。
func TestHandlerPreservesResponsesProjectionOverHTTP(t *testing.T) {
	t.Parallel()

	for _, testCase := range []struct {
		name   string
		stream bool
	}{
		{name: "非流式", stream: false},
		{name: "流式终态", stream: true},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			executor := newScriptedExecutor(newTextEvents(t), nil)
			baseURL, client := startResponsesServer(t, executor, 0)
			payload, err := json.Marshal(map[string]any{
				"model":        "gpt-5.6-sol",
				"instructions": "只返回最终答案",
				"input":        "你好",
				"metadata": map[string]string{
					"ticket": "AIH-42",
				},
				"stream": testCase.stream,
			})
			if err != nil {
				t.Fatalf("json.Marshal() error = %v", err)
			}
			response := performResponsesRequest(
				t,
				client,
				http.MethodPost,
				baseURL+Path,
				testBearerToken,
				"application/json",
				payload,
			)
			if response.status != http.StatusOK {
				t.Fatalf("status=%d body=%s", response.status, response.body)
			}

			body := []byte(response.body)
			if testCase.stream {
				body = responseCompletedPayload(t, response.body)
			}
			assertResponsesHTTPProjection(t, body)
		})
	}
}

// TestHandlerPropagatesAndValidatesPinnedAccountHeader 验证固定账号头只以请求 Context 进入执行器。
func TestHandlerPropagatesAndValidatesPinnedAccountHeader(t *testing.T) {
	t.Parallel()

	payload := `{"model":"gpt-5.6-sol","input":"pin","stream":false}`
	t.Run("valid", func(t *testing.T) {
		executor := newScriptedExecutor(newTextEvents(t), nil)
		baseURL, client := startResponsesServer(t, executor, 0)
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
		executor := newScriptedExecutor(newTextEvents(t), nil)
		baseURL, client := startResponsesServer(t, executor, 0)
		request, err := http.NewRequest(http.MethodPost, baseURL+Path, strings.NewReader(payload))
		if err != nil {
			t.Fatalf("http.NewRequest() error = %v", err)
		}
		request.Header.Set("Authorization", "Bearer "+testBearerToken)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Account-Ref", " invalid")
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

// TestHandlerStreamsExactResponsesLifecycleOverRealHTTP 验证 Responses SSE 生命周期和响应头。
func TestHandlerStreamsExactResponsesLifecycleOverRealHTTP(t *testing.T) {
	t.Parallel()

	executor := newScriptedExecutor(newTextEvents(t), nil)
	baseURL, client := startResponsesServer(t, executor, 0)
	payload := []byte(`{
		"model":"gpt-5.6-sol",
		"input":"你好",
		"stream":true
	}`)
	response := performResponsesRequest(
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
		response.header.Get("X-Accel-Buffering") != "no" {
		t.Fatalf("stream response = %#v", response)
	}
	names := parseSSEEventNames(response.body)
	expected := []string{
		"response.created",
		"response.in_progress",
		"response.output_item.added",
		"response.content_part.added",
		"response.output_text.delta",
		"response.output_text.delta",
		"response.output_text.done",
		"response.content_part.done",
		"response.output_item.done",
		"response.completed",
	}
	if strings.Join(names, ",") != strings.Join(expected, ",") {
		t.Fatalf("SSE events = %#v, want %#v\nbody=%s", names, expected, response.body)
	}
	if !strings.Contains(response.body, `"delta":"你"`) ||
		!strings.Contains(response.body, `"delta":"好"`) ||
		!strings.Contains(response.body, `"status":"completed"`) {
		t.Fatalf("SSE body 缺少精确增量或终态: %s", response.body)
	}
	t.Logf(
		"真实 SSE smoke: POST %s%s events=%s response=%s",
		baseURL,
		Path,
		strings.Join(names, ","),
		response.body,
	)
}

// TestHandlerReturnsCanonicalFailureForNonStreamRequest 验证失败状态和 OpenAI 错误结构。
func TestHandlerReturnsCanonicalFailureForNonStreamRequest(t *testing.T) {
	t.Parallel()

	started, err := inference.NewResponseStartedEvent(
		0,
		"resp_failed_1",
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
	baseURL, client := startResponsesServer(t, executor, 0)
	response := performResponsesRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testBearerToken,
		"application/json",
		minimalRequestBody(false),
	)

	if response.status != http.StatusTooManyRequests ||
		!strings.Contains(response.body, `"type":"rate_limit_error"`) ||
		!strings.Contains(response.body, `"code":"rate_limited"`) ||
		!strings.Contains(response.body, `"message":"Please retry later"`) {
		t.Fatalf("failure response = %#v", response)
	}
}

// TestHandlerReturnsCanonicalFailureBeforeStreamStarts 验证上游在任何
// response.created 之前失败时，流式客户端收到真实 HTTP 错误而不是伪造 502。
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
	baseURL, client := startResponsesServer(t, executor, 0)
	payload := minimalRequestBody(true)
	response := performResponsesRequest(
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

// TestHandlerKeepsCanonicalFailureInsideStartedStream 验证 SSE 已提交后不能
// 改写 HTTP 状态，而是使用标准 response.failed 终态保留失败分类。
func TestHandlerKeepsCanonicalFailureInsideStartedStream(t *testing.T) {
	t.Parallel()

	started, err := inference.NewResponseStartedEvent(
		0,
		"resp_failed_stream_1",
		"claude-opus-5",
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
	baseURL, client := startResponsesServer(t, executor, 0)
	response := performResponsesRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testBearerToken,
		"application/json",
		minimalRequestBody(true),
	)

	names := parseSSEEventNames(response.body)
	if response.status != http.StatusOK ||
		response.header.Get("Content-Type") != "text/event-stream" ||
		strings.Join(names, ",") !=
			"response.created,response.in_progress,response.failed" ||
		!strings.Contains(response.body, `"code":"rate_limited"`) {
		t.Fatalf("started stream failure response = %#v", response)
	}
}

// TestHandlerRejectsInvalidFailureBeforeStreamStarts 验证非零起始序号不会
// 被误认成可信业务失败，仍然按损坏的上游事件流返回 502。
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
	baseURL, client := startResponsesServer(t, executor, 0)
	response := performResponsesRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testBearerToken,
		"application/json",
		minimalRequestBody(true),
	)

	if response.status != http.StatusBadGateway ||
		!strings.Contains(response.body, `"code":"invalid_upstream_response"`) ||
		strings.Contains(response.body, `"code":"rate_limited"`) {
		t.Fatalf("invalid pre-stream failure response = %#v", response)
	}
}

// TestHandlerClosesStartedStreamWithFailedResponse 验证缺失终态时不会静默结束 SSE。
func TestHandlerClosesStartedStreamWithFailedResponse(t *testing.T) {
	t.Parallel()

	started, err := inference.NewResponseStartedEvent(
		0,
		"resp_truncated_1",
		"gpt-5.6-sol",
	)
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	executor := newScriptedExecutor(
		[]inference.StreamEvent{started},
		nil,
	)
	baseURL, client := startResponsesServer(t, executor, 0)
	response := performResponsesRequest(
		t,
		client,
		http.MethodPost,
		baseURL+Path,
		testBearerToken,
		"application/json",
		minimalRequestBody(true),
	)

	if response.status != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.status, response.body)
	}
	names := parseSSEEventNames(response.body)
	if strings.Join(names, ",") != "response.created,response.in_progress,response.failed" ||
		!strings.Contains(response.body, `"code":"stream_disconnected"`) ||
		!strings.Contains(response.body, "Upstream response ended unexpectedly") {
		t.Fatalf("truncated SSE = %s", response.body)
	}
}

// TestHandlerRejectsUnauthorizedInvalidAndOversizedRequests 验证执行器前的失败关闭边界。
func TestHandlerRejectsUnauthorizedInvalidAndOversizedRequests(t *testing.T) {
	t.Parallel()

	executor := newScriptedExecutor(nil, errors.New("不应调用执行器"))
	baseURL, client := startResponsesServer(t, executor, 32)
	testCases := []struct {
		name        string
		method      string
		token       string
		contentType string
		body        []byte
		status      int
		errorType   string
	}{
		{
			name:        "未授权",
			method:      http.MethodPost,
			contentType: "application/json",
			body:        minimalRequestBody(false),
			status:      http.StatusUnauthorized,
			errorType:   "authentication_error",
		},
		{
			name:        "错误方法",
			method:      http.MethodGet,
			token:       testBearerToken,
			contentType: "application/json",
			status:      http.StatusMethodNotAllowed,
			errorType:   "invalid_request_error",
		},
		{
			name:        "错误媒体类型",
			method:      http.MethodPost,
			token:       testBearerToken,
			contentType: "text/plain",
			body:        minimalRequestBody(false),
			status:      http.StatusUnsupportedMediaType,
			errorType:   "invalid_request_error",
		},
		{
			name:        "请求体过大",
			method:      http.MethodPost,
			token:       testBearerToken,
			contentType: "application/json",
			body:        minimalRequestBody(false),
			status:      http.StatusRequestEntityTooLarge,
			errorType:   "request_too_large",
		},
	}
	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			response := performResponsesRequest(
				t,
				client,
				testCase.method,
				baseURL+Path,
				testCase.token,
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

// TestHandlerMapsDecoderAndExecutorErrors 验证安全错误不会泄露内部详情。
func TestHandlerMapsDecoderAndExecutorErrors(t *testing.T) {
	t.Parallel()

	t.Run("Decoder 拒绝未知字段", func(t *testing.T) {
		executor := newScriptedExecutor(nil, errors.New("不应调用执行器"))
		baseURL, client := startResponsesServer(t, executor, 0)
		response := performResponsesRequest(
			t,
			client,
			http.MethodPost,
			baseURL+Path,
			testBearerToken,
			"application/json",
			[]byte(`{
				"model":"gpt-5.6-sol",
				"input":"你好",
				"unknown_field":true
			}`),
		)
		if response.status != http.StatusBadRequest ||
			!strings.Contains(response.body, "Invalid request") ||
			executor.CallCount() != 0 {
			t.Fatalf("decode failure response = %#v", response)
		}
	})

	t.Run("请求边界拒绝重复键", func(t *testing.T) {
		executor := newScriptedExecutor(nil, errors.New("不应调用执行器"))
		baseURL, client := startResponsesServer(t, executor, 0)
		response := performResponsesRequest(
			t,
			client,
			http.MethodPost,
			baseURL+Path,
			testBearerToken,
			"application/json",
			[]byte(`{
				"model":"gpt-5.6-sol",
				"model":"gpt-5.4",
				"input":"你好"
			}`),
		)
		if response.status != http.StatusBadRequest ||
			!strings.Contains(response.body, "Invalid request body") ||
			executor.CallCount() != 0 {
			t.Fatalf("duplicate key response = %#v", response)
		}
	})

	t.Run("执行器错误映射为 503", func(t *testing.T) {
		executor := newScriptedExecutor(
			nil,
			errors.New("synthetic upstream unavailable"),
		)
		baseURL, client := startResponsesServer(t, executor, 0)
		response := performResponsesRequest(
			t,
			client,
			http.MethodPost,
			baseURL+Path,
			testBearerToken,
			"application/json",
			minimalRequestBody(true),
		)
		if response.status != http.StatusServiceUnavailable ||
			response.header.Get("Content-Type") != "application/json; charset=utf-8" ||
			strings.Contains(response.body, "synthetic upstream") ||
			!strings.Contains(response.body, "Inference service is unavailable") {
			t.Fatalf("executor failure response = %#v", response)
		}
	})
}

// TestNewHandlerRejectsIncompleteDependencies 验证缺少协议、执行器或鉴权时失败关闭。
func TestNewHandlerRejectsIncompleteDependencies(t *testing.T) {
	t.Parallel()

	responsesAdapter, err := openairesponses.NewAdapter(time.Now)
	if err != nil {
		t.Fatalf("openairesponses.NewAdapter() error = %v", err)
	}
	registry, err := clientprotocol.NewRegistry(responsesAdapter)
	if err != nil {
		t.Fatalf("clientprotocol.NewRegistry() error = %v", err)
	}
	executor := newScriptedExecutor(nil, nil)
	valid := Dependencies{
		Protocols:  registry,
		Executor:   executor,
		Authorizer: bearerAuthorizer{},
	}
	testCases := []Dependencies{
		{},
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

// startResponsesServer 创建真实 TCP Listener 和精确 Responses 路由。
func startResponsesServer(
	t *testing.T,
	executor inferencegateway.Executor,
	maxBodySize int64,
) (string, *http.Client) {
	t.Helper()

	responsesAdapter, err := openairesponses.NewAdapter(time.Now)
	if err != nil {
		t.Fatalf("openairesponses.NewAdapter() error = %v", err)
	}
	registry, err := clientprotocol.NewRegistry(responsesAdapter)
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

// performResponsesRequest 执行真实 HTTP 请求并读取完整响应。
func performResponsesRequest(
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

// minimalRequestBody 创建流式或非流式最小合法请求。
func minimalRequestBody(stream bool) []byte {
	body, _ := json.Marshal(map[string]any{
		"model":  "gpt-5.6-sol",
		"input":  "你好",
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

// responseCompletedPayload 返回 response.completed 事件中的完整 Response 对象。
func responseCompletedPayload(t *testing.T, body string) []byte {
	t.Helper()

	for _, block := range strings.Split(body, "\n\n") {
		if !strings.Contains(block, "event: response.completed\n") {
			continue
		}
		for _, line := range strings.Split(block, "\n") {
			data, found := strings.CutPrefix(line, "data: ")
			if !found {
				continue
			}
			var envelope struct {
				Response json.RawMessage `json:"response"`
			}
			if err := json.Unmarshal([]byte(data), &envelope); err != nil {
				t.Fatalf("response.completed data 无效: %v", err)
			}
			if len(envelope.Response) == 0 {
				t.Fatalf("response.completed 缺少 response: %s", data)
			}
			return envelope.Response
		}
	}
	t.Fatalf("SSE 缺少 response.completed: %s", body)
	return nil
}

// assertResponsesHTTPProjection 校验 Responses 对象必需的协议回显字段。
func assertResponsesHTTPProjection(t *testing.T, body []byte) {
	t.Helper()

	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		t.Fatalf("Responses JSON 无效: %v body=%s", err, body)
	}
	want := map[string]string{
		"instructions":        `"只返回最终答案"`,
		"metadata":            `{"ticket":"AIH-42"}`,
		"parallel_tool_calls": `true`,
		"temperature":         `null`,
		"tool_choice":         `"auto"`,
		"top_p":               `null`,
	}
	for field, expected := range want {
		actual, found := fields[field]
		if !found || !bytes.Equal(actual, []byte(expected)) {
			t.Fatalf("%s=%s want=%s body=%s", field, actual, expected, body)
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

// newTextEvents 创建完整文本 Responses Canonical 事件流。
func newTextEvents(t *testing.T) []inference.StreamEvent {
	t.Helper()

	started, err := inference.NewResponseStartedEvent(
		0,
		"resp_http_1",
		"gpt-5.6-sol",
	)
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	itemStarted, err := inference.NewOutputItemStartedEvent(
		1,
		0,
		"msg_http_1",
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
	firstDelta, err := inference.NewTextDeltaEvent(3, 0, 0, "你")
	if err != nil {
		t.Fatalf("NewTextDeltaEvent(first) error = %v", err)
	}
	secondDelta, err := inference.NewTextDeltaEvent(4, 0, 0, "好")
	if err != nil {
		t.Fatalf("NewTextDeltaEvent(second) error = %v", err)
	}
	textCompleted, err := inference.NewTextCompletedEvent(5, 0, 0, "你好")
	if err != nil {
		t.Fatalf("NewTextCompletedEvent() error = %v", err)
	}
	blockCompleted := inference.NewContentBlockCompletedEvent(6, 0, 0)
	itemCompleted, err := inference.NewOutputItemCompletedEvent(
		7,
		0,
		"msg_http_1",
	)
	if err != nil {
		t.Fatalf("NewOutputItemCompletedEvent() error = %v", err)
	}
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:  4,
		OutputTokens: 2,
	})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	usageUpdated, err := inference.NewUsageUpdatedEvent(8, usage)
	if err != nil {
		t.Fatalf("NewUsageUpdatedEvent() error = %v", err)
	}
	completed, err := inference.NewResponseCompletedEvent(
		9,
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
		firstDelta,
		secondDelta,
		textCompleted,
		blockCompleted,
		itemCompleted,
		usageUpdated,
		completed,
	}
}
