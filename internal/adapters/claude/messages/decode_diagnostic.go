package messages

import (
	"bytes"
	"encoding/json"
	"fmt"
)

// decodeDiagnosticError 只保存 Claude SSE 的结构类别和状态机位置。
// 任意正文、工具参数、thinking、signature 和 Token 都不会进入该值。
type decodeDiagnosticError struct {
	eventType     string
	payloadType   string
	blockType     string
	deltaType     string
	indexShape    string
	inputShape    string
	partialJSON   string
	started       bool
	terminal      bool
	stopObserved  bool
	blockCount    int
	openBlockType string
}

// Error 返回可以安全写入服务日志的固定字段诊断。
func (err decodeDiagnosticError) Error() string {
	return fmt.Sprintf(
		"Claude Messages upstream decode rejected: event=%s payload=%s block=%s delta=%s index=%s input=%s partial_json=%s started=%t terminal=%t stop_observed=%t blocks=%d open_block=%s",
		err.eventType,
		err.payloadType,
		err.blockType,
		err.deltaType,
		err.indexShape,
		err.inputShape,
		err.partialJSON,
		err.started,
		err.terminal,
		err.stopObserved,
		err.blockCount,
		err.openBlockType,
	)
}

// Unwrap 保留稳定的上游结构错误分类。
func (decodeDiagnosticError) Unwrap() error {
	return ErrInvalidUpstreamResponse
}

// decodeDiagnosticEnvelope 只声明诊断所需的判别字段。
type decodeDiagnosticEnvelope struct {
	Type         string          `json:"type"`
	Index        json.RawMessage `json:"index"`
	ContentBlock struct {
		Type  string          `json:"type"`
		Input json.RawMessage `json:"input"`
	} `json:"content_block"`
	Delta struct {
		Type        string          `json:"type"`
		PartialJSON json.RawMessage `json:"partial_json"`
	} `json:"delta"`
}

// newDecodeDiagnosticError 从失败事件提取固定类别，不保留任意字段值。
func newDecodeDiagnosticError(
	decoder *responseDecoder,
	eventType string,
	payload []byte,
) error {
	diagnostic := decodeDiagnosticError{
		eventType:     safeDecodeToken(eventType, decodeEventTypes),
		payloadType:   "invalid",
		blockType:     "none",
		deltaType:     "none",
		indexShape:    "missing",
		inputShape:    "missing",
		partialJSON:   "missing",
		openBlockType: "none",
	}
	var envelope decodeDiagnosticEnvelope
	if json.Unmarshal(payload, &envelope) == nil {
		diagnostic.payloadType = safeDecodeToken(envelope.Type, decodeEventTypes)
		diagnostic.blockType = safeDecodeToken(envelope.ContentBlock.Type, decodeBlockTypes)
		diagnostic.deltaType = safeDecodeToken(envelope.Delta.Type, decodeDeltaTypes)
		diagnostic.indexShape = decodeJSONShape(envelope.Index)
		diagnostic.inputShape = decodeJSONObjectShape(envelope.ContentBlock.Input)
		diagnostic.partialJSON = decodeJSONStringPresence(envelope.Delta.PartialJSON)
	}
	if decoder != nil {
		diagnostic.started = decoder.started
		diagnostic.terminal = decoder.terminal
		diagnostic.stopObserved = decoder.stopObserved
		diagnostic.blockCount = len(decoder.blocks)
		if decoder.hasOpenBlock() {
			diagnostic.openBlockType = safeDecodeToken(
				decoder.blocks[len(decoder.blocks)-1].wireType,
				decodeBlockTypes,
			)
		}
	}
	return diagnostic
}

var (
	decodeEventTypes = map[string]struct{}{
		"message": {}, "ping": {}, "message_start": {},
		"content_block_start": {}, "content_block_delta": {},
		"content_block_stop": {}, "message_delta": {}, "message_stop": {},
	}
	decodeBlockTypes = map[string]struct{}{
		"text": {}, "thinking": {}, "redacted_thinking": {},
		"tool_use": {}, "server_tool_use": {}, "web_search_tool_result": {},
	}
	decodeDeltaTypes = map[string]struct{}{
		"text_delta": {}, "thinking_delta": {}, "signature_delta": {},
		"input_json_delta": {}, "citations_delta": {}, "message_delta": {},
	}
)

// safeDecodeToken 只允许日志白名单中的协议判别值。
func safeDecodeToken(value string, allowed map[string]struct{}) string {
	if value == "" {
		return "none"
	}
	if _, found := allowed[value]; found {
		return value
	}
	return "unknown"
}

// decodeJSONShape 返回固定 JSON 类型，不解析字段值。
func decodeJSONShape(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
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

// decodeJSONObjectShape 区分缺失、空对象、非空对象和其他 JSON 类型。
func decodeJSONObjectShape(raw json.RawMessage) string {
	if len(bytes.TrimSpace(raw)) == 0 {
		return "missing"
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil {
		return decodeJSONShape(raw)
	}
	if len(object) == 0 {
		return "empty_object"
	}
	return "nonempty_object"
}

// decodeJSONStringPresence 只记录 JSON 字符串是否为空。
func decodeJSONStringPresence(raw json.RawMessage) string {
	if len(bytes.TrimSpace(raw)) == 0 {
		return "missing"
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return "not_string"
	}
	if value == "" {
		return "empty"
	}
	return "nonempty"
}
