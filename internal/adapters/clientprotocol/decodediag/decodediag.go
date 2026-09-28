// Package decodediag 为客户端协议 Decoder 生成低敏诊断字段路径。
//
// 诊断只能包含字段名和协议判别值（type 这类枚举），不能包含用户正文、工具参数或
// 凭据；所有外来字符串都经过字符白名单和长度上限清洗。
package decodediag

import (
	"encoding/json"
	"errors"
	"strings"
)

const maxTokenLength = 64

// StrictJSONField 在严格 JSON 解码失败时补充未知字段名或类型不符字段名。
func StrictJSONField(field string, err error) string {
	var typeErr *json.UnmarshalTypeError
	if errors.As(err, &typeErr) && typeErr.Field != "" {
		return field + "." + sanitize(typeErr.Field) + "(type)"
	}
	if err != nil {
		const prefix = `json: unknown field "`
		message := err.Error()
		if strings.HasPrefix(message, prefix) {
			name := strings.TrimSuffix(strings.TrimPrefix(message, prefix), `"`)
			return field + "." + sanitize(name) + "(unknown)"
		}
	}
	return field
}

// Discriminator 返回带协议判别值的字段路径，例如 tools[27].type=web_search_20250305。
func Discriminator(field string, value string) string {
	return field + "=" + sanitize(value)
}

// sanitize 只保留协议标识符常见字符并截断，避免把任意客户端文本写进日志。
func sanitize(value string) string {
	var builder strings.Builder
	for _, char := range value {
		if builder.Len() >= maxTokenLength {
			builder.WriteString("…")
			break
		}
		switch {
		case char >= 'a' && char <= 'z',
			char >= 'A' && char <= 'Z',
			char >= '0' && char <= '9',
			char == '_', char == '-', char == '.':
			builder.WriteRune(char)
		default:
			builder.WriteRune('?')
		}
	}
	if builder.Len() == 0 {
		return "?"
	}
	return builder.String()
}
