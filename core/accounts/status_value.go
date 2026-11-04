package accounts

import "strings"

// NormalizeAccountStatus 把外部状态词归一为 up/down。
//
// 与 Node 的 status-file.js 同一口径：down/disabled → down，up/enabled → up，
// 其它值返回空串（调用方决定是否拒绝或按 up 兜底）。账号库里两个进程必须写入
// 同一套词，否则读方会在 "enabled" 与 "up" 之间来回判定。
func NormalizeAccountStatus(status string) string {
	value := strings.ToLower(strings.TrimSpace(status))
	switch value {
	case "down", "disabled":
		return "down"
	case "up", "enabled":
		return "up"
	default:
		return ""
	}
}

// ResolveEffectiveAccountStatus 返回可直接展示的生命周期状态；未知值按 up 处理。
func ResolveEffectiveAccountStatus(status string) string {
	if normalized := NormalizeAccountStatus(status); normalized != "" {
		return normalized
	}
	return "up"
}
