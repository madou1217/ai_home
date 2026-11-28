package openairesponses

import "encoding/json"

// clientOnlyInputFields 是 Codex 客户端随输入项下发、但上游协议没有对应表达的
// 私有字段。它们只是客户端的会话/UI 元数据，Canonical 投影一律丢弃。
//
// 为什么按 input 项统一剥离，而不是只在 messageDTO 上放行：Codex 0.171 起会把
// internal_chat_message_metadata_passthrough 挂到 message 以外的输入项上，
// 严格的 per-DTO 未知字段检查会把整轮请求判成 invalid_request（2026-11-28 线上
// input[6] 即为此）。其它未知字段仍然由 decodeStrict 拒绝。
var clientOnlyInputFields = []string{
	"internal_chat_message_metadata_passthrough",
}

// scrubClientInputFields 从 input 数组的每一项删除客户端私有字段。
// 解析失败或没有可删除字段时原样返回，交给严格解码给出真实错误。
func scrubClientInputFields(body []byte) []byte {
	var root map[string]json.RawMessage
	if json.Unmarshal(body, &root) != nil {
		return body
	}
	rawInput, found := root["input"]
	if !found {
		return body
	}
	var items []json.RawMessage
	if json.Unmarshal(rawInput, &items) != nil {
		return body
	}
	changed := false
	for index, item := range items {
		var fields map[string]json.RawMessage
		if json.Unmarshal(item, &fields) != nil {
			continue
		}
		itemChanged := false
		for _, name := range clientOnlyInputFields {
			if _, found := fields[name]; found {
				delete(fields, name)
				itemChanged = true
			}
		}
		if !itemChanged {
			continue
		}
		rewritten, err := json.Marshal(fields)
		if err != nil {
			continue
		}
		items[index] = rewritten
		changed = true
	}
	if !changed {
		return body
	}
	encodedItems, err := json.Marshal(items)
	if err != nil {
		return body
	}
	root["input"] = encodedItems
	encodedRoot, err := json.Marshal(root)
	if err != nil {
		return body
	}
	return encodedRoot
}
