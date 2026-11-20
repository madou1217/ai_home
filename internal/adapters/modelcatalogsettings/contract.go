// Package modelcatalogsettings 是 model-catalog-settings 文档的存储适配器。
//
// 文档的读模型、归一规则与版本常量属于应用层契约（application/modelcatalogsettings）：
// 归一化是纯领域逻辑，任何宿主或来源都应遵循同一份规则。本包只保留与存储相关的能力
// （aih.db 的 KV 读写、原子更新端口），并把应用层类型以别名暴露给本包的调用方，
// 使存储实现不必再定义一份平行的形状。
package modelcatalogsettings

import (
	appsettings "github.com/madou1217/ai_home/application/modelcatalogsettings"
)

// 文档形状与版本常量来自应用层契约；这里只做别名，避免出现第二份定义。
type (
	// Settings 是归一后的 model-catalog-settings 文档。
	Settings = appsettings.Settings
	// AccountModel 是一条 (账号, 模型) 设置记录。
	AccountModel = appsettings.AccountModel
	// LegacyModel 是旧形状里按模型维度记录的设置。
	LegacyModel = appsettings.LegacyModel
	// CustomPricing 是自定义单价。
	CustomPricing = appsettings.CustomPricing
)

const (
	// SettingsVersion 是当前文档版本。
	SettingsVersion = appsettings.SettingsVersion
	// DatabaseKey 是文档在 aih.db KV 里的键。
	DatabaseKey = appsettings.DatabaseKey
)

// Normalize 归一任意来源的文档；规则只在应用层定义一次。
func Normalize(document any) Settings {
	return appsettings.Normalize(document)
}

// normalizeAt 是存储层内部使用的带时刻归一化。
func normalizeAt(document any, nowMS int64) Settings {
	return appsettings.NormalizeAt(document, nowMS)
}
