package openairesponses

import (
	"bytes"
	"encoding/json"
	"io"
	"unicode/utf8"
)

const (
	// maxResponseMetadataEntries 对齐 OpenAI Responses metadata 的条目上限。
	maxResponseMetadataEntries = 16
	// maxResponseMetadataKeyRunes 对齐 OpenAI Responses metadata 的键长度上限。
	maxResponseMetadataKeyRunes = 64
	// maxResponseMetadataValueRunes 对齐 OpenAI Responses metadata 的值长度上限。
	maxResponseMetadataValueRunes = 512
)

// responseProjection 保存仅属于 OpenAI Responses 客户端线协议的回显数据。
//
// 这些字段不参与模型推理、账号征召或 Provider 编码，因此不能污染 Canonical
// Request；Renderer 只在返回同一个客户端协议时使用它们。
type responseProjection struct {
	instructions json.RawMessage
	metadata     json.RawMessage
}

// defaultResponseProjection 为直接使用 Renderer 的调用方提供官方空回显形状。
func defaultResponseProjection() responseProjection {
	return responseProjection{
		instructions: json.RawMessage("null"),
		metadata:     json.RawMessage("{}"),
	}
}

// newResponseProjection 校验并复制客户端回显字段。
func newResponseProjection(wireRequest requestDTO) (responseProjection, error) {
	instructions := json.RawMessage("null")
	if hasJSONValue(wireRequest.Instructions) {
		var value string
		if err := json.Unmarshal(wireRequest.Instructions, &value); err != nil {
			return responseProjection{}, unsupportedField("instructions")
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			return responseProjection{}, invalidField("instructions")
		}
		instructions = encoded
	}

	metadata, err := decodeResponseMetadata(wireRequest.Metadata)
	if err != nil {
		return responseProjection{}, err
	}
	return responseProjection{
		instructions: instructions,
		metadata:     metadata,
	}, nil
}

// decodeResponseMetadata 严格解析有界字符串映射，并拒绝重复键和尾随值。
func decodeResponseMetadata(raw json.RawMessage) (json.RawMessage, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		return json.RawMessage("{}"), nil
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return json.RawMessage("null"), nil
	}

	decoder := json.NewDecoder(bytes.NewReader(raw))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return nil, invalidField("metadata")
	}
	values := make(map[string]string)
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, invalidField("metadata")
		}
		key, valid := keyToken.(string)
		if !valid || key == "" || utf8.RuneCountInString(key) > maxResponseMetadataKeyRunes {
			return nil, invalidField("metadata")
		}
		if _, duplicated := values[key]; duplicated {
			return nil, invalidField("metadata")
		}
		var value string
		if err := decoder.Decode(&value); err != nil ||
			utf8.RuneCountInString(value) > maxResponseMetadataValueRunes {
			return nil, invalidField("metadata")
		}
		values[key] = value
		if len(values) > maxResponseMetadataEntries {
			return nil, invalidField("metadata")
		}
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return nil, invalidField("metadata")
	}
	var trailing json.RawMessage
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, invalidField("metadata")
	}
	encoded, err := json.Marshal(values)
	if err != nil {
		return nil, invalidField("metadata")
	}
	return encoded, nil
}
