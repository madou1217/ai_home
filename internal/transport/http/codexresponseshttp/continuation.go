package codexresponseshttp

import (
	"context"
	"encoding/json"
	"strings"
)

// resolveContinuation 把带 previous_response_id 的 HTTP 请求展开成无状态请求。
//
// Codex 从 WebSocket 掉到 HTTPS 时会沿用 WS 的续接形状：后续帧常常省略 model
// （WS 由连接绑定），只带 previous_response_id 和增量 input。HTTP 入口没有连接
// 绑定，直接解码会得到 “invalid_request_body”。持久层记录了每个响应的完整
// 上下文与交付模型，用它展开即可：
//   - input = 历史上下文 + 本帧增量
//   - 删除 previous_response_id，store=false（不再依赖上游持久化）
//   - model 缺失时用记录的模型补回
//
// 未命中/记录不完整时返回 false：调用方保留旧行为（model 存在则继续，缺失则
// 按 invalid_request_body 拒绝）。
func (handler *Handler) resolveContinuation(
	ctx context.Context,
	payload []byte,
	metadata nativeRequest,
) ([]byte, nativeRequest, bool) {
	if handler == nil || handler.Dependencies.ResponseContexts == nil || metadata.PreviousResponseID == "" {
		return payload, metadata, false
	}
	record, found, err := handler.Dependencies.ResponseContexts.Load(ctx, metadata.PreviousResponseID)
	if err != nil || !found || len(record.Items) == 0 {
		return payload, metadata, false
	}
	var frame map[string]json.RawMessage
	if json.Unmarshal(payload, &frame) != nil {
		return payload, metadata, false
	}
	input, ok := continuationInput(frame["input"])
	if !ok {
		return payload, metadata, false
	}
	expanded := make([]json.RawMessage, 0, len(record.Items)+len(input))
	expanded = append(expanded, record.Items...)
	expanded = append(expanded, input...)
	encoded, err := json.Marshal(expanded)
	if err != nil || int64(len(encoded)) > MaxRequestBytes {
		return payload, metadata, false
	}
	model := strings.TrimSpace(metadata.Model)
	if model == "" {
		model = strings.TrimSpace(record.Model)
		if model == "" {
			return payload, metadata, false
		}
	}
	frame["input"] = encoded
	frame["model"] = json.RawMessage(strconvQuote(model))
	delete(frame, "previous_response_id")
	frame["store"] = json.RawMessage("false")
	rewritten, err := json.Marshal(frame)
	if err != nil || int64(len(rewritten)) > MaxRequestBytes {
		return payload, metadata, false
	}
	metadata.Model = model
	metadata.PreviousResponseID = ""
	store := false
	metadata.Store = &store
	metadata.Input = encoded
	return rewritten, metadata, true
}

// continuationInput 接受 Responses 的数组输入或纯文本输入。
func continuationInput(raw json.RawMessage) ([]json.RawMessage, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return []json.RawMessage{}, true
	}
	var items []json.RawMessage
	if json.Unmarshal(raw, &items) == nil {
		return items, true
	}
	var text string
	if json.Unmarshal(raw, &text) != nil {
		return nil, false
	}
	item, _ := json.Marshal(map[string]string{"role": "user", "content": text})
	return []json.RawMessage{item}, true
}

// strconvQuote 返回 JSON 字符串字面量（模型 ID 只含安全字符，仍走标准编码）。
func strconvQuote(value string) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}
