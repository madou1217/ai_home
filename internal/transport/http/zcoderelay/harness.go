package zcoderelay

import (
	"bytes"
	"encoding/json"
	"strings"
	"unicode/utf8"
)

// 官方 harness 的形状判据（与 Node 侧同值）：
// 第一块是身份行（短），其余块拼起来是 harness 正文（长）。
const (
	harnessMaxIdentityChars = 200
	harnessMinBodyChars     = 500
)

// HarnessInput 是整形所需的宿主事实。
type HarnessInput struct {
	// Blocks 是缓存下来的官方 harness（逐块原样，含 cache_control）。
	Blocks []map[string]any
	// DeviceMid / AccountUUID / SessionID 用于补 metadata.user_id。
	DeviceMid   string
	AccountUUID string
	SessionID   string
}

// ApplyHarness 把请求体整形成官方 harness 形态。
//
// 旧实现（Node）把「已带 harness 判定、system 迁移、metadata 拼装」写在一个函数里，
// 任何一步异常都可能改坏请求；这里保持同一语义，但用 **UseNumber** 解析，避免大整数
// 被 float64 改写（Node 的 JSON.parse 会丢精度），且所有失败路径都返回原字节。
func ApplyHarness(body []byte, input HarnessInput) []byte {
	if len(input.Blocks) == 0 {
		return body
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return body
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.UseNumber()
	var parsed map[string]any
	if err := decoder.Decode(&parsed); err != nil || parsed == nil {
		return body
	}
	// 官方客户端自己的请求（已带 harness）逐字节不变。
	if LooksLikeHarness(parsed["system"]) {
		return body
	}
	clientSystem := SystemToText(parsed["system"])
	next := make(map[string]any, len(parsed)+1)
	for key, value := range parsed {
		next[key] = value
	}
	next["system"] = harnessBlocksValue(input.Blocks)
	if clientSystem != "" {
		reminder := map[string]any{
			"role":    "user",
			"content": "<system-reminder>\n" + clientSystem + "\n</system-reminder>",
		}
		messages := make([]any, 0, 1)
		messages = append(messages, reminder)
		if existing, ok := parsed["messages"].([]any); ok {
			messages = append(messages, existing...)
		}
		next["messages"] = messages
	}
	metadata := make(map[string]any)
	if existing, ok := parsed["metadata"].(map[string]any); ok {
		for key, value := range existing {
			metadata[key] = value
		}
	}
	metadata["user_id"] = buildUserID(parsed["metadata"], input)
	next["metadata"] = metadata

	encoded, err := json.Marshal(next)
	if err != nil {
		return body
	}
	return encoded
}

// LooksLikeHarness 判断 system 是否已经是官方 harness 形态。
func LooksLikeHarness(system any) bool {
	blocks, ok := system.([]any)
	if !ok || len(blocks) < 2 {
		return false
	}
	texts := make([]string, 0, len(blocks))
	for _, raw := range blocks {
		switch block := raw.(type) {
		case string:
			texts = append(texts, strings.TrimSpace(block))
		case map[string]any:
			text, ok := block["text"].(string)
			if !ok {
				return false
			}
			texts = append(texts, strings.TrimSpace(text))
		default:
			return false
		}
	}
	identity := texts[0]
	if identity == "" || utf8.RuneCountInString(identity) > harnessMaxIdentityChars {
		return false
	}
	bodyText := strings.TrimSpace(strings.Join(texts[1:], "\n"))
	return utf8.RuneCountInString(bodyText) >= harnessMinBodyChars
}

// SystemToText 把 system（字符串或块数组）压成一段纯文本。
func SystemToText(system any) string {
	switch value := system.(type) {
	case string:
		return strings.TrimSpace(value)
	case []any:
		parts := make([]string, 0, len(value))
		for _, raw := range value {
			switch block := raw.(type) {
			case string:
				if text := strings.TrimSpace(block); text != "" {
					parts = append(parts, text)
				}
			case map[string]any:
				if text, ok := block["text"].(string); ok {
					if trimmed := strings.TrimSpace(text); trimmed != "" {
						parts = append(parts, trimmed)
					}
				}
			}
		}
		return strings.Join(parts, "\n\n")
	default:
		return ""
	}
}

// buildUserID 生成 metadata.user_id（官方形态是 JSON 字符串）。
//
// 已有 device_id / session_id 时保留调用方给的身份（例如官方客户端自己），只在缺失时补齐。
func buildUserID(metadata any, input HarnessInput) string {
	current := map[string]any{}
	if object, ok := metadata.(map[string]any); ok {
		if userID, ok := object["user_id"].(string); ok {
			var parsed map[string]any
			decoder := json.NewDecoder(strings.NewReader(userID))
			decoder.UseNumber()
			if err := decoder.Decode(&parsed); err == nil && parsed != nil {
				current = parsed
			}
		}
	}
	deviceID, _ := current["device_id"].(string)
	sessionID, _ := current["session_id"].(string)
	accountUUID, _ := current["account_uuid"].(string)
	if strings.TrimSpace(deviceID) == "" && strings.TrimSpace(input.DeviceMid) != "" {
		current["device_id"] = strings.TrimSpace(input.DeviceMid)
	}
	if strings.TrimSpace(sessionID) == "" && strings.TrimSpace(input.SessionID) != "" {
		current["session_id"] = strings.TrimSpace(input.SessionID)
	}
	if strings.TrimSpace(accountUUID) == "" && strings.TrimSpace(input.AccountUUID) != "" {
		current["account_uuid"] = strings.TrimSpace(input.AccountUUID)
	}
	if _, ok := current["device_id"]; !ok {
		current["device_id"] = ""
	}
	if _, ok := current["account_uuid"]; !ok {
		current["account_uuid"] = ""
	}
	if _, ok := current["session_id"]; !ok {
		current["session_id"] = ""
	}
	encoded, err := json.Marshal(current)
	if err != nil {
		return ""
	}
	return string(encoded)
}

// harnessBlocksValue 把缓存块转成可直接 JSON 序列化的 []any（不共享底层 map）。
func harnessBlocksValue(blocks []map[string]any) []any {
	value := make([]any, 0, len(blocks))
	for _, block := range blocks {
		copied := make(map[string]any, len(block))
		for key, item := range block {
			copied[key] = item
		}
		value = append(value, copied)
	}
	return value
}
