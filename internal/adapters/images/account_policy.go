package images

import "strings"

// SupportsCodexOAuthImagePlan 只排除已知不提供 Codex 图片工具的 Free 套餐。
// 未知套餐交给上游判断；API Key 使用独立的 OpenAI Images 合同，不受此规则限制。
func SupportsCodexOAuthImagePlan(plan string) bool {
	return !strings.EqualFold(strings.TrimSpace(plan), "free")
}
