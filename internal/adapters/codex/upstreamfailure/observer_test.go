package upstreamfailure

import (
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
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
