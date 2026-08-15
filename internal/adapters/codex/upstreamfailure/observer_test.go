package upstreamfailure

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"testing/iotest"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// TestObserveCodexHTTPReadsRealErrorResponse 验证真实 HTTP Response 被投影为低敏限流。
func TestObserveCodexHTTPReadsRealErrorResponse(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, _ *http.Request) {
			response.Header().Set("Content-Type", "application/json")
			response.Header().Set("Retry-After", "120")
			response.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(
				response,
				`{"error":{"type":"rate_limit_error","message":"secret prompt value"}}`,
			)
		},
	))
	defer upstream.Close()

	response, err := upstream.Client().Get(upstream.URL)
	if err != nil {
		t.Fatalf("GET fake upstream error = %v", err)
	}
	defer func() {
		_ = response.Body.Close()
	}()

	classification, err := ObserveHTTP(
		response,
		time.Date(2026, 7, 28, 18, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatalf("ObserveHTTP() error = %v", err)
	}
	if classification.Kind() != runtimecore.FailureRateLimited ||
		classification.RetryAfter() != 2*time.Minute {
		t.Fatalf("ObserveHTTP() = %#v", classification)
	}
}

// TestObserveCodexHTTPMapsKnownEnvelopes 验证 Codex 不同错误 envelope 的优先级。
func TestObserveCodexHTTPMapsKnownEnvelopes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		statusCode int
		body       string
		want       runtimecore.FailureKind
	}{
		{
			name:       "工作区停用 detail",
			statusCode: http.StatusPaymentRequired,
			body:       `{"detail":{"code":"deactivated_workspace"}}`,
			want:       runtimecore.FailureWorkspaceDeactivated,
		},
		{
			name:       "API Key 无效",
			statusCode: http.StatusUnauthorized,
			body:       `{"error":{"code":"invalid_api_key","message":"never expose"}}`,
			want:       runtimecore.FailureCredentialRejected,
		},
		{
			name:       "畸形 503 使用状态兜底",
			statusCode: http.StatusServiceUnavailable,
			body:       `{"error":`,
			want:       runtimecore.FailureUpstreamUnavailable,
		},
		{
			name:       "超大 529 正文不影响状态分类",
			statusCode: 529,
			body:       strings.Repeat("x", sharedfailure.MaxErrorPayloadBytes+1),
			want:       runtimecore.FailureModelOverloaded,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			classification, err := ObserveHTTP(
				newCodexHTTPResponse(test.statusCode, nil, test.body),
				time.Date(2026, 7, 28, 18, 0, 0, 0, time.UTC),
			)
			if err != nil {
				t.Fatalf("ObserveHTTP() error = %v", err)
			}
			if classification.Kind() != test.want {
				t.Fatalf(
					"ObserveHTTP() kind = %s, want %s",
					classification.Kind(),
					test.want,
				)
			}
		})
	}
}

// TestObserveCodexHTTPMapsMessageOnlyModelMissingErrors 固化 Node 真实 relay
// 回归中确认的四类 400/404 文案。它们没有稳定业务 code，但都明确表示
// 当前 (账号, 模型) 不可用，不能退化成普通参数错误。
func TestObserveCodexHTTPMapsMessageOnlyModelMissingErrors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		statusCode int
		body       string
	}{
		{
			name:       "litellm invalid model name",
			statusCode: http.StatusBadRequest,
			body:       `{"error":{"message":"/responses: Invalid model name passed in model=gpt-5.6-luna. Call \u0060/v1/models\u0060 to view available models for your key.","type":"None","code":"400"}}`,
		},
		{
			name:       "new-api configured account",
			statusCode: http.StatusNotFound,
			body:       `{"error":{"message":"Model \"gpt-5.6-luna\" is not supported by any configured account in this group","type":"model_not_found"}}`,
		},
		{
			name:       "ChatGPT account entitlement",
			statusCode: http.StatusBadRequest,
			body:       `{"error":{"message":"The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account."}}`,
		},
		{
			name:       "OpenAI classic missing model",
			statusCode: http.StatusNotFound,
			body:       `{"error":{"message":"The model \u0060gpt-9\u0060 does not exist or you do not have access to it."}}`,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			classification, err := ObserveHTTP(
				newCodexHTTPResponse(test.statusCode, nil, test.body),
				time.Date(2026, 8, 15, 8, 0, 0, 0, time.UTC),
			)
			if err != nil {
				t.Fatalf("ObserveHTTP() error = %v", err)
			}
			directive := classification.BlockDirective()
			if classification.Kind() != runtimecore.FailureModelUnsupported ||
				directive.Scope() != runtimecore.BlockScopeAccountModel ||
				directive.RecoveryTrigger() != runtimecore.RecoveryModelCatalog {
				t.Fatalf("ObserveHTTP() = %#v", classification)
			}
		})
	}
}

// TestObserveCodexHTTPKeepsOrdinaryBadRequest 验证普通缺参 400 不会因为正文
// 提到了请求字段而触发换号或模型目录刷新语义。
func TestObserveCodexHTTPKeepsOrdinaryBadRequest(t *testing.T) {
	t.Parallel()

	classification, err := ObserveHTTP(
		newCodexHTTPResponse(
			http.StatusBadRequest,
			nil,
			`{"error":{"message":"Missing required parameter: 'input'.","type":"invalid_request_error"}}`,
		),
		time.Date(2026, 8, 15, 8, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatalf("ObserveHTTP() error = %v", err)
	}
	if classification.Kind() != runtimecore.FailureInvalidRequest ||
		!classification.BlockDirective().IsZero() {
		t.Fatalf("ObserveHTTP() = %#v", classification)
	}
}

// TestObserveCodexHTTPKeepsStableBusinessCode 验证已确认业务 code 的优先级
// 高于 message，即使异常上游拼接了相同文案也不能覆盖凭据失败。
func TestObserveCodexHTTPKeepsStableBusinessCode(t *testing.T) {
	t.Parallel()

	classification, err := ObserveHTTP(
		newCodexHTTPResponse(
			http.StatusBadRequest,
			nil,
			`{"error":{"code":"invalid_api_key","message":"The model \u0060gpt-9\u0060 does not exist or you do not have access to it."}}`,
		),
		time.Date(2026, 8, 15, 8, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatalf("ObserveHTTP() error = %v", err)
	}
	if classification.Kind() != runtimecore.FailureCredentialRejected ||
		classification.BlockDirective().Scope() != runtimecore.BlockScopeAccount {
		t.Fatalf("ObserveHTTP() = %#v", classification)
	}
}

// TestObserveCodexHTTPDoesNotGuessNearMissModelMessages 验证签名必须完整匹配
// 已确认文案；仅包含 model/not supported 等散词不能改变 4xx 语义。
func TestObserveCodexHTTPDoesNotGuessNearMissModelMessages(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		statusCode int
		message    string
		want       runtimecore.FailureKind
	}{
		{
			name:       "invalid model name without relay contract suffix",
			statusCode: http.StatusBadRequest,
			message:    "Invalid model name format in request input.",
			want:       runtimecore.FailureInvalidRequest,
		},
		{
			name:       "configured account wording without model identity",
			statusCode: http.StatusNotFound,
			message:    "Model is not supported by any configured account in this group",
			want:       runtimecore.FailureNotFound,
		},
		{
			name:       "known text on unsupported status",
			statusCode: http.StatusUnprocessableEntity,
			message:    "The model `gpt-9` does not exist or you do not have access to it.",
			want:       runtimecore.FailureInvalidRequest,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			classification, err := ObserveHTTP(
				newCodexHTTPResponse(
					test.statusCode,
					nil,
					`{"error":{"message":`+strconv.Quote(test.message)+`}}`,
				),
				time.Date(2026, 8, 15, 8, 0, 0, 0, time.UTC),
			)
			if err != nil {
				t.Fatalf("ObserveHTTP() error = %v", err)
			}
			if classification.Kind() != test.want ||
				!classification.BlockDirective().IsZero() {
				t.Fatalf("ObserveHTTP() = %#v", classification)
			}
		})
	}
}

// TestObserveCodexSSEMapsChunkedResponseFailure 验证分块 JSON 事件和精确 capacity 文案。
func TestObserveCodexSSEMapsChunkedResponseFailure(t *testing.T) {
	t.Parallel()

	classification, observed, err := ObserveSSE(sharedfailure.SSEInput{
		EventType: "response.failed",
		Data: iotest.OneByteReader(strings.NewReader(
			`{"type":"response.failed","response":{"error":{"message":"Selected model is at capacity. Please try a different model."}}}`,
		)),
		ObservedAt: time.Date(2026, 7, 28, 18, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("ObserveSSE() error = %v", err)
	}
	if !observed ||
		classification.Kind() != runtimecore.FailureModelOverloaded {
		t.Fatalf(
			"ObserveSSE() = classification:%#v observed:%t",
			classification,
			observed,
		)
	}
}

// TestObserveCodexSSEDoesNotGuessSimilarMessages 验证相似 message 不会扩大成容量信号。
func TestObserveCodexSSEDoesNotGuessSimilarMessages(t *testing.T) {
	t.Parallel()

	classification, observed, err := ObserveSSE(sharedfailure.SSEInput{
		EventType: "response.failed",
		Data: strings.NewReader(
			`{"type":"response.failed","response":{"error":{"message":"Selected model may be at capacity. secret"}}}`,
		),
		ObservedAt: time.Date(2026, 7, 28, 18, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("ObserveSSE() error = %v", err)
	}
	if !observed ||
		classification.Kind() != runtimecore.FailureUnclassified {
		t.Fatalf(
			"ObserveSSE() = classification:%#v observed:%t",
			classification,
			observed,
		)
	}
}

// TestObserveCodexSSEClassifiesMalformedExplicitFailure 验证明确失败事件的坏 JSON 不触发 cooldown。
func TestObserveCodexSSEClassifiesMalformedExplicitFailure(t *testing.T) {
	t.Parallel()

	classification, observed, err := ObserveSSE(sharedfailure.SSEInput{
		EventType:  "response.failed",
		Data:       strings.NewReader(`{"response":`),
		ObservedAt: time.Date(2026, 7, 28, 18, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("ObserveSSE() error = %v", err)
	}
	if !observed ||
		classification.Kind() != runtimecore.FailureMalformedResponse {
		t.Fatalf(
			"ObserveSSE() = classification:%#v observed:%t",
			classification,
			observed,
		)
	}
}

// TestObserveWebSocketUsesWrappedStatusAndRetryAfter 验证 WS 错误帧中的状态与
// headers 参与低敏分类，而不是把所有 error 都猜成同一种失败。
func TestObserveWebSocketUsesWrappedStatusAndRetryAfter(t *testing.T) {
	t.Parallel()

	classification, observed, err := ObserveWebSocket(sharedfailure.SSEInput{
		EventType: "error",
		Data: strings.NewReader(`{
			"type":"error",
			"status":429,
			"error":{"code":"rate_limit_exceeded","message":"sensitive"},
			"headers":{"retry-after":"7"}
		}`),
		ObservedAt: time.Date(2026, 8, 10, 8, 0, 0, 0, time.UTC),
	})
	if err != nil || !observed {
		t.Fatalf("ObserveWebSocket() observed=%v error=%v", observed, err)
	}
	if classification.Kind() != runtimecore.FailureRateLimited ||
		classification.RetryAfter() != 7*time.Second {
		t.Fatalf("classification = %#v", classification)
	}
}

// TestObserveWebSocketConnectionStateErrorsDoNotBlockAccount 验证连接寿命和
// previous_response_id 错误不会污染账号与模型运行态。
func TestObserveWebSocketConnectionStateErrorsDoNotBlockAccount(t *testing.T) {
	t.Parallel()

	for _, code := range []string{
		"websocket_connection_limit_reached",
		"previous_response_not_found",
	} {
		classification, observed, err := ObserveWebSocket(sharedfailure.SSEInput{
			EventType: "error",
			Data: strings.NewReader(`{"type":"error","status":429,"error":{"code":"` +
				code + `"}}`),
			ObservedAt: time.Date(2026, 8, 10, 8, 0, 0, 0, time.UTC),
		})
		if err != nil || !observed {
			t.Fatalf("ObserveWebSocket(%q) observed=%v error=%v", code, observed, err)
		}
		if classification.Kind() != runtimecore.FailureUnclassified {
			t.Fatalf("ObserveWebSocket(%q) = %#v", code, classification)
		}
	}
}

// TestObserveCodexHTTPRejectsSuccessWithoutFailure 验证成功响应不能伪造失败状态。
func TestObserveCodexHTTPRejectsSuccessWithoutFailure(t *testing.T) {
	t.Parallel()

	_, err := ObserveHTTP(
		newCodexHTTPResponse(http.StatusOK, nil, `{"id":"response_1"}`),
		time.Date(2026, 7, 28, 18, 0, 0, 0, time.UTC),
	)
	if !errors.Is(err, sharedfailure.ErrNoFailureEvidence) {
		t.Fatalf(
			"ObserveHTTP(success) error = %v, want %v",
			err,
			sharedfailure.ErrNoFailureEvidence,
		)
	}
}

// newCodexHTTPResponse 创建无需真实凭据的错误响应测试替身。
func newCodexHTTPResponse(
	statusCode int,
	header http.Header,
	body string,
) *http.Response {
	if header == nil {
		header = make(http.Header)
	}
	return &http.Response{
		StatusCode: statusCode,
		Header:     header,
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}
