package codexresponseshttp

import (
	"encoding/json"
	"strings"
)

// itemIDPrefixByType 是 Responses 输入项类型与 id 前缀的对应关系（与 Node 的
// lib/server/codex-adapter.js 同表）。
//
// 为什么必须按类型校验：上游会按 item 类型复核 id 前缀，类型与前缀不匹配时直接
// 400 invalid_id_prefix（真机：custom_tool_call 携带上游给的 fc_ id，报
// "Expected an ID that begins with 'ctc'"）。网关在渲染响应时可能按 freeform 工具
// 改写过 item 类型，客户端回传的就是这种「类型与 id 前缀不一致」的历史。
var itemIDPrefixByType = map[string]string{
	"message":                 "msg_",
	"reasoning":               "rs_",
	"function_call":           "fc_",
	"function_call_output":    "fco_",
	"custom_tool_call":        "ctc_",
	"custom_tool_call_output": "ctco_",
}

// sanitizeNativePayload 在把请求体原样转给上游前，剥掉上游无法解析的引用。
//
// 与 Node 的 convertOpenAIResponsesToCodexPayload 同一口径：
//  1. store:false 时上游不持久化任何 item，previous_response_id 与所有 item id 都
//     无法在 store 中解析，透传必然 404；
//  2. 即使 store:true，item.id 的前缀也必须与 item.type 匹配（custom_tool_call 只接受
//     ctc_），否则上游 400 invalid_id_prefix；
//  3. reasoning.encrypted_content 只能用生成它的账号私钥解密，换号必然 400
//     invalid_encrypted_content。
//
// 任何解析失败都原样返回——这条路径是「原样透传」，不能因为清洗逻辑把正常请求打坏。
func sanitizeNativePayload(payload []byte) []byte {
	if len(payload) == 0 {
		return payload
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(payload, &root); err != nil {
		return payload
	}
	changed := false
	storeDisabled := false
	if raw, found := root["store"]; found {
		var store bool
		if err := json.Unmarshal(raw, &store); err == nil && !store {
			storeDisabled = true
		}
	}
	if storeDisabled {
		if _, found := root["previous_response_id"]; found {
			delete(root, "previous_response_id")
			changed = true
		}
	}
	if rawInput, found := root["input"]; found {
		if sanitized, inputChanged := sanitizeNativeInput(rawInput, storeDisabled); inputChanged {
			root["input"] = sanitized
			changed = true
		}
	}
	if !changed {
		return payload
	}
	encoded, err := json.Marshal(root)
	if err != nil {
		return payload
	}
	return encoded
}

func sanitizeNativeInput(raw json.RawMessage, storeDisabled bool) (json.RawMessage, bool) {
	var items []json.RawMessage
	if err := json.Unmarshal(raw, &items); err != nil {
		return raw, false
	}
	changed := false
	for index, item := range items {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(item, &fields); err != nil {
			continue
		}
		itemChanged := false
		var itemType string
		if value, found := fields["type"]; found {
			_ = json.Unmarshal(value, &itemType)
		}
		expectedPrefix := itemIDPrefixByType[strings.TrimSpace(itemType)]
		if value, found := fields["id"]; found {
			var id string
			if err := json.Unmarshal(value, &id); err == nil {
				id = strings.TrimSpace(id)
				if id != "" && (storeDisabled || (expectedPrefix != "" && !strings.HasPrefix(id, expectedPrefix))) {
					delete(fields, "id")
					itemChanged = true
				}
			}
		}
		if itemType == "reasoning" {
			if _, found := fields["encrypted_content"]; found {
				delete(fields, "encrypted_content")
				itemChanged = true
			}
		}
		if !itemChanged {
			continue
		}
		encoded, err := json.Marshal(fields)
		if err != nil {
			continue
		}
		items[index] = encoded
		changed = true
	}
	if !changed {
		return raw, false
	}
	encoded, err := json.Marshal(items)
	if err != nil {
		return raw, false
	}
	return encoded, true
}
