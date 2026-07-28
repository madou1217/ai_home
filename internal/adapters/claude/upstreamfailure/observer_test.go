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

// TestObserveClaudeHTTPReadsUnifiedRateLimitHeaders 验证真实 Claude Header 形成额度阻塞。
func TestObserveClaudeHTTPReadsUnifiedRateLimitHeaders(t *testing.T) {
	t.Parallel()

	upstream := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, _ *http.Request) {
			response.Header().Set(
				"anthropic-ratelimit-unified-status",
				"rejected",
			)
			response.Header().Set(
				"anthropic-ratelimit-unified-overage-status",
				"rejected",
			)
			response.Header().Set("Retry-After", "18000")
			response.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(
				response,
				`{"type":"error","error":{"type":"rate_limit_error","message":"secret prompt value"}}`,
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
	if classification.Kind() != runtimecore.FailureQuotaExhausted ||
		classification.RetryAfter() != 0 {
		t.Fatalf("ObserveHTTP() = %#v", classification)
	}
}

// TestObserveClaudeHTTPKeepsOverageEligibleLimitModelScoped 验证可用 overage 不会误判统一额度耗尽。
func TestObserveClaudeHTTPKeepsOverageEligibleLimitModelScoped(t *testing.T) {
	t.Parallel()

	header := make(http.Header)
	header.Set("anthropic-ratelimit-unified-status", "rejected")
	header.Set("anthropic-ratelimit-unified-overage-status", "allowed")
	header.Set("Retry-After", "300")
	classification, err := ObserveHTTP(
		newClaudeHTTPResponse(
			http.StatusTooManyRequests,
			header,
			`{"type":"error","error":{"type":"rate_limit_error"}}`,
		),
		time.Date(2026, 7, 28, 18, 0, 0, 0, time.UTC),
	)
	if err != nil {
		t.Fatalf("ObserveHTTP() error = %v", err)
	}
	if classification.Kind() != runtimecore.FailureRateLimited ||
		classification.RetryAfter() != 5*time.Minute {
		t.Fatalf("ObserveHTTP() = %#v", classification)
	}
}

// TestObserveClaudeHTTPMapsKnownEnvelopes 验证 Claude 错误 envelope 使用结构化 type/code。
func TestObserveClaudeHTTPMapsKnownEnvelopes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		statusCode int
		body       string
		want       runtimecore.FailureKind
	}{
		{
			name:       "HTTP 529",
			statusCode: 529,
			body:       `{"type":"error","error":{"type":"overloaded_error"}}`,
			want:       runtimecore.FailureModelOverloaded,
		},
		{
			name:       "OAuth Token 撤销",
			statusCode: http.StatusForbidden,
			body:       `{"type":"error","error":{"code":"oauth_token_revoked"}}`,
			want:       runtimecore.FailureReauthenticationRequired,
		},
		{
			name:       "畸形 500 使用状态兜底",
			statusCode: http.StatusInternalServerError,
			body:       `{"error":`,
			want:       runtimecore.FailureUpstreamUnavailable,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			classification, err := ObserveHTTP(
				newClaudeHTTPResponse(
					test.statusCode,
					nil,
					test.body,
				),
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

// TestObserveClaudeSSEMapsChunkedErrorEvent 验证 Claude 分块错误事件不会读取 message。
func TestObserveClaudeSSEMapsChunkedErrorEvent(t *testing.T) {
	t.Parallel()

	classification, observed, err := ObserveSSE(sharedfailure.SSEInput{
		EventType: "error",
		Data: iotest.OneByteReader(strings.NewReader(
			`{"type":"error","error":{"type":"overloaded_error","message":"secret prompt value"}}`,
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

// TestObserveClaudeSSEIgnoresNormalEvents 验证普通内容事件不会生成失败分类。
func TestObserveClaudeSSEIgnoresNormalEvents(t *testing.T) {
	t.Parallel()

	classification, observed, err := ObserveSSE(sharedfailure.SSEInput{
		EventType: "content_block_delta",
		Data: strings.NewReader(
			`{"type":"content_block_delta","delta":{"text":"secret output"}}`,
		),
		ObservedAt: time.Date(2026, 7, 28, 18, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatalf("ObserveSSE() error = %v", err)
	}
	if observed || classification.IsValid() {
		t.Fatalf(
			"ObserveSSE(normal) = classification:%#v observed:%t",
			classification,
			observed,
		)
	}
}

// TestObserveClaudeSSEClassifiesMalformedExplicitError 验证坏错误帧只产生无状态变化分类。
func TestObserveClaudeSSEClassifiesMalformedExplicitError(t *testing.T) {
	t.Parallel()

	classification, observed, err := ObserveSSE(sharedfailure.SSEInput{
		EventType:  "error",
		Data:       strings.NewReader(`{"error":`),
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

// TestObserveClaudeHTTPRejectsSuccessWithoutFailure 验证成功响应不会污染 Registry。
func TestObserveClaudeHTTPRejectsSuccessWithoutFailure(t *testing.T) {
	t.Parallel()

	_, err := ObserveHTTP(
		newClaudeHTTPResponse(
			http.StatusOK,
			nil,
			`{"type":"message","id":"message_1"}`,
		),
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

// newClaudeHTTPResponse 创建不包含真实凭据的 Claude 响应测试替身。
func newClaudeHTTPResponse(
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
