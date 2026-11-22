// Package modelnames 是 agy 内部模型 id ↔ CLI 显示名的唯一真值表的适配器入口。
//
// 真值表本身已上移到应用层契约 application/agymodelnames：它被设置自愈、CLI 会话与
// 额度快照门禁共用，任何入站方向都不应各自持有副本。本包只保留既有调用方需要的
// 包路径与函数名，转调应用层契约。
package modelnames

import appnames "github.com/madou1217/ai_home/application/agymodelnames"

// Resolve 把内部 id 译成 CLI 显示名；已经是显示名则原样返回；无法识别返回空串。
func Resolve(value string) string {
	return appnames.Resolve(value)
}

// List 返回全部合法显示名（按声明顺序）的副本。
func List() []string {
	return appnames.List()
}

// Default 返回 Provider 配置目录使用的首个合法显示名。
func Default() string {
	return appnames.Default()
}

// ListMapped 返回已有内部 id 映射的显示名，供 settings 自愈使用。
func ListMapped() []string {
	return appnames.ListMapped()
}

// DefaultMapped 返回 settings 自愈使用的首个已映射显示名。
func DefaultMapped() string {
	return appnames.DefaultMapped()
}
