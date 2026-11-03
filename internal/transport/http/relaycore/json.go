package relaycore

import (
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

// 本文件是**协议形状**的 JSON 工具：OpenAI chat completions 的字段解析口径与具体
// Provider 无关，因此只有一份实现。导出给各 Provider 的 rewriter 复用（它们各自的
// 改写逻辑不同，但「怎么读一个 delta 字段」完全相同）。

// DecodeRawObject 解析 JSON 对象；不是对象时返回 false（逐字段宽容）。
func DecodeRawObject(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	if !IsJSONObject(raw) {
		return nil, false
	}
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, false
	}
	return fields, true
}

// IsJSONObject 判断原始字节是否为 JSON 对象（nil / 空 / 其它类型都是 false）。
func IsJSONObject(raw json.RawMessage) bool {
	return strings.HasPrefix(strings.TrimSpace(string(raw)), "{")
}

// RawString 只接受 JSON 字符串（与 Node 的 typeof === 'string' 同口径）。
func RawString(raw json.RawMessage) (string, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed[0] != '"' {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

// RawInt64 接受数字或数字字符串（Node 的 Number() 会同时接受两者），并容忍浮点写法。
func RawInt64(raw json.RawMessage) (int64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return 0, false
	}
	if trimmed[0] == '"' {
		value, ok := RawString(raw)
		if !ok {
			return 0, false
		}
		trimmed = strings.TrimSpace(value)
	}
	if parsed, err := strconv.ParseInt(trimmed, 10, 64); err == nil {
		return parsed, true
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	return int64(parsed), true
}

// RawBool 只接受 JSON 布尔。
func RawBool(raw json.RawMessage) (bool, bool) {
	switch strings.TrimSpace(string(raw)) {
	case "true":
		return true, true
	case "false":
		return false, true
	default:
		return false, false
	}
}

// RawArray 解析 JSON 数组；字段缺席或类型不符返回 nil（逐字段宽容）。
func RawArray(raw json.RawMessage) []json.RawMessage {
	items, err := DecodeRawArray(raw)
	if err != nil {
		return nil
	}
	return items
}

// DecodeRawArray 解析 JSON 数组；字段缺席返回空数组，类型不符返回错误。
func DecodeRawArray(raw json.RawMessage) ([]json.RawMessage, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil, nil
	}
	if trimmed[0] != '[' {
		return nil, errNotArray
	}
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, err
	}
	return items, nil
}

// DescribeJSONForm 给认不出的形态一个人可读的名字（进 unsupportedForm 与日志）。
func DescribeJSONForm(trimmed string) string {
	switch trimmed {
	case "":
		return "empty"
	case "null":
		return "null"
	}
	switch trimmed[0] {
	case '[':
		return "array"
	case 't', 'f':
		return "boolean"
	case '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9':
		return "number"
	default:
		return "unknown"
	}
}

// NowMillis 取当前毫秒（可注入时钟，便于测试）。
func NowMillis(clock func() time.Time) int64 {
	if clock == nil {
		return time.Now().UnixMilli()
	}
	return clock().UnixMilli()
}
