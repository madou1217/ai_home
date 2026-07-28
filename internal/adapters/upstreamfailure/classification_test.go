package upstreamfailure

import (
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// TestClassifyTransportMapsKnownSignals 验证传输层只映射已经确认的稳定事件。
func TestClassifyTransportMapsKnownSignals(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		kind TransportKind
		want runtimecore.FailureKind
	}{
		{"请求超时", TransportTimeout, runtimecore.FailureRequestTimeout},
		{"连接重置", TransportConnectionReset, runtimecore.FailureConnectionReset},
		{"流中断", TransportStreamDisconnected, runtimecore.FailureStreamDisconnected},
		{"用户取消", TransportRequestCancelled, runtimecore.FailureRequestCancelled},
		{"未知传输错误", TransportUnclassified, runtimecore.FailureUnclassified},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			classification, err := ClassifyTransport(test.kind)
			if err != nil {
				t.Fatalf("ClassifyTransport(%q) error = %v", test.kind, err)
			}
			if classification.Kind() != test.want ||
				classification.RetryAfter() != 0 ||
				!classification.IsValid() {
				t.Fatalf(
					"ClassifyTransport(%q) = %#v",
					test.kind,
					classification,
				)
			}
		})
	}
}

// TestNewClassificationRejectsInvalidCooldownHint 验证分类结果不能绕过领域等待上限。
func TestNewClassificationRejectsInvalidCooldownHint(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		kind       runtimecore.FailureKind
		retryAfter time.Duration
	}{
		{
			name:       "负等待时间",
			kind:       runtimecore.FailureRateLimited,
			retryAfter: -time.Second,
		},
		{
			name:       "超过领域上限",
			kind:       runtimecore.FailureRateLimited,
			retryAfter: runtimecore.MaxCooldownHint + time.Second,
		},
		{
			name:       "低于毫秒精度",
			kind:       runtimecore.FailureRateLimited,
			retryAfter: time.Nanosecond,
		},
		{
			name:       "硬阻塞携带冷却提示",
			kind:       runtimecore.FailureQuotaExhausted,
			retryAfter: time.Hour,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			if _, err := NewClassification(
				test.kind,
				test.retryAfter,
			); err == nil {
				t.Fatalf(
					"NewClassification(kind=%s, retryAfter=%s) error = nil",
					test.kind,
					test.retryAfter,
				)
			}
		})
	}
}

// TestNormalizeResponseInputCreatesLowSensitivityProjection 验证标识规范化且长窗口保留给 Provider 判断。
func TestNormalizeResponseInputCreatesLowSensitivityProjection(t *testing.T) {
	t.Parallel()

	response, err := NormalizeResponseInput(ResponseInput{
		StatusCode: 429,
		ErrorType:  "RATE_LIMIT_ERROR",
		ErrorCode:  "RATE_LIMIT_EXCEEDED",
		RetryAfter: runtimecore.MaxCooldownHint + time.Hour,
	})
	if err != nil {
		t.Fatalf("NormalizeResponseInput() error = %v", err)
	}
	if response.StatusCode() != 429 ||
		response.ErrorType() != "rate_limit_error" ||
		response.ErrorCode() != "rate_limit_exceeded" ||
		response.RetryAfter() != runtimecore.MaxCooldownHint+time.Hour {
		t.Fatalf("NormalizeResponseInput() = %#v", response)
	}
}

// TestClassifyTransportRejectsUnknownKind 验证共享传输分类器采用失败关闭策略。
func TestClassifyTransportRejectsUnknownKind(t *testing.T) {
	t.Parallel()

	if _, err := ClassifyTransport(TransportKind("dns_error")); err == nil {
		t.Fatal("ClassifyTransport(unknown) error = nil")
	}
}

// TestNormalizeResponseInputRejectsUnsafeTokens 验证响应分类入口不接受原始错误正文。
func TestNormalizeResponseInputRejectsUnsafeTokens(t *testing.T) {
	t.Parallel()

	for _, input := range []ResponseInput{
		{StatusCode: 199},
		{StatusCode: 600},
		{StatusCode: 429, ErrorType: "rate_limit_error\nsecret"},
		{StatusCode: 429, ErrorCode: "bad code"},
		{StatusCode: 429, RetryAfter: -time.Second},
	} {
		if _, err := NormalizeResponseInput(input); err == nil {
			t.Fatalf("NormalizeResponseInput(%#v) error = nil", input)
		}
	}
}
