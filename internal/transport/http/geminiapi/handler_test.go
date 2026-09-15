package geminiapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/clientprotocol/gemini"
	"github.com/madou1217/ai_home/internal/transport/http/geminiapi"
)

// testAPIKey 是本文件独立使用的客户端密钥。
const testAPIKey = "synthetic-gemini-key"

// TestParseTargetRecognizesGenerateContentPaths 验证路径解析只认官方两种入口。
func TestParseTargetRecognizesGenerateContentPaths(t *testing.T) {
	t.Parallel()

	tests := []struct {
		path       string
		model      string
		stream     bool
		recognized bool
	}{
		{
			path:       "/v1/models/gemini-3.0-pro:generateContent",
			model:      "gemini-3.0-pro",
			recognized: true,
		},
		{
			path:       "/v1/models/gemini-3.0-pro:streamGenerateContent",
			model:      "gemini-3.0-pro",
			stream:     true,
			recognized: true,
		},
		{
			path:       "/v1beta/models/gemini-3.0-pro:generateContent",
			model:      "gemini-3.0-pro",
			recognized: true,
		},
		{
			path:       "/v1beta/models/gemini-3.0-pro:streamGenerateContent",
			model:      "gemini-3.0-pro",
			stream:     true,
			recognized: true,
		},
		{
			// URL 转义后的模型名同样可解析。
			path:       "/v1/models/gemini%2D3.0-pro:generateContent",
			model:      "gemini-3.0-pro",
			recognized: true,
		},
		// 以下都不算 Gemini 入口，必须留给单模型查询或 404。
		{path: "/v1/models/gemini-3.0-pro"},
		{path: "/v1/models/gemini-3.0-pro:otherMethod"},
		{path: "/v1/models/"},
		{path: "/v1/models/a/b:generateContent"},
		{path: "/v1/models/:generateContent"},
		{path: "/v1/responses"},
	}

	for _, test := range tests {
		t.Run(test.path, func(t *testing.T) {
			t.Parallel()
			target, ok := geminiapi.ParseTarget(test.path)
			if ok != test.recognized {
				t.Fatalf("ParseTarget(%q) recognized=%v, want %v", test.path, ok, test.recognized)
			}
			if !test.recognized {
				return
			}
			if target.Model != test.model || target.Stream != test.stream {
				t.Fatalf("target = %#v", target)
			}
		})
	}
}

// TestHandlerServesNonStreamGenerateContent 验证非流式入口返回官方响应形状。
func TestHandlerServesNonStreamGenerateContent(t *testing.T) {
	t.Parallel()

	handler := newTestHandler(t, &scriptedExecutor{})
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/models/gemini-3.0-pro:generateContent",
		strings.NewReader(`{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}`),
	)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("x-api-key", testAPIKey)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	var document struct {
		Candidates []struct {
			Content struct {
				Role  string `json:"role"`
				Parts []struct {
					Text *string `json:"text"`
				} `json:"parts"`
			} `json:"content"`
			FinishReason string `json:"finishReason"`
		} `json:"candidates"`
		UsageMetadata struct {
			PromptTokenCount uint64 `json:"promptTokenCount"`
		} `json:"usageMetadata"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("json.Unmarshal() error = %v body=%s", err, response.Body)
	}
	if len(document.Candidates) != 1 ||
		document.Candidates[0].Content.Role != "model" ||
		document.Candidates[0].FinishReason != "STOP" {
		t.Fatalf("candidates = %#v", document.Candidates)
	}
	if document.UsageMetadata.PromptTokenCount != 3 {
		t.Fatalf("usage = %#v", document.UsageMetadata)
	}
}

// TestHandlerStreamsGenerateContent 验证流式入口写出 data-only SSE。
func TestHandlerStreamsGenerateContent(t *testing.T) {
	t.Parallel()

	handler := newTestHandler(t, &scriptedExecutor{})
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1beta/models/gemini-3.0-pro:streamGenerateContent",
		strings.NewReader(`{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}`),
	)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("x-api-key", testAPIKey)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	body := response.Body.String()
	if !strings.HasPrefix(body, "data: ") {
		t.Fatalf("stream body = %q", body)
	}
	if !strings.Contains(body, `"text":"hello"`) ||
		!strings.Contains(body, `"finishReason":"STOP"`) {
		t.Fatalf("stream body = %q", body)
	}
	if strings.Contains(body, "event:") {
		t.Fatalf("Gemini SSE must not emit event names: %q", body)
	}
}

// TestHandlerRejectsUnauthorizedMissingModelAndWrongMethod 验证失败关闭顺序。
func TestHandlerRejectsUnauthorizedMissingModelAndWrongMethod(t *testing.T) {
	t.Parallel()

	handler := newTestHandler(t, &scriptedExecutor{})

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(
		unauthorized,
		httptest.NewRequest(
			http.MethodPost,
			"/v1/models/m:generateContent",
			strings.NewReader(`{}`),
		),
	)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status=%d", unauthorized.Code)
	}

	notFound := httptest.NewRecorder()
	notFoundRequest := httptest.NewRequest(
		http.MethodPost,
		"/v1/models/plain-model",
		strings.NewReader(`{}`),
	)
	notFoundRequest.Header.Set("x-api-key", testAPIKey)
	handler.ServeHTTP(notFound, notFoundRequest)
	if notFound.Code != http.StatusNotFound {
		t.Fatalf("not found status=%d", notFound.Code)
	}

	wrongMethod := httptest.NewRecorder()
	wrongMethodRequest := httptest.NewRequest(
		http.MethodGet,
		"/v1/models/m:generateContent",
		nil,
	)
	wrongMethodRequest.Header.Set("x-api-key", testAPIKey)
	handler.ServeHTTP(wrongMethod, wrongMethodRequest)
	if wrongMethod.Code != http.StatusMethodNotAllowed {
		t.Fatalf("wrong method status=%d", wrongMethod.Code)
	}
	if got := wrongMethod.Header().Get("Allow"); got != http.MethodPost {
		t.Fatalf("allow = %q", got)
	}
}

// TestHandlerReportsDecodeFailureAsInvalidArgument 验证解码失败映射为 400。
func TestHandlerReportsDecodeFailureAsInvalidArgument(t *testing.T) {
	t.Parallel()

	handler := newTestHandler(t, &scriptedExecutor{})
	request := httptest.NewRequest(
		http.MethodPost,
		"/v1/models/m:generateContent",
		strings.NewReader(`{"contents":[{"role":"robot","parts":[{"text":"x"}]}]}`),
	)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("x-api-key", testAPIKey)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	if !strings.Contains(response.Body.String(), `"status":"INVALID_ARGUMENT"`) {
		t.Fatalf("body = %s", response.Body)
	}
}

// TestNewHandlerRejectsIncompleteDependencies 验证缺少依赖时不创建 Handler。
func TestNewHandlerRejectsIncompleteDependencies(t *testing.T) {
	t.Parallel()

	adapter, err := gemini.NewAdapter(func() time.Time { return time.Unix(0, 0) })
	if err != nil {
		t.Fatalf("gemini.NewAdapter() error = %v", err)
	}
	if _, err := geminiapi.NewHandler(geminiapi.Dependencies{
		Adapter: adapter,
	}); err == nil {
		t.Fatal("expected error for missing executor and authorizer")
	}
	if _, err := geminiapi.NewHandler(geminiapi.Dependencies{
		Adapter:      adapter,
		Executor:     &scriptedExecutor{},
		Authorizer:   geminiAuthorizer{},
		MaxBodyBytes: -1,
	}); err == nil {
		t.Fatal("expected error for invalid body limit")
	}
}

// geminiAuthorizer 只接受测试使用的固定客户端密钥。
type geminiAuthorizer struct{}

func (geminiAuthorizer) Authorized(request *http.Request) bool {
	return request.Header.Get("x-api-key") == testAPIKey
}

// scriptedExecutor 产出固定的 Canonical 事件序列。
type scriptedExecutor struct{}

// Execute 依次发出文本增量与成功终态。
func (*scriptedExecutor) Execute(
	_ context.Context,
	_ inference.Request,
	emit inferencegateway.EventSink,
) error {
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:  3,
		OutputTokens: 1,
	})
	if err != nil {
		return err
	}
	delta, err := inference.NewTextDeltaEvent(1, 0, 0, "hello")
	if err != nil {
		return err
	}
	if err := emit(delta); err != nil {
		return err
	}
	completed, err := inference.NewResponseCompletedEvent(
		2,
		inference.StopReasonEndTurn,
		"",
		usage,
	)
	if err != nil {
		return err
	}
	return emit(completed)
}

// newTestHandler 创建使用脚本执行器的 Gemini Handler。
func newTestHandler(t *testing.T, executor inferencegateway.Executor) http.Handler {
	t.Helper()

	adapter, err := gemini.NewAdapter(func() time.Time { return time.Unix(0, 0) })
	if err != nil {
		t.Fatalf("gemini.NewAdapter() error = %v", err)
	}
	handler, err := geminiapi.NewHandler(geminiapi.Dependencies{
		Adapter:    adapter,
		Executor:   executor,
		Authorizer: geminiAuthorizer{},
	})
	if err != nil {
		t.Fatalf("geminiapi.NewHandler() error = %v", err)
	}
	return handler
}
