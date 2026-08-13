package messages

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

	sharedsse "github.com/madou1217/ai_home/internal/adapters/sse"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

const (
	// maxRealClaudeDiagnosticBytes 限制真实响应仅在内存保留的诊断窗口。
	maxRealClaudeDiagnosticBytes = sharedfailure.MaxErrorPayloadBytes
	// maxRealClaudeDiagnosticEvents 限制失败日志中的线事件指纹数量。
	maxRealClaudeDiagnosticEvents = 32
)

// realClaudeTransportDiagnostic 只保留 HTTP 摘要和有界内存指纹源。
type realClaudeTransportDiagnostic struct {
	client                  *http.Client
	method                  string
	endpoint                string
	statusCode              int
	mediaType               string
	redactThinkingBeta      bool
	interleavedThinkingBeta bool
	requestThinkingType     string
	requestThinkingDisplay  string
	requestReasoningEffort  string
	body                    realClaudeBodyCapture
}

// Do 透传真实请求，并让 Adapter 消费正文时同步复制有限字节。
func (transport *realClaudeTransportDiagnostic) Do(
	request *http.Request,
) (*http.Response, error) {
	transport.method = request.Method
	transport.endpoint = request.URL.Scheme + "://" +
		request.URL.Host + request.URL.EscapedPath()
	transport.captureRequestShape(request)
	response, err := transport.client.Do(request)
	if response != nil {
		transport.statusCode = response.StatusCode
		transport.mediaType = classifyRealClaudeMediaType(
			response.Header.Get("Content-Type"),
		)
		if response.Body != nil {
			response.Body = &realClaudeCaptureReadCloser{
				Reader: io.TeeReader(response.Body, &transport.body),
				Closer: response.Body,
			}
		}
	}
	return response, err
}

// requestFingerprint 只返回已知 beta 和 reasoning 枚举，不读取提示或凭据。
func (transport *realClaudeTransportDiagnostic) requestFingerprint() string {
	return fmt.Sprintf(
		"redact_beta=%t,interleaved_beta=%t,thinking_type=%s,thinking_display=%s,effort=%s",
		transport.redactThinkingBeta,
		transport.interleavedThinkingBeta,
		normalizeRealClaudeDiagnosticToken(transport.requestThinkingType),
		normalizeRealClaudeDiagnosticToken(transport.requestThinkingDisplay),
		normalizeRealClaudeDiagnosticToken(transport.requestReasoningEffort),
	)
}

// captureRequestShape 从可重放 Body 投影低敏请求形态，不消费真实网络正文。
func (transport *realClaudeTransportDiagnostic) captureRequestShape(
	request *http.Request,
) {
	betas := strings.Split(request.Header.Get("anthropic-beta"), ",")
	transport.redactThinkingBeta = hasRealClaudeBeta(betas, betaRedactThinking)
	transport.interleavedThinkingBeta = hasRealClaudeBeta(
		betas,
		betaInterleavedThinking,
	)
	if request.GetBody == nil {
		return
	}
	body, err := request.GetBody()
	if err != nil {
		return
	}
	defer func() { _ = body.Close() }()
	var payload struct {
		Thinking struct {
			Type    string `json:"type"`
			Display string `json:"display"`
		} `json:"thinking"`
		OutputConfig struct {
			Effort string `json:"effort"`
		} `json:"output_config"`
	}
	if json.NewDecoder(io.LimitReader(body, maxRealClaudeDiagnosticBytes)).Decode(
		&payload,
	) != nil {
		return
	}
	transport.requestThinkingType = payload.Thinking.Type
	transport.requestThinkingDisplay = payload.Thinking.Display
	transport.requestReasoningEffort = payload.OutputConfig.Effort
}

// hasRealClaudeBeta 对逗号分隔的官方 beta 做精确匹配。
func hasRealClaudeBeta(values []string, expected string) bool {
	for _, value := range values {
		if strings.TrimSpace(value) == expected {
			return true
		}
	}
	return false
}

// fingerprint 把响应压缩为固定字段，并立即清零正文副本。
func (transport *realClaudeTransportDiagnostic) fingerprint() []string {
	payload, truncated := transport.body.take()
	defer clear(payload)
	if len(payload) == 0 {
		return []string{"body=empty"}
	}

	var result []string
	switch transport.mediaType {
	case "text/event-stream", "missing":
		result = fingerprintRealClaudeSSE(payload)
	case "application/json":
		result = []string{fingerprintRealClaudeEnvelope("", payload)}
	default:
		result = []string{"body=not_inspected"}
	}
	if truncated {
		result = append(result, "body=truncated")
	}
	return result
}

// realClaudeCaptureReadCloser 保持原响应关闭语义。
type realClaudeCaptureReadCloser struct {
	io.Reader
	io.Closer
}

// realClaudeBodyCapture 是不会影响 Adapter 读取的有界 Writer。
type realClaudeBodyCapture struct {
	data      []byte
	truncated bool
}

// Write 最多保留固定窗口，但始终报告完整消费以保持 TeeReader 语义。
func (capture *realClaudeBodyCapture) Write(data []byte) (int, error) {
	originalLength := len(data)
	remaining := maxRealClaudeDiagnosticBytes - len(capture.data)
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
func (capture *realClaudeBodyCapture) take() ([]byte, bool) {
	payload := append([]byte(nil), capture.data...)
	clear(capture.data)
	capture.data = nil
	truncated := capture.truncated
	capture.truncated = false
	return payload, truncated
}

// classifyRealClaudeMediaType 避免把 Provider 任意 Header 原文写入日志。
func classifyRealClaudeMediaType(raw string) string {
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
	case mediaType == "application/json" || strings.HasSuffix(mediaType, "+json"):
		return "application/json"
	default:
		return "other"
	}
}

// fingerprintRealClaudeSSE 只读取事件类型和允许列出的结构字段。
func fingerprintRealClaudeSSE(payload []byte) []string {
	reader, err := sharedsse.NewReader(bytes.NewReader(payload))
	if err != nil {
		return []string{"sse=read_error"}
	}
	result := make([]string, 0, 8)
	for len(result) < maxRealClaudeDiagnosticEvents {
		event, readErr := reader.Next()
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				result = append(result, "sse=read_error")
			}
			break
		}
		result = append(
			result,
			fingerprintRealClaudeEnvelope(event.Type(), event.Data()),
		)
	}
	if len(result) == 0 {
		return []string{"sse=empty"}
	}
	return result
}

// realClaudeDiagnosticEnvelope 只声明协议结构，不保存内容文本。
type realClaudeDiagnosticEnvelope struct {
	Type         json.RawMessage `json:"type"`
	Index        json.RawMessage `json:"index"`
	Message      json.RawMessage `json:"message"`
	ContentBlock json.RawMessage `json:"content_block"`
	Delta        json.RawMessage `json:"delta"`
	Usage        json.RawMessage `json:"usage"`
	Error        json.RawMessage `json:"error"`
	Code         json.RawMessage `json:"code"`
}

// fingerprintRealClaudeEnvelope 不读取 text、thinking、signature、Token 或模型值。
func fingerprintRealClaudeEnvelope(eventType string, payload []byte) string {
	var envelope realClaudeDiagnosticEnvelope
	if json.Unmarshal(payload, &envelope) != nil {
		return "json=invalid"
	}
	message := decodeRealClaudeDiagnosticObject(envelope.Message)
	block := decodeRealClaudeDiagnosticObject(envelope.ContentBlock)
	delta := decodeRealClaudeDiagnosticObject(envelope.Delta)
	errorFields := decodeRealClaudeDiagnosticObject(envelope.Error)
	return fmt.Sprintf(
		"event=%s,type=%s,message_type=%s,role=%s,block_type=%s,delta_type=%s,stop_reason=%s,index=%s,usage=%s,error_type=%s,error_code=%s",
		normalizeRealClaudeDiagnosticToken(eventType),
		realClaudeDiagnosticToken(envelope.Type),
		realClaudeDiagnosticToken(message["type"]),
		realClaudeDiagnosticToken(message["role"]),
		realClaudeDiagnosticToken(block["type"]),
		realClaudeDiagnosticToken(delta["type"]),
		realClaudeDiagnosticToken(delta["stop_reason"]),
		realClaudeDiagnosticShape(envelope.Index),
		realClaudeUsageShape(envelope.Usage),
		realClaudeDiagnosticToken(errorFields["type"]),
		firstRealClaudeDiagnosticToken(errorFields["code"], envelope.Code),
	)
}

// decodeRealClaudeDiagnosticObject 只投影对象字段，不返回任意值。
func decodeRealClaudeDiagnosticObject(
	payload json.RawMessage,
) map[string]json.RawMessage {
	fields := make(map[string]json.RawMessage)
	_ = json.Unmarshal(payload, &fields)
	return fields
}

// firstRealClaudeDiagnosticToken 返回第一个安全且非空的标识。
func firstRealClaudeDiagnosticToken(values ...json.RawMessage) string {
	for _, value := range values {
		if token := realClaudeDiagnosticToken(value); token != "none" {
			return token
		}
	}
	return "none"
}

// realClaudeDiagnosticToken 只接受满足稳定错误标识合同的 JSON 字符串。
func realClaudeDiagnosticToken(payload json.RawMessage) string {
	var value string
	if json.Unmarshal(payload, &value) != nil {
		return "none"
	}
	return normalizeRealClaudeDiagnosticToken(value)
}

// normalizeRealClaudeDiagnosticToken 拒绝控制字符和任意长文本。
func normalizeRealClaudeDiagnosticToken(value string) string {
	normalized, valid := sharedfailure.NormalizeErrorToken(value)
	if !valid {
		return "none"
	}
	return normalized
}

// realClaudeDiagnosticShape 仅返回固定 JSON 类型名。
func realClaudeDiagnosticShape(payload json.RawMessage) string {
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

// realClaudeUsageShape 只记录已知计数字段是否存在，不记录数值。
func realClaudeUsageShape(payload json.RawMessage) string {
	fields := decodeRealClaudeDiagnosticObject(payload)
	known := []string{
		"input_tokens",
		"output_tokens",
		"cache_creation_input_tokens",
		"cache_read_input_tokens",
	}
	present := make([]string, 0, len(known))
	for _, field := range known {
		if _, found := fields[field]; found {
			present = append(present, field)
		}
	}
	if len(present) == 0 {
		return "none"
	}
	return strings.Join(present, "+")
}

// TestRealClaudeDiagnosticFingerprintDropsSensitiveValues 验证低敏指纹不泄露正文。
func TestRealClaudeDiagnosticFingerprintDropsSensitiveValues(t *testing.T) {
	t.Parallel()

	diagnostic := &realClaudeTransportDiagnostic{mediaType: "text/event-stream"}
	_, _ = diagnostic.body.Write([]byte(strings.Join([]string{
		"event: message_start",
		`data: {"type":"message_start","message":{"type":"message","role":"assistant","model":"secret-model","content":[]},"usage":{"input_tokens":3}}`,
		"",
		"event: content_block_delta",
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"secret-signature","text":"secret-text"}}`,
		"",
		"",
	}, "\n")))

	fingerprint := strings.Join(diagnostic.fingerprint(), "|")
	if !strings.Contains(fingerprint, "event=message_start") ||
		!strings.Contains(fingerprint, "delta_type=signature_delta") ||
		strings.Contains(fingerprint, "secret-model") ||
		strings.Contains(fingerprint, "secret-signature") ||
		strings.Contains(fingerprint, "secret-text") {
		t.Fatalf("低敏 Claude 指纹错误: %s", fingerprint)
	}
}

// TestRealClaudeRequestFingerprintKeepsOnlyKnownShape 验证真实请求诊断不会
// 输出提示、认证 Header 或任意正文值。
func TestRealClaudeRequestFingerprintKeepsOnlyKnownShape(t *testing.T) {
	t.Parallel()

	request, err := http.NewRequest(
		http.MethodPost,
		"https://api.anthropic.com/v1/messages",
		strings.NewReader(`{
			"messages":[{"role":"user","content":"secret-prompt"}],
			"thinking":{"type":"adaptive","display":"omitted"},
			"output_config":{"effort":"low"}
		}`),
	)
	if err != nil {
		t.Fatalf("http.NewRequest() error = %v", err)
	}
	request.Header.Set("Authorization", "Bearer secret-access-token")
	request.Header.Set(
		"anthropic-beta",
		betaInterleavedThinking+","+betaRedactThinking,
	)
	diagnostic := &realClaudeTransportDiagnostic{}
	diagnostic.captureRequestShape(request)
	fingerprint := diagnostic.requestFingerprint()
	if fingerprint != "redact_beta=true,interleaved_beta=true,thinking_type=adaptive,thinking_display=omitted,effort=low" ||
		strings.Contains(fingerprint, "secret-prompt") ||
		strings.Contains(fingerprint, "secret-access-token") {
		t.Fatalf("request fingerprint = %s", fingerprint)
	}
}

// TestRealClaudeBodyCaptureIsBounded 验证诊断窗口不会随响应增长。
func TestRealClaudeBodyCaptureIsBounded(t *testing.T) {
	t.Parallel()

	var capture realClaudeBodyCapture
	payload := bytes.Repeat([]byte("x"), maxRealClaudeDiagnosticBytes+128)
	written, err := capture.Write(payload)
	if err != nil || written != len(payload) {
		t.Fatalf("Write() = (%d,%v)", written, err)
	}
	captured, truncated := capture.take()
	defer clear(captured)
	if len(captured) != maxRealClaudeDiagnosticBytes ||
		!truncated ||
		len(capture.data) != 0 {
		t.Fatalf(
			"capture len=%d truncated=%t retained=%d",
			len(captured),
			truncated,
			len(capture.data),
		)
	}
}
