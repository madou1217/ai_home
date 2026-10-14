package upstreamrules

import (
	"encoding/json"
	"strings"
	"unicode/utf8"
)

const (
	// MaxErrorBytes 是观察上游错误正文的固定上限。
	MaxErrorBytes = 64 * 1024
	// MaxObservationBodyBytes 是参与匹配的正文文本上限。
	MaxObservationBodyBytes = 8192
	// MaxObservationTokenLength 是 code/type 字段上限。
	MaxObservationTokenLength = 1024
	// MaxObservationMessageLength 是 message 字段上限。
	MaxObservationMessageLength = 4096
)

// Observation 是一次上游失败的低敏投影，与 Node errorObservation 字段同构。
//
// 它只在本次匹配内存在：不落库、不进日志、不写运行态事件。
type Observation struct {
	httpCode int
	code     string
	typeName string
	message  string
	body     string
	payload  any
}

// HTTPCode 返回观察到的 HTTP 状态码。
func (observation Observation) HTTPCode() int { return observation.httpCode }

// Code 返回结构化错误 code。
func (observation Observation) Code() string { return observation.code }

// Type 返回结构化错误 type。
func (observation Observation) Type() string { return observation.typeName }

// Message 返回结构化错误 message。
func (observation Observation) Message() string { return observation.message }

// Body 返回截断后的错误正文文本。
func (observation Observation) Body() string { return observation.body }

// Observe 从状态码与原始错误正文构造观察投影。
//
// 第二个返回值表示是否存在失败证据：HTTP 4xx/5xx，或正文 envelope 明确声明
// type 为 error / response.failed（Codex 在 HTTP 200 的 SSE 里也可能报错）。
func Observe(statusCode int, body []byte) (Observation, bool) {
	text := ""
	var payload any
	if len(body) > 0 {
		text = truncateBytes(string(body), MaxErrorBytes)
		decoder := json.NewDecoder(strings.NewReader(text))
		decoder.UseNumber()
		if err := decoder.Decode(&payload); err != nil {
			payload = nil
		}
	}
	structured, hasStructured := asObject(payload)
	explicitFailure := hasStructured && isFailureEnvelopeType(fieldText(structured, "type"))
	failedHTTP := statusCode >= 400 && statusCode <= 599
	if !failedHTTP && !explicitFailure {
		return Observation{}, false
	}
	errorValue := extractErrorValue(structured, hasStructured)
	if text == "" && hasStructured {
		encoded, err := json.Marshal(structured)
		if err == nil {
			text = truncateBytes(string(encoded), MaxErrorBytes)
		}
	}
	observation := Observation{
		httpCode: statusCode,
		body:     truncateBytes(text, MaxObservationBodyBytes),
		payload:  payload,
	}
	switch typed := errorValue.(type) {
	case string:
		observation.message = truncateBytes(typed, MaxObservationMessageLength)
	case map[string]any:
		observation.code = truncateBytes(fieldText(typed, "code"), MaxObservationTokenLength)
		observation.typeName = truncateBytes(fieldText(typed, "type"), MaxObservationTokenLength)
		observation.message = truncateBytes(fieldText(typed, "message"), MaxObservationMessageLength)
	}
	return observation, true
}

// JSONValue 返回解析后的正文；不是 JSON 时返回原始标量或 nil。
func (observation Observation) JSONValue() any { return observation.payload }

// extractErrorValue 按 Node 的优先级取出结构化错误对象。
func extractErrorValue(structured map[string]any, ok bool) any {
	if !ok {
		return nil
	}
	response := objectField(structured, "response")
	if response != nil {
		if value := truthyField(response, "error"); value != nil {
			return value
		}
	}
	if value := truthyField(structured, "error"); value != nil {
		return value
	}
	if response != nil {
		if value := truthyField(response, "last_error"); value != nil {
			return value
		}
	}
	if value := truthyField(structured, "last_error"); value != nil {
		return value
	}
	if value := truthyField(structured, "detail"); value != nil {
		return value
	}
	return structured
}

// asObject 判断解析结果是否是 JSON 对象。
func asObject(value any) (map[string]any, bool) {
	object, ok := value.(map[string]any)
	return object, ok
}

// objectField 取出对象字段；非对象或缺失返回 nil。
func objectField(container any, key string) map[string]any {
	object, ok := container.(map[string]any)
	if !ok {
		return nil
	}
	value, ok := object[key].(map[string]any)
	if !ok {
		return nil
	}
	return value
}

// truthyField 按 JavaScript 真值语义取出对象字段。
func truthyField(container any, key string) any {
	object, ok := container.(map[string]any)
	if !ok {
		return nil
	}
	value, present := object[key]
	if !present || !truthy(value) {
		return nil
	}
	return value
}

// fieldText 把对象字段渲染为文本；缺失返回空串。
func fieldText(object map[string]any, key string) string {
	value, present := object[key]
	if !present {
		return ""
	}
	return TextOf(value)
}

// truthy 复刻 JavaScript 真值判断。
func truthy(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case float64:
		return typed != 0
	case json.Number:
		number, err := typed.Float64()
		return err == nil && number != 0
	default:
		return true
	}
}

// isFailureEnvelopeType 判断 envelope 是否明确声明失败。
func isFailureEnvelopeType(value string) bool {
	return value == "error" || value == "response.failed"
}

// truncateBytes 按字节截断文本，保证不切断 UTF-8 序列。
func truncateBytes(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	truncated := value[:limit]
	for len(truncated) > 0 && !utf8.ValidString(truncated) {
		truncated = truncated[:len(truncated)-1]
	}
	return truncated
}
