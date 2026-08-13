package aihserver_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

// safeRealHTTPBodyDiagnostic 只提取公开协议 envelope 的固定字段和字节数。
// 任意正文、工具参数、thinking、signature、encrypted content 和 ID 均不进入日志。
func safeRealHTTPBodyDiagnostic(body string) string {
	diagnostic := struct {
		Object string `json:"object"`
		Type   string `json:"type"`
		Status string `json:"status"`
		Error  struct {
			Code string `json:"code"`
			Type string `json:"type"`
		} `json:"error"`
	}{}
	validJSON := json.Unmarshal([]byte(body), &diagnostic) == nil
	return fmt.Sprintf(
		"{bytes:%d,json:%t,object:%q,type:%q,status:%q,error_type:%q,error_code:%q}",
		len(body),
		validJSON,
		safeRealDiagnosticToken(diagnostic.Object),
		safeRealDiagnosticToken(diagnostic.Type),
		safeRealDiagnosticToken(diagnostic.Status),
		safeRealDiagnosticToken(diagnostic.Error.Type),
		safeRealDiagnosticToken(diagnostic.Error.Code),
	)
}

// safeRealDiagnosticToken 只允许验收实际使用的稳定协议枚举。
// 即使上游把任意正文塞进 code/type 字段，也只会记录 unknown。
func safeRealDiagnosticToken(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	switch value {
	case "response",
		"message",
		"chat.completion",
		"error",
		"completed",
		"in_progress",
		"failed",
		"incomplete",
		"api_error",
		"authentication_error",
		"billing_error",
		"invalid_request_error",
		"overloaded_error",
		"permission_error",
		"quota_error",
		"rate_limit_error",
		"upstream_unavailable":
		return value
	default:
		return "unknown"
	}
}

// safeRealSSEDataDiagnostic 把单个 SSE data 限制为低敏 envelope 形状。
func safeRealSSEDataDiagnostic(data []byte) string {
	return safeRealHTTPBodyDiagnostic(string(data))
}

// safeRealHTTPExchangeDiagnostic 只报告响应状态、媒体类型和低敏正文形状。
func safeRealHTTPExchangeDiagnostic(exchange httpExchange) string {
	return fmt.Sprintf(
		"{status:%d,content_type:%q,body:%s}",
		exchange.status,
		exchange.header.Get("Content-Type"),
		safeRealHTTPBodyDiagnostic(exchange.body),
	)
}

// assertRealStatus 避免通用测试辅助函数在真实验收失败时输出完整正文。
func assertRealStatus(t *testing.T, exchange httpExchange, expected int) {
	t.Helper()
	if exchange.status != expected {
		t.Fatalf(
			"status=%d want=%d response=%s",
			exchange.status,
			expected,
			safeRealHTTPExchangeDiagnostic(exchange),
		)
	}
	if exchange.header.Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", exchange.header.Get("Cache-Control"))
	}
}

// assertRealJSONStatus 是真实 JSON 成功响应的低敏快捷断言。
func assertRealJSONStatus(t *testing.T, exchange httpExchange) {
	t.Helper()
	assertRealStatus(t, exchange, http.StatusOK)
}

// decodeRealJSON 解码真实响应；失败时只打印低敏 envelope 形状。
func decodeRealJSON(t *testing.T, body string, target any) {
	t.Helper()
	if err := json.Unmarshal([]byte(body), target); err != nil {
		t.Fatalf(
			"真实 JSON 解码失败: err=%v body=%s",
			err,
			safeRealHTTPBodyDiagnostic(body),
		)
	}
}

// safeRealRawContentTypes 只提取 JSON 内容块的 type，不保留块正文。
func safeRealRawContentTypes(content []json.RawMessage) []string {
	types := make([]string, 0, len(content))
	for _, block := range content {
		var header struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(block, &header) != nil || strings.TrimSpace(header.Type) == "" {
			types = append(types, "invalid")
			continue
		}
		types = append(types, header.Type)
	}
	return types
}

// safeRealChatCompletionDiagnostic 只报告 Chat envelope 和 choice 数量。
func safeRealChatCompletionDiagnostic(document realChatCompletion) string {
	return fmt.Sprintf(
		"{id:%t,object:%q,created:%t,model:%q,choices:%d,usage:%t}",
		document.ID != "",
		document.Object,
		document.Created > 0,
		document.Model,
		len(document.Choices),
		document.Usage != nil,
	)
}

// safeRealChatChoiceDiagnostic 只报告 Chat choice 的协议形状。
func safeRealChatChoiceDiagnostic(choice realChatChoice) string {
	return fmt.Sprintf(
		"{index:%d,role:%q,content:%t,tool_calls:%d,finish_reason:%q}",
		choice.Index,
		choice.Message.Role,
		choice.Message.Content != nil,
		len(choice.Message.ToolCalls),
		choice.FinishReason,
	)
}

// safeRealChatStreamDiagnostic 只报告 Chat SSE 聚合后的低敏状态。
func safeRealChatStreamDiagnostic(result realChatStreamResult) string {
	return fmt.Sprintf(
		"{id:%t,model:%q,role:%q,content_bytes:%d,tool_id:%t,tool_name:%q,tool_arguments_bytes:%d,finish_reason:%q,usage:%t,done:%t,chunks:%d}",
		result.responseID != "",
		result.model,
		result.role,
		len(result.content),
		result.toolID != "",
		result.toolName,
		len(result.toolArguments),
		result.finishReason,
		result.usage != nil,
		result.done,
		result.chunks,
	)
}

// safeRealAnthropicMessageDiagnostic 只报告 Messages envelope 和内容块类型。
func safeRealAnthropicMessageDiagnostic(message realAnthropicMessage) string {
	stopReason := ""
	if message.StopReason != nil {
		stopReason = *message.StopReason
	}
	return fmt.Sprintf(
		"{id:%t,type:%q,role:%q,model:%q,content_types:%v,stop_reason:%q,usage_output:%t}",
		message.ID != "",
		message.Type,
		message.Role,
		message.Model,
		safeRealRawContentTypes(message.Content),
		stopReason,
		message.Usage.OutputTokens > 0,
	)
}

// safeRealAnthropicStreamDiagnostic 只报告 Messages SSE 聚合后的低敏状态。
func safeRealAnthropicStreamDiagnostic(result realAnthropicStreamResult) string {
	return fmt.Sprintf(
		"{id:%t,model:%q,role:%q,content_bytes:%d,tool_id:%t,tool_name:%q,tool_arguments_bytes:%d,stop_reason:%q,events:%v,block_types:%v,stopped:%t}",
		result.responseID != "",
		result.model,
		result.role,
		len(result.content),
		result.toolID != "",
		result.toolName,
		len(result.toolArguments),
		result.stopReason,
		result.events,
		result.blockTypes,
		result.stopped,
	)
}

// safeRealClaudeMessageDiagnostic 只报告原生 Claude Message 的 envelope 和块类型。
func safeRealClaudeMessageDiagnostic(message realClaudeMessage) string {
	return fmt.Sprintf(
		"{id:%t,type:%q,role:%q,model:%q,content_types:%v,stop_reason:%q,usage:%t}",
		message.ID != "",
		message.Type,
		message.Role,
		message.Model,
		safeRealRawContentTypes(message.Content),
		message.StopReason,
		len(message.Usage) > 0,
	)
}

// TestSafeRealDiagnosticsNeverExposeContent 锁住真实验收失败日志的低敏边界。
func TestSafeRealDiagnosticsNeverExposeContent(t *testing.T) {
	t.Parallel()

	const sensitive = "must-not-appear"
	diagnostic := safeRealHTTPBodyDiagnostic(`{
		"object":"response",
		"type":"message",
		"status":"completed",
		"output":[{"type":"reasoning","encrypted_content":"` + sensitive + `"}],
		"error":{"type":"invalid request ` + sensitive + `","code":"` + sensitive + `"},
		"signature":"` + sensitive + `"
	}`)
	if strings.Contains(diagnostic, sensitive) {
		t.Fatalf("低敏诊断泄露正文: %s", diagnostic)
	}
	for _, expected := range []string{
		`object:"response"`,
		`type:"message"`,
		`status:"completed"`,
		`error_type:"unknown"`,
		`error_code:"unknown"`,
	} {
		if !strings.Contains(diagnostic, expected) {
			t.Fatalf("低敏诊断缺少 %s: %s", expected, diagnostic)
		}
	}
}
