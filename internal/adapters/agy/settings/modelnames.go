package settings

import "github.com/madou1217/ai_home/internal/adapters/agy/modelnames"

// 模型 id↔显示名的唯一真值已收敛到 internal/adapters/agy/modelnames。
// 这里保留 settings 包的公开入口，避免调用方与既有测试改动。

// ResolveModelName 把内部模型 id 译成 CLI 显示名；已是显示名原样返回；无法识别返回空串。
func ResolveModelName(value string) string {
	return modelnames.Resolve(value)
}

// ListModelNames 返回全部合法显示名（按声明顺序）。
func ListModelNames() []string {
	return modelnames.List()
}

// DefaultModelName 返回自愈使用的缺省显示名（列表第一项）。
func DefaultModelName() string {
	return modelnames.Default()
}
