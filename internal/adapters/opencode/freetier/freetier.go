// Package freetier 描述 OpenCode CLI 的匿名免费模型边界。
//
// opencode/ 命名空间下以 -free 结尾的模型（例如
// opencode/deepseek-v4.1-flash-free）由 OpenCode 自己的 zen 免费层提供，
// 不读取、也不需要 AIH 账号凭据。OpenCode Go（opencode-go/）不是同一条通道，
// CLI 也不接受该命名空间，不能把两类模型混在一起判断。
package freetier

import "strings"

const (
	cliNamespace = "opencode/"
	freeSuffix   = "-free"
)

// IsFreeModel 报告 model 是否是 OpenCode CLI 可直接执行的匿名免费模型。
func IsFreeModel(model string) bool {
	normalized := strings.ToLower(strings.TrimSpace(model))
	if !strings.HasPrefix(normalized, cliNamespace) || !strings.HasSuffix(normalized, freeSuffix) {
		return false
	}
	return len(normalized) > len(cliNamespace)+len(freeSuffix)
}
