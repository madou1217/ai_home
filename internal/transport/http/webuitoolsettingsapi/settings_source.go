package webuitoolsettingsapi

import (
	"github.com/madou1217/ai_home/internal/runtime/toolkit/appsettings"
)

// 工具启动权限设置的读取语义在 appsettings：CLI 启动与 WebUI 读取必须共用同一份
// 解析（record 归一、默认值、只在显式 false 时关闭）。这里保留原有导出名，
// 让 handler/write API 不需要感知包的位置。
const toolPermissionSettingsKey = appsettings.Key

// ToolPermissionSettings 是设置记录的传输层别名。
type ToolPermissionSettings = appsettings.Settings

// SettingsSource 是只读设置源的传输层别名。
type SettingsSource = appsettings.Source

// ErrInvalidSettingsSource 保留原错误值，供旧调用方判断。
var ErrInvalidSettingsSource = appsettings.ErrInvalidRoot

// DefaultToolPermissionSettings 返回默认设置。
func DefaultToolPermissionSettings() ToolPermissionSettings {
	return appsettings.Default()
}

// OpenSettingsSource 创建只读读取器。
func OpenSettingsSource(aiHomeDir string) (*SettingsSource, error) {
	return appsettings.Open(aiHomeDir)
}
