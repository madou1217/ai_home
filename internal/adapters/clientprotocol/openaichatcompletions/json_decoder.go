package openaichatcompletions

import (
	"bytes"
	"encoding/json"
	"io"
	"strings"
)

// decodeStrict 将单个 JSON 值解码到 DTO，并拒绝未知字段和尾随值。
func decodeStrict[T any](data []byte, field string) (T, error) {
	var output T
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&output); err != nil {
		return output, invalidField(field)
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); err != io.EOF {
		return output, invalidField(field)
	}
	return output, nil
}

// decodeHeader 只读取判别字段，具体 DTO 随后执行严格解码。
func decodeHeader[T any](data []byte, field string) (T, error) {
	var output T
	if err := json.Unmarshal(data, &output); err != nil {
		return output, invalidField(field)
	}
	return output, nil
}

// hasJSONValue 判断 RawMessage 是否包含非 null JSON 值。
func hasJSONValue(value json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(value))
	return trimmed != "" && trimmed != "null"
}

// decodeJSONString 读取 JSON 字符串并区分其他 JSON 类型。
func decodeJSONString(value json.RawMessage) (string, bool) {
	var text string
	if len(value) == 0 || json.Unmarshal(value, &text) != nil {
		return "", false
	}
	return text, true
}
