package messages

import (
	"encoding/base64"
	"encoding/binary"
	"strings"
	"unicode/utf8"
)

const maxClaudeThinkingSignatureBytes = 32 * 1024 * 1024

var claudeSignaturePrefixes = map[string]struct{}{
	"anthropic":       {},
	"cais":            {},
	"ccmax":           {},
	"claude":          {},
	"claude-cais":     {},
	"claude-code-max": {},
	"claude_cais":     {},
	"claude_code_max": {},
}

// normalizeClaudeThinkingSignature 校验 Responses opaque carrier 是否确实
// 来自 Claude，并返回 Claude Messages 上游需要的原生单层签名。
func normalizeClaudeThinkingSignature(raw string) (string, bool) {
	payload, ok := unwrapClaudeSignature(raw)
	if !ok || len(payload) > maxClaudeThinkingSignatureBytes {
		return "", false
	}

	switch payload[0] {
	case 'C':
		if !isClaudeCAISSignature(payload) {
			return "", false
		}
		return payload, true
	case 'E':
		if !isClassicClaudeSignature(payload) {
			return "", false
		}
		return payload, true
	case 'R':
		inner, err := base64.StdEncoding.DecodeString(payload)
		if err != nil || len(inner) == 0 || inner[0] != 'E' ||
			!isClassicClaudeSignature(string(inner)) {
			return "", false
		}
		return string(inner), true
	default:
		return "", false
	}
}

// unwrapClaudeSignature 只接受 CPA 明确声明的 Claude cache prefix。
func unwrapClaudeSignature(raw string) (string, bool) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", false
	}
	prefix, payload, found := strings.Cut(trimmed, "#")
	if !found {
		return trimmed, true
	}
	if _, ok := claudeSignaturePrefixes[strings.ToLower(strings.TrimSpace(prefix))]; !ok {
		return "", false
	}
	payload = strings.TrimSpace(payload)
	return payload, payload != "" && !strings.Contains(payload, "#")
}

// isClassicClaudeSignature 校验 E-form 的嵌套 protobuf 结构。
func isClassicClaudeSignature(signature string) bool {
	payload, err := base64.StdEncoding.DecodeString(signature)
	if err != nil || len(payload) == 0 || payload[0] != 0x12 {
		return false
	}
	container, ok := protobufBytesField(payload, 2)
	if !ok {
		return false
	}
	channel, ok := protobufBytesField(container, 1)
	if !ok {
		return false
	}
	return validateClassicClaudeChannel(channel)
}

// validateClassicClaudeChannel 要求 Claude routing channel 存在，并校验
// 已知字段的 wire type，避免把 Gemini/GPT opaque 数据误判为 Claude。
func validateClassicClaudeChannel(channel []byte) bool {
	hasChannelID := false
	return walkProtobuf(channel, func(field protobufField) bool {
		switch field.number {
		case 1:
			if field.wireType != protobufVarint {
				return false
			}
			hasChannelID = true
		case 2, 3, 7:
			return field.wireType == protobufVarint
		case 5:
			return field.wireType == protobufBytes
		case 6:
			return field.wireType == protobufBytes && utf8.Valid(field.bytesValue)
		}
		return true
	}) && hasChannelID
}

// isClaudeCAISSignature 校验 Claude 新模型使用的 C-form CAIS envelope。
func isClaudeCAISSignature(signature string) bool {
	payload, err := base64.StdEncoding.DecodeString(signature)
	if err != nil || len(payload) == 0 || payload[0] != 0x08 {
		return false
	}
	container, ok := protobufBytesField(payload, 2)
	if !ok {
		return false
	}
	channel, ok := protobufBytesField(container, 1)
	if !ok {
		return false
	}
	return validateClaudeCAISChannel(channel)
}

// validateClaudeCAISChannel 校验 CAIS 用于 Provider 归属判断的必需字段。
func validateClaudeCAISChannel(channel []byte) bool {
	hasChannelID := false
	hasSignature := false
	hasModel := false
	valid := walkProtobuf(channel, func(field protobufField) bool {
		switch field.number {
		case 1:
			if field.wireType != protobufVarint {
				return false
			}
			hasChannelID = true
		case 3, 7:
			return field.wireType == protobufVarint
		case 5:
			if field.wireType != protobufBytes || len(field.bytesValue) == 0 {
				return false
			}
			hasSignature = true
		case 6:
			if field.wireType != protobufBytes ||
				!utf8.Valid(field.bytesValue) ||
				!strings.HasPrefix(string(field.bytesValue), "claude-") {
				return false
			}
			hasModel = true
		case 8:
			return field.wireType == protobufBytes && utf8.Valid(field.bytesValue)
		case 11:
			return field.wireType == protobufBytes && isCanonicalUUID(string(field.bytesValue))
		}
		return true
	})
	return valid && hasChannelID && hasSignature && hasModel
}

const (
	protobufVarint  = uint64(0)
	protobufFixed64 = uint64(1)
	protobufBytes   = uint64(2)
	protobufFixed32 = uint64(5)
)

type protobufField struct {
	number     uint64
	wireType   uint64
	bytesValue []byte
}

// protobufBytesField 读取指定 bytes 字段，同时拒绝损坏的 protobuf。
func protobufBytesField(message []byte, number uint64) ([]byte, bool) {
	var value []byte
	valid := walkProtobuf(message, func(field protobufField) bool {
		if field.number != number {
			return true
		}
		if field.wireType != protobufBytes {
			return false
		}
		value = field.bytesValue
		return true
	})
	return value, valid && value != nil
}

// walkProtobuf 无分配遍历签名 envelope，仅实现 protobuf 标准 wire types。
func walkProtobuf(message []byte, visit func(protobufField) bool) bool {
	for len(message) > 0 {
		key, consumed := binary.Uvarint(message)
		if consumed <= 0 || key>>3 == 0 {
			return false
		}
		message = message[consumed:]
		field := protobufField{number: key >> 3, wireType: key & 7}
		var ok bool
		message, field.bytesValue, ok = consumeProtobufValue(message, field.wireType)
		if !ok || !visit(field) {
			return false
		}
	}
	return true
}

// consumeProtobufValue 消费单个字段值并返回 bytes 类型的有效载荷。
func consumeProtobufValue(message []byte, wireType uint64) ([]byte, []byte, bool) {
	switch wireType {
	case protobufVarint:
		_, consumed := binary.Uvarint(message)
		if consumed <= 0 {
			return nil, nil, false
		}
		return message[consumed:], nil, true
	case protobufFixed64:
		if len(message) < 8 {
			return nil, nil, false
		}
		return message[8:], nil, true
	case protobufBytes:
		length, consumed := binary.Uvarint(message)
		if consumed <= 0 || length > uint64(len(message)-consumed) {
			return nil, nil, false
		}
		start := consumed
		end := start + int(length)
		return message[end:], message[start:end], true
	case protobufFixed32:
		if len(message) < 4 {
			return nil, nil, false
		}
		return message[4:], nil, true
	default:
		return nil, nil, false
	}
}

// isCanonicalUUID 校验 CAIS 可选 context id 的标准 UUID 文本形态。
func isCanonicalUUID(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' ||
		value[18] != '-' || value[23] != '-' {
		return false
	}
	for index := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			continue
		}
		character := value[index]
		if !((character >= '0' && character <= '9') ||
			(character >= 'a' && character <= 'f') ||
			(character >= 'A' && character <= 'F')) {
			return false
		}
	}
	return true
}
