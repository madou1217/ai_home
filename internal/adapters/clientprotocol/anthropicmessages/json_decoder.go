package anthropicmessages

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

// decodeHeader 只读取判别字段，具体 DTO 随后仍执行未知字段检查。
func decodeHeader[T any](data []byte, field string) (T, error) {
	var output T
	if err := json.Unmarshal(data, &output); err != nil {
		return output, invalidField(field)
	}
	return output, nil
}

// hasJSONValue 判断可选 RawMessage 是否包含非 null JSON 值。
func hasJSONValue(value json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(value))
	return trimmed != "" && trimmed != "null"
}

// isEmptyJSONArray 判断 RawMessage 是否是明确的空数组。
func isEmptyJSONArray(value json.RawMessage) bool {
	return strings.TrimSpace(string(value)) == "[]"
}
