package inferencehttp

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/transport/http/anthropicmessagesapi"
	"github.com/madou1217/ai_home/internal/transport/http/openaichatcompletionsapi"
	"github.com/madou1217/ai_home/internal/transport/http/openairesponsesapi"
)

const testClientKey = "synthetic-inference-http-client-key"

// TestModuleRoutesThreeClientProtocolsToOneExecutorOverRealHTTP 验证三个协议
// 入口通过真实 TCP 进入同一个 Canonical Executor，且不会串用 Decoder。
func TestModuleRoutesThreeClientProtocolsToOneExecutorOverRealHTTP(t *testing.T) {
	t.Parallel()

	executor := &trackingExecutor{}
	baseURL, client := startModuleServer(t, executor)
	testCases := []struct {
		name       string
		path       string
		payload    string
		authHeader string
		authValue  string
		protocol   inference.ClientProtocolID
		fragments  []string
	}{
		{
			name:       "OpenAI Responses",
			path:       openairesponsesapi.Path,
			payload:    `{"model":"gpt-5.6-sol","input":"你好"}`,
			authHeader: "Authorization",
			authValue:  "Bearer " + testClientKey,
			protocol:   inference.ClientProtocolOpenAIResponses,
			fragments: []string{
				`"object":"response"`,
				`"status":"completed"`,
				`"model":"gpt-5.6-sol"`,
				`"text":"你好"`,
			},
		},
		{
			name:       "OpenAI Chat Completions",
			path:       openaichatcompletionsapi.Path,
			payload:    `{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"你好"}]}`,
			authHeader: "Authorization",
			authValue:  "Bearer " + testClientKey,
			protocol:   inference.ClientProtocolOpenAIChatCompletions,
			fragments: []string{
				`"object":"chat.completion"`,
				`"model":"gpt-5.6-sol"`,
				`"role":"assistant"`,
				`"content":"你好"`,
			},
		},
		{
			name:       "Anthropic Messages",
			path:       anthropicmessagesapi.Path,
			payload:    `{"model":"claude-opus-5","max_tokens":128,"messages":[{"role":"user","content":"你好"}]}`,
			authHeader: "x-api-key",
			authValue:  testClientKey,
			protocol:   inference.ClientProtocolAnthropicMessages,
			fragments: []string{
				`"type":"message"`,
				`"role":"assistant"`,
				`"model":"claude-opus-5"`,
				`"text":"你好"`,
			},
		},
	}
	for _, testCase := range testCases {
		response := performModuleRequest(
			t,
			client,
			baseURL+testCase.path,
			testCase.authHeader,
			testCase.authValue,
			[]byte(testCase.payload),
		)
		if response.status != http.StatusOK ||
			response.header.Get("Content-Type") !=
				"application/json; charset=utf-8" {
			t.Fatalf("%s response = %#v", testCase.name, response)
		}
		for _, fragment := range testCase.fragments {
			if !strings.Contains(response.body, fragment) {
				t.Fatalf(
					"%s response missing %s: %s",
					testCase.name,
					fragment,
					response.body,
				)
			}
		}
		t.Logf(
			"真实 HTTP 装配 smoke: POST %s\npayload=%s\nresponse=%s",
			baseURL+testCase.path,
			testCase.payload,
			response.body,
		)
	}

	protocols := executor.Protocols()
	if len(protocols) != len(testCases) {
		t.Fatalf("Executor 调用次数 = %d, want %d", len(protocols), len(testCases))
	}
	for index, testCase := range testCases {
		if protocols[index] != testCase.protocol {
			t.Fatalf(
				"protocols[%d] = %q, want %q",
				index,
				protocols[index],
				testCase.protocol,
			)
		}
	}
}

// TestModulePreservesEachStreamingWireContract 验证统一装配不会把命名 SSE
// 和 Chat data-only SSE 混为同一种输出。
func TestModulePreservesEachStreamingWireContract(t *testing.T) {
	t.Parallel()

	executor := &trackingExecutor{}
	baseURL, client := startModuleServer(t, executor)
	testCases := []struct {
		name       string
		path       string
		payload    string
		authHeader string
		authValue  string
		contains   []string
		notContain string
	}{
		{
			name:       "Responses named SSE",
			path:       openairesponsesapi.Path,
			payload:    `{"model":"gpt-5.6-sol","input":"你好","stream":true}`,
			authHeader: "Authorization",
			authValue:  "Bearer " + testClientKey,
			contains: []string{
				"event: response.created",
				"event: response.completed",
				`"delta":"你"`,
				`"delta":"好"`,
			},
		},
		{
			name:       "Chat data-only SSE",
			path:       openaichatcompletionsapi.Path,
			payload:    `{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"你好"}],"stream":true}`,
			authHeader: "Authorization",
			authValue:  "Bearer " + testClientKey,
			contains: []string{
				"data: ",
				`"object":"chat.completion.chunk"`,
				`"role":"assistant"`,
				"data: [DONE]",
			},
			notContain: "event:",
		},
		{
			name:       "Messages named SSE",
			path:       anthropicmessagesapi.Path,
			payload:    `{"model":"claude-opus-5","max_tokens":128,"messages":[{"role":"user","content":"你好"}],"stream":true}`,
			authHeader: "x-api-key",
			authValue:  testClientKey,
			contains: []string{
				"event: message_start",
				"event: message_stop",
				`"text":"你"`,
				`"text":"好"`,
			},
		},
	}
	for _, testCase := range testCases {
		response := performModuleRequest(
			t,
			client,
			baseURL+testCase.path,
			testCase.authHeader,
			testCase.authValue,
			[]byte(testCase.payload),
		)
		if response.status != http.StatusOK ||
			response.header.Get("Content-Type") != "text/event-stream" {
			t.Fatalf("%s response = %#v", testCase.name, response)
		}
		for _, fragment := range testCase.contains {
			if !strings.Contains(response.body, fragment) {
				t.Fatalf(
					"%s response missing %s: %s",
					testCase.name,
					fragment,
					response.body,
				)
			}
		}
		if testCase.notContain != "" &&
			strings.Contains(response.body, testCase.notContain) {
			t.Fatalf(
				"%s response contains %s: %s",
				testCase.name,
				testCase.notContain,
				response.body,
			)
		}
	}
}

// TestModuleSharesClientAuthorizationAcrossAllProtocols 验证三个公开推理入口
// 使用同一客户端权限域，并在读取 Canonical 请求前拒绝未授权调用。
func TestModuleSharesClientAuthorizationAcrossAllProtocols(t *testing.T) {
	t.Parallel()

	executor := &trackingExecutor{}
	baseURL, client := startModuleServer(t, executor)
	testCases := []struct {
		path    string
		payload string
	}{
		{
			path:    openairesponsesapi.Path,
			payload: `{"model":"gpt-5.6-sol","input":"你好"}`,
		},
		{
			path:    openaichatcompletionsapi.Path,
			payload: `{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"你好"}]}`,
		},
		{
			path:    anthropicmessagesapi.Path,
			payload: `{"model":"claude-opus-5","max_tokens":128,"messages":[{"role":"user","content":"你好"}]}`,
		},
	}
	for _, testCase := range testCases {
		response := performModuleRequest(
			t,
			client,
			baseURL+testCase.path,
			"",
			"",
			[]byte(testCase.payload),
		)
		if response.status != http.StatusUnauthorized ||
			response.header.Get("WWW-Authenticate") != "Bearer" {
			t.Fatalf("%s unauthorized response = %#v", testCase.path, response)
		}
	}
	if executor.CallCount() != 0 {
		t.Fatalf("未授权请求调用 Executor %d 次", executor.CallCount())
	}
}

// TestModuleUsesExactRoutes 验证相似但未声明的协议路径不会进入 Executor。
func TestModuleUsesExactRoutes(t *testing.T) {
	t.Parallel()

	executor := &trackingExecutor{}
	baseURL, client := startModuleServer(t, executor)
	response := performModuleRequest(
		t,
		client,
		baseURL+"/v1/completions",
		"Authorization",
		"Bearer "+testClientKey,
		[]byte(`{"model":"gpt-5.6-sol"}`),
	)
	if response.status != http.StatusNotFound || executor.CallCount() != 0 {
		t.Fatalf("unknown route response = %#v calls=%d", response, executor.CallCount())
	}
}

// TestNewRejectsIncompleteDependencies 验证 Executor、鉴权、时钟和请求体上限
// 缺失或无效时，组合模块在创建阶段失败关闭。
func TestNewRejectsIncompleteDependencies(t *testing.T) {
	t.Parallel()

	executor := &trackingExecutor{}
	valid := Dependencies{
		Executor:   executor,
		Authorizer: protocolAuthorizer{},
		Clock:      time.Now,
	}
	testCases := []Dependencies{
		{},
		{
			Authorizer: protocolAuthorizer{},
			Clock:      time.Now,
		},
		{
			Executor: executor,
			Clock:    time.Now,
		},
		{
			Executor:   executor,
			Authorizer: protocolAuthorizer{},
		},
		{
			Executor:     valid.Executor,
			Authorizer:   valid.Authorizer,
			Clock:        valid.Clock,
			MaxBodyBytes: -1,
		},
		{
			Executor:     valid.Executor,
			Authorizer:   valid.Authorizer,
			Clock:        valid.Clock,
			MaxBodyBytes: openairesponsesapi.MaxBodyBytesLimit + 1,
		},
	}
	for index, dependencies := range testCases {
		if _, err := New(dependencies); !errors.Is(
			err,
			ErrInvalidDependencies,
		) {
			t.Fatalf("New(case %d) error = %v", index, err)
		}
	}
}

// trackingExecutor 记录所有客户端协议，并为每个请求生成同构文本事件。
type trackingExecutor struct {
	mu        sync.Mutex
	protocols []inference.ClientProtocolID
}

// Execute 证明组合层把同一个 Executor 实例提供给全部协议 Handler。
func (executor *trackingExecutor) Execute(
	_ context.Context,
	request inference.Request,
	emit inferencegateway.EventSink,
) error {
	executor.mu.Lock()
	executor.protocols = append(executor.protocols, request.ClientProtocol())
	executor.mu.Unlock()

	events, err := newTextEvents(request)
	if err != nil {
		return err
	}
	for _, event := range events {
		if err := emit(event); err != nil {
			return err
		}
	}
	return nil
}

// Protocols 返回不会暴露内部切片的调用顺序快照。
func (executor *trackingExecutor) Protocols() []inference.ClientProtocolID {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	return append([]inference.ClientProtocolID(nil), executor.protocols...)
}

// CallCount 返回统一 Executor 接收的请求数量。
func (executor *trackingExecutor) CallCount() int {
	executor.mu.Lock()
	defer executor.mu.Unlock()
	return len(executor.protocols)
}

// protocolAuthorizer 让同一客户端 Key 按各协议惯例通过 Bearer 或 x-api-key 传递。
type protocolAuthorizer struct{}

// Authorized 验证三个协议共享的客户端权限域。
func (protocolAuthorizer) Authorized(request *http.Request) bool {
	if request == nil {
		return false
	}
	return request.Header.Get("Authorization") == "Bearer "+testClientKey ||
		request.Header.Get("x-api-key") == testClientKey
}

// startModuleServer 创建真实 TCP Server，并注册有界测试清理。
func startModuleServer(
	t *testing.T,
	executor inferencegateway.Executor,
) (string, *http.Client) {
	t.Helper()

	handler, err := New(Dependencies{
		Executor:   executor,
		Authorizer: protocolAuthorizer{},
		Clock: func() time.Time {
			return time.Date(2026, time.July, 30, 0, 0, 0, 0, time.UTC)
		},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server.URL, &http.Client{Timeout: 3 * time.Second}
}

// httpExchange 保存组合模块真实 HTTP 测试的响应事实。
type httpExchange struct {
	status int
	header http.Header
	body   string
}

// performModuleRequest 发送 JSON 请求并读取完整响应。
func performModuleRequest(
	t *testing.T,
	client *http.Client,
	url string,
	authHeader string,
	authValue string,
	body []byte,
) httpExchange {
	t.Helper()

	request, err := http.NewRequestWithContext(
		context.Background(),
		http.MethodPost,
		url,
		bytes.NewReader(body),
	)
	if err != nil {
		t.Fatalf("http.NewRequestWithContext() error = %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	if authHeader != "" {
		request.Header.Set(authHeader, authValue)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("POST %s error = %v", url, err)
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

// newTextEvents 为三个 Renderer 构造都能无损表达的文本响应。
func newTextEvents(request inference.Request) ([]inference.StreamEvent, error) {
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:  4,
		OutputTokens: 2,
	})
	if err != nil {
		return nil, err
	}
	events := make([]inference.StreamEvent, 0, 10)
	appendEvent := func(event inference.StreamEvent, eventErr error) error {
		if eventErr != nil {
			return eventErr
		}
		events = append(events, event)
		return nil
	}
	if err := appendEvent(inference.NewResponseStartedEvent(
		0,
		"resp_shared_http_1",
		request.Model(),
	)); err != nil {
		return nil, fmt.Errorf("创建响应开始事件失败: %w", err)
	}
	if err := appendEvent(inference.NewOutputItemStartedEvent(
		1,
		0,
		"message_shared_http_1",
		inference.OutputItemMessage,
	)); err != nil {
		return nil, fmt.Errorf("创建输出项事件失败: %w", err)
	}
	if err := appendEvent(inference.NewContentBlockStartedEvent(
		2,
		0,
		0,
		inference.ContentText,
	)); err != nil {
		return nil, fmt.Errorf("创建内容块事件失败: %w", err)
	}
	if err := appendEvent(inference.NewTextDeltaEvent(3, 0, 0, "你")); err != nil {
		return nil, fmt.Errorf("创建首个文本增量失败: %w", err)
	}
	if err := appendEvent(inference.NewTextDeltaEvent(4, 0, 0, "好")); err != nil {
		return nil, fmt.Errorf("创建第二个文本增量失败: %w", err)
	}
	if err := appendEvent(inference.NewTextCompletedEvent(
		5,
		0,
		0,
		"你好",
	)); err != nil {
		return nil, fmt.Errorf("创建文本完成事件失败: %w", err)
	}
	events = append(events, inference.NewContentBlockCompletedEvent(6, 0, 0))
	if err := appendEvent(inference.NewOutputItemCompletedEvent(
		7,
		0,
		"message_shared_http_1",
	)); err != nil {
		return nil, fmt.Errorf("创建输出项完成事件失败: %w", err)
	}
	if err := appendEvent(inference.NewUsageUpdatedEvent(8, usage)); err != nil {
		return nil, fmt.Errorf("创建 usage 事件失败: %w", err)
	}
	if err := appendEvent(inference.NewResponseCompletedEvent(
		9,
		inference.StopReasonEndTurn,
		"",
		usage,
	)); err != nil {
		return nil, fmt.Errorf("创建响应完成事件失败: %w", err)
	}
	return events, nil
}
