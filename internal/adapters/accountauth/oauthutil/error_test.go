package oauthutil

import (
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/accountcredentials"
)

// TestDecodeErrorCodeSupportsStringAndNestedEnvelope 验证常见 OAuth 错误信封解析。
func TestDecodeErrorCodeSupportsStringAndNestedEnvelope(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		document string
		expected string
	}{
		{
			name:     "字符串错误",
			document: `{"error":"INVALID_GRANT"}`,
			expected: "invalid_grant",
		},
		{
			name:     "嵌套错误",
			document: `{"error":{"code":"refresh_token_expired"}}`,
			expected: "refresh_token_expired",
		},
		{
			name:     "顶层错误",
			document: `{"code":"temporarily_unavailable"}`,
			expected: "temporarily_unavailable",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			actual := DecodeErrorCode(
				strings.NewReader(test.document),
				1024,
			)
			if actual != test.expected {
				t.Fatalf(
					"DecodeErrorCode() = %q, want %q",
					actual,
					test.expected,
				)
			}
		})
	}
}

// TestDecodeErrorCodeRejectsDescriptionsAndInvalidJSON 验证错误正文不会成为安全分类码。
func TestDecodeErrorCodeRejectsDescriptionsAndInvalidJSON(t *testing.T) {
	t.Parallel()

	for _, document := range []string{
		`{"error":"invalid grant contains secret"}`,
		`{"error":"invalid_grant","error":"duplicate"}`,
		`not-json`,
	} {
		if code := DecodeErrorCode(
			strings.NewReader(document),
			1024,
		); code != "" {
			t.Fatalf("DecodeErrorCode(%q) = %q", document, code)
		}
	}
}

// TestClassifyRefreshErrorSeparatesReauthRejectedAndTransient 验证刷新错误稳定分类。
func TestClassifyRefreshErrorSeparatesReauthRejectedAndTransient(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		statusCode int
		errorCode  string
		expected   error
	}{
		{
			name:       "Refresh Token 失效",
			statusCode: http.StatusBadRequest,
			errorCode:  "invalid_grant",
			expected:   accountcredentials.ErrReauthenticationRequired,
		},
		{
			name:       "客户端请求被拒绝",
			statusCode: http.StatusBadRequest,
			errorCode:  "unsupported_grant_type",
			expected:   accountcredentials.ErrRefreshRejected,
		},
		{
			name:       "上游限流",
			statusCode: http.StatusTooManyRequests,
			errorCode:  "rate_limit_exceeded",
			expected:   accountcredentials.ErrRefreshUnavailable,
		},
		{
			name:       "上游故障",
			statusCode: http.StatusServiceUnavailable,
			errorCode:  "",
			expected:   accountcredentials.ErrRefreshUnavailable,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			actual := ClassifyRefreshError(
				test.statusCode,
				test.errorCode,
			)
			if !errors.Is(actual, test.expected) {
				t.Fatalf(
					"ClassifyRefreshError() = %v, want %v",
					actual,
					test.expected,
				)
			}
		})
	}
}
