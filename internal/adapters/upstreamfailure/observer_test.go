package upstreamfailure

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"syscall"
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// TestParseRetryAfter 验证标准秒数和 HTTP 日期都转换为毫秒精度等待时间。
func TestParseRetryAfter(t *testing.T) {
	t.Parallel()

	observedAt := time.Date(2026, 7, 28, 18, 0, 0, 123_000_000, time.UTC)
	tests := []struct {
		name      string
		value     string
		want      time.Duration
		wantValid bool
	}{
		{
			name:      "秒数",
			value:     "120",
			want:      2 * time.Minute,
			wantValid: true,
		},
		{
			name:      "HTTP 日期",
			value:     "Tue, 28 Jul 2026 18:02:00 GMT",
			want:      119*time.Second + 877*time.Millisecond,
			wantValid: true,
		},
		{
			name:      "已经到期",
			value:     "Tue, 28 Jul 2026 17:59:00 GMT",
			want:      0,
			wantValid: true,
		},
		{
			name:      "空值",
			value:     "",
			wantValid: false,
		},
		{
			name:      "小数不符合协议",
			value:     "1.5",
			wantValid: false,
		},
		{
			name:      "负数不符合协议",
			value:     "-1",
			wantValid: false,
		},
		{
			name:      "控制字符",
			value:     "120\nsecret",
			wantValid: false,
		},
		{
			name:      "溢出",
			value:     "999999999999999999999999",
			wantValid: false,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			got, valid := ParseRetryAfter(test.value, observedAt)
			if got != test.want || valid != test.wantValid {
				t.Fatalf(
					"ParseRetryAfter(%q) = (%s, %t), want (%s, %t)",
					test.value,
					got,
					valid,
					test.want,
					test.wantValid,
				)
			}
		})
	}
}

// TestDecodeErrorPayloadEnforcesBoundedJSON 验证错误正文只在固定上限内短暂解析。
func TestDecodeErrorPayloadEnforcesBoundedJSON(t *testing.T) {
	t.Parallel()

	var decoded struct {
		Error struct {
			Type string `json:"type"`
		} `json:"error"`
	}
	if err := DecodeErrorPayload(
		strings.NewReader(`{"error":{"type":"rate_limit_error"}}`),
		&decoded,
	); err != nil {
		t.Fatalf("DecodeErrorPayload(valid) error = %v", err)
	}
	if decoded.Error.Type != "rate_limit_error" {
		t.Fatalf("decoded error type = %q", decoded.Error.Type)
	}

	oversized := strings.NewReader(
		`{"error":"` +
			strings.Repeat("x", MaxErrorPayloadBytes) +
			`"}`,
	)
	if err := DecodeErrorPayload(oversized, &decoded); !errors.Is(
		err,
		ErrErrorPayloadTooLarge,
	) {
		t.Fatalf(
			"DecodeErrorPayload(oversized) error = %v, want %v",
			err,
			ErrErrorPayloadTooLarge,
		)
	}
}

// TestNormalizeErrorTokenDropsUnsafeValues 验证 Observer 不能把 message 冒充稳定错误标识。
func TestNormalizeErrorTokenDropsUnsafeValues(t *testing.T) {
	t.Parallel()

	if token, ok := NormalizeErrorToken("RATE_LIMIT_ERROR"); !ok ||
		token != "rate_limit_error" {
		t.Fatalf("NormalizeErrorToken(safe) = (%q, %t)", token, ok)
	}
	for _, value := range []string{
		"",
		"rate limit error",
		"rate_limit_error\nsecret",
		strings.Repeat("x", 81),
	} {
		if token, ok := NormalizeErrorToken(value); ok || token != "" {
			t.Fatalf(
				"NormalizeErrorToken(%q) = (%q, %t)",
				value,
				token,
				ok,
			)
		}
	}
}

// TestClassifyTransportErrorUsesStableGoErrors 验证传输分类不依赖错误消息文本。
func TestClassifyTransportErrorUsesStableGoErrors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		err  error
		want runtimecore.FailureKind
	}{
		{
			name: "用户取消",
			err:  fmt.Errorf("wrapped: %w", context.Canceled),
			want: runtimecore.FailureRequestCancelled,
		},
		{
			name: "上下文超时",
			err:  fmt.Errorf("wrapped: %w", context.DeadlineExceeded),
			want: runtimecore.FailureRequestTimeout,
		},
		{
			name: "网络超时接口",
			err:  observerTimeoutError{},
			want: runtimecore.FailureRequestTimeout,
		},
		{
			name: "连接重置",
			err:  fmt.Errorf("wrapped: %w", syscall.ECONNRESET),
			want: runtimecore.FailureConnectionReset,
		},
		{
			name: "未知错误",
			err:  errors.New("opaque transport failure"),
			want: runtimecore.FailureUnclassified,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			classification, err := ClassifyTransportError(test.err)
			if err != nil {
				t.Fatalf("ClassifyTransportError() error = %v", err)
			}
			if classification.Kind() != test.want ||
				!classification.IsValid() {
				t.Fatalf(
					"ClassifyTransportError() = %#v",
					classification,
				)
			}
		})
	}
}

// TestClassifyIncompleteStreamPreservesKnownCause 验证未完成流优先保留已知原因。
func TestClassifyIncompleteStreamPreservesKnownCause(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		err  error
		want runtimecore.FailureKind
	}{
		{
			name: "无底层错误但缺少完成事件",
			err:  nil,
			want: runtimecore.FailureStreamDisconnected,
		},
		{
			name: "提前 EOF",
			err:  io.ErrUnexpectedEOF,
			want: runtimecore.FailureStreamDisconnected,
		},
		{
			name: "用户取消",
			err:  context.Canceled,
			want: runtimecore.FailureRequestCancelled,
		},
		{
			name: "连接重置",
			err:  syscall.ECONNRESET,
			want: runtimecore.FailureConnectionReset,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			classification, err := ClassifyIncompleteStream(test.err)
			if err != nil {
				t.Fatalf("ClassifyIncompleteStream() error = %v", err)
			}
			if classification.Kind() != test.want {
				t.Fatalf(
					"ClassifyIncompleteStream() kind = %s, want %s",
					classification.Kind(),
					test.want,
				)
			}
		})
	}
}

// observerTimeoutError 是不携带 Provider 文本的 net.Error 测试替身。
type observerTimeoutError struct{}

// Error 实现 error，仅提供固定测试说明。
func (observerTimeoutError) Error() string {
	return "timeout"
}

// Timeout 实现 net.Error 的超时判定。
func (observerTimeoutError) Timeout() bool {
	return true
}

// Temporary 保留旧 net.Error 合同，分类器不会依赖该值。
func (observerTimeoutError) Temporary() bool {
	return false
}

// TestSSEInputKeepsOnlyObserverDependencies 验证 SSE DTO 不要求完整 HTTP Response。
func TestSSEInputKeepsOnlyObserverDependencies(t *testing.T) {
	t.Parallel()

	input := SSEInput{
		EventType: "error",
		Data:      strings.NewReader(`{"type":"error"}`),
		Header: http.Header{
			"Retry-After": []string{"5"},
		},
		ObservedAt: time.Date(2026, 7, 28, 18, 0, 0, 0, time.UTC),
	}
	if input.EventType != "error" ||
		input.Data == nil ||
		input.Header.Get("Retry-After") != "5" ||
		input.ObservedAt.IsZero() {
		t.Fatalf("SSEInput = %#v", input)
	}
}
