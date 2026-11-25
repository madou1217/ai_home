package codexwire

import (
	"bytes"
	"encoding/json"
)

// preambleEventTypes 是 Codex 两条入口共用的「尚未产出内容」事件契约。
//
// 原生 HTTP 的响应探针（决定是否还能换号）和 Responses WebSocket 的扣留逻辑
// （决定 1011 换号时丢弃哪些帧）必须使用同一份集合：任何在拿到用户可见输出之前
// 出现、且不携带输出项的上游帧都要登记在这里，否则入口会把随后的容量/过载错误
// 当成「已经交付」，换号窗口被提前关闭。
//
// 已确认的真实序列（2026-11 实测，HTTP 与 WS 相同）：
//
//	response.created → response.in_progress → response.metadata → error
//
// 漏登记 response.metadata 会让两条入口同时失去换号能力；codex.* 是 Codex 的
// 旁路事件，只携带限流快照与响应头，同样不产生输出。
var preambleEventTypes = map[string]struct{}{
	"response.created":        {},
	"response.in_progress":    {},
	"response.queued":         {},
	"response.metadata":       {},
	"codex.rate_limits":       {},
	"codex.response.metadata": {},
}

// IsPreambleEvent 判断一帧上游事件是否不携带任何用户可见输出。
//
// payload 是事件 JSON；fallbackType 只在 payload 没有 type 字段时使用
// （SSE 的形状可能只在 event: 行给出类型）。无法解析、未知类型或已经带输出项
// 的帧一律返回 false，调用方应立即视为已提交，绝不能重放。
func IsPreambleEvent(payload []byte, fallbackType string) bool {
	if len(payload) == 0 {
		return false
	}
	var event struct {
		Type     string `json:"type"`
		Response struct {
			Output json.RawMessage `json:"output"`
		} `json:"response"`
	}
	if json.Unmarshal(payload, &event) != nil {
		return false
	}
	eventType := event.Type
	if eventType == "" {
		eventType = fallbackType
	}
	if _, ok := preambleEventTypes[eventType]; !ok {
		return false
	}
	output := bytes.TrimSpace(event.Response.Output)
	if len(output) == 0 || bytes.Equal(output, []byte("null")) {
		return true
	}
	var items []json.RawMessage
	return json.Unmarshal(output, &items) == nil && len(items) == 0
}
