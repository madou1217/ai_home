package responses

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/core/inference"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

const (
	// maxRealCodexDiagnosticBytes 限制真实响应仅在内存保留的诊断窗口。
	maxRealCodexDiagnosticBytes = sharedfailure.MaxErrorPayloadBytes
	// maxRealCodexDiagnosticEvents 限制失败日志中的线事件指纹数量。
	maxRealCodexDiagnosticEvents = 32
)

// realCodexTransportDiagnostic 只保留 HTTP 状态、媒体类型和有界内存指纹源。
type realCodexTransportDiagnostic struct {
	client     *http.Client
	statusCode int
	mediaType  string
	body       realCodexBodyCapture
}

// Do 委托真实传输，并让 Adapter 消费正文时同步复制有限字节。
func (diagnostic *realCodexTransportDiagnostic) Do(
	request *http.Request,
) (*http.Response, error) {
	response, err := diagnostic.client.Do(request)
	if response == nil {
		return response, err
	}
	diagnostic.statusCode = response.StatusCode
	diagnostic.mediaType = classifyRealCodexMediaType(
		response.Header.Get("Content-Type"),
	)
	if response.Body != nil {
		response.Body = &realCodexCaptureReadCloser{
			Reader: io.TeeReader(response.Body, &diagnostic.body),
			Closer: response.Body,
		}
	}
	return response, err
}

// fingerprint 把响应压缩成固定字段；正文副本在生成后立即清零。
func (diagnostic *realCodexTransportDiagnostic) fingerprint() []string {
	payload, truncated := diagnostic.body.take()
	defer clear(payload)
	if len(payload) == 0 {
		return []string{"body=empty"}
	}

	var result []string
	switch diagnostic.mediaType {
	case "text/event-stream", "missing":
		result = fingerprintRealCodexSSE(payload)
	case "application/json":
		result = []string{fingerprintRealCodexJSON(payload)}
	default:
		result = []string{"body=not_inspected"}
	}
	if truncated {
		result = append(result, "body=truncated")
	}
	return result
}

// realCodexCaptureReadCloser 保持原响应关闭语义。
type realCodexCaptureReadCloser struct {
	io.Reader
	io.Closer
}

// realCodexBodyCapture 是不会影响上游读取的有界 Writer。
type realCodexBodyCapture struct {
	data      []byte
	truncated bool
}

// Write 最多保留固定窗口，但始终报告完整消费以保持 TeeReader 语义。
func (capture *realCodexBodyCapture) Write(data []byte) (int, error) {
	originalLength := len(data)
	remaining := maxRealCodexDiagnosticBytes - len(capture.data)
	if remaining <= 0 {
		capture.truncated = capture.truncated || originalLength > 0
		return originalLength, nil
	}
	if len(data) > remaining {
		capture.data = append(capture.data, data[:remaining]...)
		capture.truncated = true
		return originalLength, nil
	}
	capture.data = append(capture.data, data...)
	return originalLength, nil
}

// take 转移有界响应副本并清除长期引用。
func (capture *realCodexBodyCapture) take() ([]byte, bool) {
	payload := append([]byte(nil), capture.data...)
	clear(capture.data)
	capture.data = nil
	truncated := capture.truncated
	capture.truncated = false
	return payload, truncated
}

// classifyRealCodexMediaType 避免把 Provider 任意 Header 原文写入日志。
func classifyRealCodexMediaType(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return "missing"
	}
	mediaType, _, err := mime.ParseMediaType(raw)
	if err != nil {
		return "invalid"
	}
	switch {
	case mediaType == "text/event-stream":
		return "text/event-stream"
	case mediaType == "application/json" ||
		strings.HasSuffix(mediaType, "+json"):
		return "application/json"
	default:
		return "other"
	}
}

// fingerprintRealCodexSSE 只读取事件名和已知状态/错误代码。
func fingerprintRealCodexSSE(payload []byte) []string {
	reader := newSSEReader(bytes.NewReader(payload))
	result := make([]string, 0, 8)
	for len(result) < maxRealCodexDiagnosticEvents {
		event, err := reader.Next()
		if err != nil {
			if !errors.Is(err, io.EOF) {
				result = append(result, "sse=read_error")
			}
			break
		}
		if bytes.Equal(bytes.TrimSpace(event.data), []byte("[DONE]")) {
			result = append(result, "sse=done")
			continue
		}
		result = append(
			result,
			fingerprintRealCodexEnvelope(event.eventType, event.data),
		)
	}
	if len(result) == 0 {
		return []string{"sse=empty"}
	}
	return result
}

// fingerprintRealCodexJSON 处理非流式 JSON 响应。
func fingerprintRealCodexJSON(payload []byte) string {
	return fingerprintRealCodexEnvelope("", payload)
}

// realCodexDiagnosticEnvelope 使用 RawMessage 保留字段类型，避免诊断 DTO
// 因 Provider 返回字符串 detail 等合法 JSON 形态而整体解码失败。
type realCodexDiagnosticEnvelope struct {
	Type     json.RawMessage `json:"type"`
	Code     json.RawMessage `json:"code"`
	Error    json.RawMessage `json:"error"`
	Detail   json.RawMessage `json:"detail"`
	Response json.RawMessage `json:"response"`
}

// fingerprintRealCodexEnvelope 不读取 message、模型、账号或响应正文。
func fingerprintRealCodexEnvelope(
	eventType string,
	payload []byte,
) string {
	var envelope realCodexDiagnosticEnvelope
	if json.Unmarshal(payload, &envelope) != nil {
		return "json=invalid"
	}
	responseFields := decodeRealCodexDiagnosticObject(envelope.Response)
	errorPayload := firstRealCodexDiagnosticValue(
		responseFields["error"],
		envelope.Error,
		envelope.Detail,
	)
	errorFields := decodeRealCodexDiagnosticObject(errorPayload)
	errorCode := firstRealCodexDiagnosticToken(
		errorFields["code"],
		envelope.Code,
	)
	errorText := firstRealCodexDiagnosticValue(
		errorFields["message"],
		errorPayload,
	)
	return fmt.Sprintf(
		"event=%s,type=%s,status=%s,error_shape=%s,error_type=%s,error_code=%s,error_param=%s,error_token=%s,error_class=%s,error_field=%s",
		normalizeRealCodexDiagnosticToken(eventType),
		realCodexDiagnosticToken(envelope.Type),
		realCodexDiagnosticToken(responseFields["status"]),
		realCodexDiagnosticShape(errorPayload),
		realCodexDiagnosticToken(errorFields["type"]),
		errorCode,
		realCodexDiagnosticToken(errorFields["param"]),
		realCodexDiagnosticToken(errorPayload),
		classifyRealCodexDiagnosticError(errorText),
		findRealCodexDiagnosticField(errorText),
	)
}

// decodeRealCodexDiagnosticObject 只投影对象字段，不返回任意值。
func decodeRealCodexDiagnosticObject(
	payload json.RawMessage,
) map[string]json.RawMessage {
	fields := make(map[string]json.RawMessage)
	if json.Unmarshal(payload, &fields) != nil {
		return fields
	}
	return fields
}

// firstRealCodexDiagnosticValue 返回第一个存在且非 null 的候选字段。
func firstRealCodexDiagnosticValue(
	values ...json.RawMessage,
) json.RawMessage {
	for _, value := range values {
		trimmed := bytes.TrimSpace(value)
		if len(trimmed) != 0 && !bytes.Equal(trimmed, []byte("null")) {
			return value
		}
	}
	return nil
}

// firstRealCodexDiagnosticToken 返回第一个满足低敏标识合同的字符串。
func firstRealCodexDiagnosticToken(
	values ...json.RawMessage,
) string {
	for _, value := range values {
		if token := realCodexDiagnosticToken(value); token != "none" {
			return token
		}
	}
	return "none"
}

// realCodexDiagnosticToken 只接受 JSON 字符串并复用稳定标识归一化。
func realCodexDiagnosticToken(payload json.RawMessage) string {
	var value string
	if json.Unmarshal(payload, &value) != nil {
		return "none"
	}
	return normalizeRealCodexDiagnosticToken(value)
}

// realCodexDiagnosticShape 只返回固定 JSON 类型名。
func realCodexDiagnosticShape(payload json.RawMessage) string {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 {
		return "missing"
	}
	switch trimmed[0] {
	case '{':
		return "object"
	case '[':
		return "array"
	case '"':
		return "string"
	case 't', 'f':
		return "boolean"
	case 'n':
		return "null"
	default:
		return "number"
	}
}

// classifyRealCodexDiagnosticError 只把 Provider 文本归入固定诊断类别。
func classifyRealCodexDiagnosticError(payload json.RawMessage) string {
	text := realCodexDiagnosticText(payload)
	switch {
	case text == "":
		return "none"
	case strings.Contains(text, "malformed response"):
		return "malformed_response"
	case isUnsupportedSystemRoleDiagnostic(text):
		return "unsupported_system_role"
	case strings.Contains(text, "required") ||
		strings.Contains(text, "missing"):
		return "missing_required_field"
	case strings.Contains(text, "invalid") ||
		strings.Contains(text, "unsupported"):
		return "invalid_field"
	default:
		return "other"
	}
}

// findRealCodexDiagnosticField 只返回已知协议字段名，避免泄露正文。
func findRealCodexDiagnosticField(payload json.RawMessage) string {
	text := realCodexDiagnosticText(payload)
	if isUnsupportedSystemRoleDiagnostic(text) {
		return "role"
	}
	fields := []string{
		"client_metadata",
		"prompt_cache_key",
		"parallel_tool_calls",
		"tool_choice",
		"instructions",
		"reasoning",
		"session-id",
		"thread-id",
		"input",
		"model",
		"text",
		"tools",
	}
	for _, field := range fields {
		if strings.Contains(text, field) {
			return field
		}
	}
	return "none"
}

// isUnsupportedSystemRoleDiagnostic 只识别已经由真实上游或固定测试确认的
// system 角色拒绝签名，不返回 Provider 任意错误正文。
func isUnsupportedSystemRoleDiagnostic(text string) bool {
	return text == "system messages are not allowed" ||
		strings.Contains(text, "system") &&
			strings.Contains(text, "developer") &&
			(strings.Contains(text, "supported") ||
				strings.Contains(text, "unsupported"))
}

// realCodexDiagnosticText 只在内存解码字符串并统一大小写。
func realCodexDiagnosticText(payload json.RawMessage) string {
	var value string
	if json.Unmarshal(payload, &value) != nil {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(value))
}

// normalizeRealCodexDiagnosticToken 拒绝不能作为稳定标识的 Provider 值。
func normalizeRealCodexDiagnosticToken(value string) string {
	if strings.TrimSpace(value) == "Malformed response" {
		return "malformed_response"
	}
	normalized, valid := sharedfailure.NormalizeErrorToken(value)
	if !valid {
		return "none"
	}
	return normalized
}

// realCodexResponseFailure 提取 Canonical 失败终态中的低敏字段。
func realCodexResponseFailure(
	events []inference.StreamEvent,
) (string, string, bool) {
	for index := len(events) - 1; index >= 0; index-- {
		failed, valid := events[index].(inference.ResponseFailedEvent)
		if !valid {
			continue
		}
		failure := failed.Failure()
		return failure.Code(), failure.SafeMessage(), failure.Retryable()
	}
	return "none", "", false
}

// realCodexAttemptFailure 提取运行态分类和有限恢复提示。
func realCodexAttemptFailure(
	failures []inferencegateway.AttemptFailure,
) (string, time.Duration) {
	if len(failures) == 0 {
		return "none", 0
	}
	failure := failures[len(failures)-1]
	return string(failure.RuntimeKind()), failure.RetryAfter()
}

func TestRealCodexDiagnosticFingerprintDropsSensitiveValues(t *testing.T) {
	diagnostic := &realCodexTransportDiagnostic{
		mediaType: "text/event-stream",
	}
	_, _ = diagnostic.body.Write([]byte(strings.Join([]string{
		"event: response.created",
		`data: {"type":"response.created","response":{"status":"in_progress"}}`,
		"",
		"event: response.failed",
		`data: {"type":"response.failed","response":{"status":"failed","error":{"type":"server_error","code":"malformed_response","message":"secret-response-body"}}}`,
		"",
		"",
	}, "\n")))

	fingerprint := strings.Join(diagnostic.fingerprint(), "|")
	if !strings.Contains(fingerprint, "event=response.failed") ||
		!strings.Contains(fingerprint, "error_code=malformed_response") ||
		strings.Contains(fingerprint, "secret-response-body") {
		t.Fatalf("低敏响应指纹错误: %s", fingerprint)
	}
}

func TestRealCodexDiagnosticFingerprintAcceptsStringDetail(t *testing.T) {
	fingerprint := fingerprintRealCodexJSON(
		[]byte(
			`{"detail":"Missing required parameter: prompt_cache_key"}`,
		),
	)
	if !strings.Contains(fingerprint, "error_shape=string") ||
		!strings.Contains(
			fingerprint,
			"error_class=missing_required_field",
		) ||
		!strings.Contains(fingerprint, "error_field=prompt_cache_key") ||
		strings.Contains(fingerprint, "Missing required parameter") {
		t.Fatalf("字符串 detail 指纹错误: %s", fingerprint)
	}
}

// TestRealCodexDiagnosticFingerprintClassifiesUnsupportedSystemRole 验证诊断
// 只暴露固定角色类别，不回显上游任意错误正文。
func TestRealCodexDiagnosticFingerprintClassifiesUnsupportedSystemRole(
	t *testing.T,
) {
	for _, detail := range []string{
		"System messages are not allowed",
		"Unsupported value: 'system'. Supported values are: 'user', 'assistant', and 'developer'.",
	} {
		payload, err := json.Marshal(map[string]string{"detail": detail})
		if err != nil {
			t.Fatalf("json.Marshal() error = %v", err)
		}
		fingerprint := fingerprintRealCodexJSON(payload)
		if !strings.Contains(
			fingerprint,
			"error_class=unsupported_system_role",
		) || !strings.Contains(fingerprint, "error_field=role") ||
			strings.Contains(fingerprint, detail) {
			t.Fatalf("system 角色诊断指纹错误: %s", fingerprint)
		}
	}
}

func TestRealCodexBodyCaptureIsBounded(t *testing.T) {
	var capture realCodexBodyCapture
	payload := bytes.Repeat(
		[]byte("x"),
		maxRealCodexDiagnosticBytes+128,
	)
	written, err := capture.Write(payload)
	if err != nil || written != len(payload) {
		t.Fatalf("Write() = (%d,%v)", written, err)
	}
	captured, truncated := capture.take()
	defer clear(captured)
	if len(captured) != maxRealCodexDiagnosticBytes ||
		!truncated ||
		len(capture.data) != 0 {
		t.Fatalf(
			"capture = bytes:%d truncated:%t retained:%d",
			len(captured),
			truncated,
			len(capture.data),
		)
	}
}
