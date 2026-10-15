package codebuddyfamilyrelay

import (
	"strings"
	"testing"
)

func TestParseUpstreamErrorEnvelope(t *testing.T) {
	cases := []struct {
		name          string
		status        int
		body          string
		expectCode    int64
		expectMessage string
		expectRetry   bool
	}{
		{
			name:          "displayMsg zh wins over msg",
			status:        403,
			body:          `{"code":10085,"msg":"请求不合法","displayMsg":{"en":"bad request","zh":"请求不合法（WAF）","zh-hant":"請求不合法"}}`,
			expectCode:    10085,
			expectMessage: "请求不合法（WAF）",
			expectRetry:   true,
		},
		{
			name:          "displayMsg falls back to en",
			status:        403,
			body:          `{"code":10085,"displayMsg":{"en":"bad request"}}`,
			expectCode:    10085,
			expectMessage: "bad request",
			expectRetry:   true,
		},
		{
			name:          "msg is used when displayMsg is missing",
			status:        400,
			body:          `{"code":11128,"msg":"first message is not system prompt"}`,
			expectCode:    11128,
			expectMessage: "first message is not system prompt",
			expectRetry:   true,
		},
		{
			name:          "unknown code is not retryable",
			status:        400,
			body:          `{"code":12345,"msg":"whatever"}`,
			expectCode:    12345,
			expectMessage: "whatever",
			expectRetry:   false,
		},
		{
			name:          "missing message falls back to the code",
			status:        400,
			body:          `{"code":99999}`,
			expectCode:    99999,
			expectMessage: "upstream_code_99999",
			expectRetry:   false,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			parsed := ParseUpstreamError(testCase.status, []byte(testCase.body))
			if !parsed.Envelope {
				t.Fatal("应识别为腾讯信封")
			}
			if parsed.Code == nil || *parsed.Code != testCase.expectCode {
				t.Fatalf("code = %v，期望 %d", parsed.Code, testCase.expectCode)
			}
			if parsed.Message != testCase.expectMessage {
				t.Fatalf("message = %q，期望 %q", parsed.Message, testCase.expectMessage)
			}
			if parsed.Retryable != testCase.expectRetry {
				t.Fatalf("retryable = %v，期望 %v", parsed.Retryable, testCase.expectRetry)
			}
		})
	}
}

func TestParseUpstreamErrorNonEnvelope(t *testing.T) {
	// 非信封但有正文（openresty 的 401 HTML）：状态码 + 截断正文就是全部信息。
	html := ParseUpstreamError(401, []byte("<html><body>401 Authorization Required</body></html>"))
	if html.Envelope || html.Code != nil {
		t.Fatalf("HTML 响应不应被当成信封: %+v", html)
	}
	if !strings.Contains(html.Message, "401 Authorization Required") {
		t.Fatalf("应透出截断正文: %q", html.Message)
	}
	if html.Retryable {
		t.Fatal("401 不可换号重试")
	}
	// 5xx 即使没有信封也应可重试。
	if server := ParseUpstreamError(502, []byte("bad gateway")); !server.Retryable {
		t.Fatal("502 应可换号重试")
	}
	// 空正文：用状态码兜底文案。
	if empty := ParseUpstreamError(503, nil); empty.Message != "upstream_status_503" || !empty.Retryable {
		t.Fatalf("空正文兜底错误: %+v", empty)
	}
	// 标准 OpenAI 错误体（无 code 字段）：不是我们的信封，调用方原样透传。
	openai := ParseUpstreamError(400, []byte(`{"error":{"message":"bad tool_choice","type":"invalid_request_error"}}`))
	if openai.Envelope || openai.Message != "" || openai.Retryable {
		t.Fatalf("非信封对象应交给调用方原样处理: %+v", openai)
	}
	// 非对象正文（数组/字符串）同样按非信封处理。
	if array := ParseUpstreamError(500, []byte(`[1,2,3]`)); array.Envelope || !array.Retryable {
		t.Fatalf("数组正文应按非信封处理: %+v", array)
	}
}

func TestParseUpstreamErrorTruncatesLongBodies(t *testing.T) {
	long := strings.Repeat("x", 500)
	parsed := ParseUpstreamError(500, []byte(long))
	if len([]rune(parsed.Message)) != 300 {
		t.Fatalf("长正文应截断到 300 字符，实际 %d", len([]rune(parsed.Message)))
	}
}
