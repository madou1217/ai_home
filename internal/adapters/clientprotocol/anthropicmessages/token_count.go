package anthropicmessages

import (
	"bytes"
	"encoding/json"
	"strings"
)

// 本文件复刻 Node 的 lib/server/anthropic-token-count.js：一个纯本地的输入 token 估算，
// 不发任何上游请求、不选账号、不读凭据。它是 AIH 自己的近似实现（Anthropic 官方
// count_tokens 用真实 tokenizer），因此这里的目标是与 Node 逐字节同构，而不是猜上游。
//
// 规则（与 Node 一一对应）：
//   - 文本估算：把所有空白折叠成单个空格并去掉首尾空白，然后 max(1, ceil(utf8字节数/4))。
//   - JSON 估算：对解析后的值重新紧凑序列化，再按文本规则估算；null/缺失为 0。
//   - 内容块：text/input_text 取 text；tool_result 取 content + tool_use_id；
//     tool_use 取 name + input；image/document 固定 85；其他块按整个 JSON 估算。
//   - 每条消息固定加 4，system 存在时加 4，tools 非空时加 4。
//   - 结果至少为 1。

// imageBlockTokens 与 Node 的 image/document 固定估算值保持一致。
const imageBlockTokens = 85

// perMessageOverhead 是每条消息的固定开销，与 Node 的 estimateMessageTokens 一致。
const perMessageOverhead = 4

// TokenCountResponse 是 Anthropic count_tokens 的响应体。
type TokenCountResponse struct {
	InputTokens int `json:"input_tokens"`
}

// EstimateInputTokens 对一份 Messages 请求正文估算 input_tokens。
//
// 正文无法解析为对象时按空请求处理（结果仍为 1），与 Node 的
// `payload && typeof payload === 'object' ? payload : {}` 兜底一致。
func EstimateInputTokens(payload []byte) TokenCountResponse {
	request, ok := decodeTokenCountRequest(payload)
	if !ok {
		return TokenCountResponse{InputTokens: 1}
	}
	messageTokens := 0
	for _, raw := range request.Messages {
		messageTokens += estimateMessageTokens(raw)
	}
	systemTokens := 0
	if jsonTruthy(request.System) {
		systemTokens = estimateContentTokens(request.System) + perMessageOverhead
	}
	toolsTokens := 0
	if len(request.Tools) > 0 {
		toolsTokens = estimateJSONTokens(request.ToolsRaw) + perMessageOverhead
	}
	toolChoiceTokens := 0
	if jsonTruthy(request.ToolChoice) {
		toolChoiceTokens = estimateJSONTokens(request.ToolChoice)
	}
	total := messageTokens + systemTokens + toolsTokens + toolChoiceTokens
	if total < 1 {
		total = 1
	}
	return TokenCountResponse{InputTokens: total}
}

// tokenCountEnvelope 是估算所需字段的原始解码目标。
type tokenCountEnvelope struct {
	Messages   []json.RawMessage `json:"messages"`
	System     json.RawMessage   `json:"system"`
	Tools      json.RawMessage   `json:"tools"`
	ToolChoice json.RawMessage   `json:"tool_choice"`
}

// tokenCountRequest 只保留估算需要的字段，避免耦合完整请求 DTO 的校验。
type tokenCountRequest struct {
	Messages []json.RawMessage
	System   json.RawMessage
	// Tools 只在其确实是数组且非空时参与估算；ToolsRaw 保留原始子树供 JSON 估算。
	Tools      []json.RawMessage
	ToolsRaw   json.RawMessage
	ToolChoice json.RawMessage
}

// decodeTokenCountRequest 宽松解码估算所需的字段。
//
// tools 在 Node 侧只在 `Array.isArray(tools) && tools.length > 0` 时参与估算，
// 因此空数组与非数组都必须在解码阶段就归一为「无工具」，否则会平白多算 4 个 token。
func decodeTokenCountRequest(payload []byte) (tokenCountRequest, bool) {
	trimmed := bytes.TrimSpace(payload)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return tokenCountRequest{}, false
	}
	var envelope tokenCountEnvelope
	if err := json.Unmarshal(trimmed, &envelope); err != nil {
		return tokenCountRequest{}, false
	}
	request := tokenCountRequest{
		Messages:   envelope.Messages,
		System:     envelope.System,
		ToolChoice: envelope.ToolChoice,
	}
	if len(envelope.Tools) > 0 {
		var tools []json.RawMessage
		if err := json.Unmarshal(envelope.Tools, &tools); err == nil && len(tools) > 0 {
			request.Tools = tools
			request.ToolsRaw = envelope.Tools
		}
	}
	return request, true
}

// estimateMessageTokens 估算单条消息，含固定开销。
func estimateMessageTokens(raw json.RawMessage) int {
	if !isJSONObject(raw) {
		return estimateContentTokens(raw)
	}
	var message struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	}
	if err := json.Unmarshal(raw, &message); err != nil {
		return estimateContentTokens(raw)
	}
	return perMessageOverhead +
		estimateTextTokens(message.Role) +
		estimateContentTokens(message.Content)
}

// estimateContentTokens 估算 content，可为字符串、内容块数组或单个内容块。
func estimateContentTokens(raw json.RawMessage) int {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return 0
	}
	if trimmed[0] == '[' {
		var items []json.RawMessage
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return estimateJSONTokens(trimmed)
		}
		total := 0
		for _, item := range items {
			total += estimateContentBlockTokens(item)
		}
		return total
	}
	if trimmed[0] == '{' {
		return estimateContentBlockTokens(trimmed)
	}
	return estimateTextTokens(textFromJSONScalar(trimmed))
}

// estimateContentBlockTokens 按内容块类型估算，未知类型退化为整块 JSON 估算。
func estimateContentBlockTokens(raw json.RawMessage) int {
	trimmed := bytes.TrimSpace(raw)
	if !isJSONObject(trimmed) {
		return estimateContentTokens(trimmed)
	}
	var header struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(trimmed, &header); err != nil {
		return estimateJSONTokens(trimmed)
	}
	switch header.Type {
	case "text", "input_text":
		var block struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal(trimmed, &block); err != nil {
			return estimateJSONTokens(trimmed)
		}
		return estimateTextTokens(block.Text)
	case "tool_result":
		var block struct {
			Content   json.RawMessage `json:"content"`
			ToolUseID string          `json:"tool_use_id"`
		}
		if err := json.Unmarshal(trimmed, &block); err != nil {
			return estimateJSONTokens(trimmed)
		}
		return estimateContentTokens(block.Content) + estimateTextTokens(block.ToolUseID)
	case "tool_use":
		var block struct {
			Name  string          `json:"name"`
			Input json.RawMessage `json:"input"`
		}
		if err := json.Unmarshal(trimmed, &block); err != nil {
			return estimateJSONTokens(trimmed)
		}
		return estimateTextTokens(block.Name) + estimateJSONTokens(block.Input)
	case "image", "document":
		return imageBlockTokens
	default:
		return estimateJSONTokens(trimmed)
	}
}

// estimateTextTokens 折叠空白后按 UTF-8 字节数估算，空文本为 0。
func estimateTextTokens(value string) int {
	collapsed := strings.Join(strings.Fields(value), " ")
	if collapsed == "" {
		return 0
	}
	byteLength := len(collapsed)
	tokens := (byteLength + 3) / 4
	if tokens < 1 {
		return 1
	}
	return tokens
}

// estimateJSONTokens 对任意 JSON 值紧凑序列化后按文本规则估算。
func estimateJSONTokens(raw json.RawMessage) int {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return 0
	}
	// 与 Node 的 JSON.stringify 对齐：先解析再紧凑重排，因此原始缩进不会计入。
	var value any
	if err := json.Unmarshal(trimmed, &value); err != nil {
		return 0
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return 0
	}
	return estimateTextTokens(strings.TrimRight(buffer.String(), "\n"))
}

// isJSONObject 判断原始 JSON 是否为对象。
func isJSONObject(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '{'
}

// jsonTruthy 复刻 JavaScript 的真值判断，用于 system 与 tool_choice 的存在性。
//
// 与 Node 一致：缺失、null、空字符串、false、0 都为假；空数组和空对象为真。
func jsonTruthy(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return false
	}
	switch string(trimmed) {
	case "null", `""`, "false", "0":
		return false
	default:
		return true
	}
}

// textFromJSONScalar 把 JSON 标量还原成 JavaScript String() 的结果。
//
// null 与缺失在 Node 侧经 `value || ”` 变成空串，因此这里同样返回空串。
func textFromJSONScalar(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return ""
	}
	if trimmed[0] == '"' {
		var value string
		if err := json.Unmarshal(trimmed, &value); err != nil {
			return string(trimmed)
		}
		return value
	}
	return string(trimmed)
}
