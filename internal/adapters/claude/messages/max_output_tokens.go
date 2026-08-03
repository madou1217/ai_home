package messages

import "strings"

const (
	// claudeCodeModernDefaultMaxOutputTokens 是 Claude Code 对未专门列出的
	// 现代模型使用的客户端默认值，不代表 Anthropic API 的全局默认。
	claudeCodeModernDefaultMaxOutputTokens uint64 = 32_000
	// claudeCodeCurrentDefaultMaxOutputTokens 是本机 Claude Code 2.1.220
	// 对 Claude 5 与 Opus 4.6 实际发送的客户端默认值。
	claudeCodeCurrentDefaultMaxOutputTokens uint64 = 64_000
)

// claudeCodeDefaultMaxOutputTokens 只处理跨协议客户端省略输出上限的情况。
// Anthropic Messages 客户端提供的 max_tokens 始终由 Canonical Request 原样保留。
func claudeCodeDefaultMaxOutputTokens(model string) uint64 {
	normalized := strings.ToLower(strings.TrimSpace(model))
	switch {
	case strings.Contains(normalized, "opus-5"),
		strings.Contains(normalized, "sonnet-5"),
		strings.Contains(normalized, "fable-5"),
		strings.Contains(normalized, "opus-4-6"),
		strings.Contains(normalized, "opus-4-7"),
		strings.Contains(normalized, "opus-4-8"):
		return claudeCodeCurrentDefaultMaxOutputTokens
	case strings.Contains(normalized, "opus-4-5"),
		strings.Contains(normalized, "sonnet-4"),
		strings.Contains(normalized, "haiku-4"),
		strings.Contains(normalized, "opus-4"),
		strings.Contains(normalized, "3-7-sonnet"):
		return claudeCodeModernDefaultMaxOutputTokens
	case strings.Contains(normalized, "claude-3-opus"),
		strings.Contains(normalized, "claude-3-haiku"):
		return 4_096
	case strings.Contains(normalized, "claude-3-sonnet"),
		strings.Contains(normalized, "3-5-sonnet"),
		strings.Contains(normalized, "3-5-haiku"):
		return 8_192
	default:
		return claudeCodeModernDefaultMaxOutputTokens
	}
}
