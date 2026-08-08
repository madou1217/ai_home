package claudenativerelay

import (
	"bytes"
	"encoding/json"
	"strings"
)

// Anthropic 依据客户端身份判定订阅额度是否可用。真实 Claude Code 自己带着这份
// 身份，因此字节透传它的请求一直可用；任何缺失它的客户端若原样透传，会被上游按
// 限流拒绝——同一账号、同一时刻、同一模型下 aih claude <id> 成功而网关 429。
//
// Node 侧同一缺陷已修（lib/server/claude-official-client.js）。本文件是 Relay
// 通道上的对应实现：只在缺失时补齐，已带身份的请求保持逐字节不变。
const (
	// officialSystemIdentity 是官方 CLI 每次请求的首个 system 块。
	// 取自官方源码 cli/src/constants/prompts.ts:452。官方随后追加的 CWD/Date
	// 属于本地环境事实，网关侧没有等价语义，不自造。
	officialSystemIdentity = "You are Claude Code, Anthropic's official CLI for Claude."
	// systemField 是 Messages 请求体里承载系统提示的字段名。
	systemField = "system"
)

// systemBlockDTO 是 system 数组元素的最小形状。
type systemBlockDTO struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// hasOfficialIdentity 判断请求体是否已经带着官方身份块。
//
// 官方客户端会在身份行后追加 CWD/Date，因此用前缀匹配而不是全等。
func hasOfficialIdentity(system json.RawMessage) bool {
	if len(system) == 0 {
		return false
	}
	var text string
	if json.Unmarshal(system, &text) == nil {
		return strings.HasPrefix(text, officialSystemIdentity)
	}
	var blocks []systemBlockDTO
	if json.Unmarshal(system, &blocks) != nil || len(blocks) == 0 {
		return false
	}
	return strings.HasPrefix(blocks[0].Text, officialSystemIdentity)
}

// ensureOfficialIdentityBody 在缺失时把官方身份块补到 system 最前。
//
// 返回的字节在以下情况与入参完全相同（同一底层数组），保住透传语义：
//   - 已带身份（真实 Claude Code）
//   - 正文不是合法 JSON 对象——不臆测其结构
//
// 客户端自身的 system 一律原样保留在身份块之后，不被覆盖也不被改写。
func ensureOfficialIdentityBody(body []byte) []byte {
	if len(body) == 0 {
		return body
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal(body, &envelope) != nil || envelope == nil {
		return body
	}
	if hasOfficialIdentity(envelope[systemField]) {
		return body
	}
	identity := systemBlockDTO{Type: "text", Text: officialSystemIdentity}
	blocks := []systemBlockDTO{identity}
	if existing, found := envelope[systemField]; found && len(existing) > 0 {
		var text string
		var parsed []systemBlockDTO
		switch {
		case json.Unmarshal(existing, &text) == nil:
			if strings.TrimSpace(text) != "" {
				blocks = append(blocks, systemBlockDTO{
					Type: "text",
					Text: text,
				})
			}
		case json.Unmarshal(existing, &parsed) == nil:
			blocks = append(blocks, parsed...)
		default:
			// system 形状无法识别时不改写，避免破坏客户端语义。
			return body
		}
	}
	encoded, err := json.Marshal(blocks)
	if err != nil {
		return body
	}
	envelope[systemField] = encoded
	rewritten, err := json.Marshal(envelope)
	if err != nil {
		return body
	}
	return rewritten
}

// bodyUnchanged 报告改写是否发生，供调用方判断能否保持透传承诺。
func bodyUnchanged(original, candidate []byte) bool {
	return bytes.Equal(original, candidate)
}
