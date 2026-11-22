package settings

import "github.com/madou1217/ai_home/internal/adapters/agy/modelnames"

// 模型 id↔显示名的唯一真值已收敛到 internal/adapters/agy/modelnames。
// 这里保留 settings 包的公开入口，避免调用方与既有测试改动。

// ResolveModelName 把内部模型 id 译成 CLI 显示名；已是显示名原样返回；无法识别返回空串。
func ResolveModelName(value string) string {
	return modelnames.Resolve(value)
}

// ListModelNames 返回 settings 自愈可闭环使用的显示名（按声明顺序）。
// Provider 配置目录需要全部 CLI 候选时，应直接使用 modelnames.List。
func ListModelNames() []string {
	return modelnames.ListMapped()
}

// DefaultModelName 返回 settings 自愈使用的首个已映射显示名。
func DefaultModelName() string {
	return modelnames.DefaultMapped()
}
