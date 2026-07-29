package inference

import (
	"encoding/json"
	"strings"
	"unicode"
	"unicode/utf8"
)

// cloneBytes 返回字节切片的独立副本，避免 Decoder 复用缓冲区修改领域快照。
func cloneBytes(value []byte) []byte {
	return append([]byte(nil), value...)
}

// isNonBlankText 判断文本包含有效 UTF-8、没有控制字符且至少含一个非空白字符。
func isNonBlankText(value string) bool {
	if !utf8.ValidString(value) || strings.TrimSpace(value) == "" {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) && character != '\n' && character != '\t' {
			return false
		}
	}
	return true
}

// isValidDelta 判断增量非空、是有效 UTF-8，且不含协议不允许的控制字符。
//
// 单个增量可以只有空格或换行，因此不能复用完整文本的非空白约束。
func isValidDelta(value string) bool {
	if value == "" || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) && character != '\n' && character != '\t' {
			return false
		}
	}
	return true
}

// isCanonicalOpaqueID 判断外部标识可原样跨协议传输，不执行修剪或大小写改写。
func isCanonicalOpaqueID(value string) bool {
	if value == "" || len(value) > 256 || !utf8.ValidString(value) || strings.TrimSpace(value) != value {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) || unicode.IsSpace(character) {
			return false
		}
	}
	return true
}

// isOpaqueContinuityData 判断签名或加密连续性非空且不含控制字符。
//
// 该数据可能远长于普通 ID，因此不施加调用标识的 256 字节限制。
func isOpaqueContinuityData(value string) bool {
	if value == "" || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if unicode.IsControl(character) {
			return false
		}
	}
	return true
}

// isValidRequestUserID 校验低敏用户标识不会携带控制字符或无界数据。
func isValidRequestUserID(value string) bool {
	if len(value) > 1024 || !isNonBlankText(value) {
		return false
	}
	return true
}

// isJSONObject 判断字节内容是完整 JSON Object，不接受数组、null 或损坏参数。
func isJSONObject(value []byte) bool {
	trimmed := strings.TrimSpace(string(value))
	return len(trimmed) >= 2 &&
		trimmed[0] == '{' &&
		trimmed[len(trimmed)-1] == '}' &&
		json.Valid([]byte(trimmed))
}
