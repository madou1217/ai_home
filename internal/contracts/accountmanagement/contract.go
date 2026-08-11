// Package accountmanagement 定义账号管理客户端与服务端共享的稳定 HTTP 路径。
package accountmanagement

const (
	// AccountsPath 是账号管理集合资源的规范路径。
	AccountsPath = "/v1/management/accounts"
	// AccountAliasesPath 是 Provider 数字别名只读解析资源的规范路径。
	AccountAliasesPath = "/v1/management/account-aliases"
	// ProviderDefaultsPath 是 Provider 默认启动账号关系的规范集合路径。
	ProviderDefaultsPath = "/v1/management/account-defaults"
	// NativeImportsPath 是 Provider 官方 artifact 导入资源的规范路径。
	NativeImportsPath = "/v1/management/account-imports"
	// Sub2APIImportsPath 是单账号 sub2api-data 文档导入资源的规范路径。
	Sub2APIImportsPath = "/v1/management/account-imports/sub2api"
	// AccountCredentialSuffix 是账号成员下静态凭据完整替换资源的后缀。
	AccountCredentialSuffix = "/credential"
	// AccountModelsSuffix 是账号成员下物化模型集合资源的后缀。
	AccountModelsSuffix = "/models"
	// AccountModelsRefreshSuffix 是账号成员下模型目录刷新动作的后缀。
	AccountModelsRefreshSuffix = "/models/refresh"
	// AccountSub2APIExportSuffix 是账号成员下 sub2api-data 导出资源的后缀。
	AccountSub2APIExportSuffix = "/export"
	// AccountCLIProxyAPIExportSuffix 是账号成员下 CLIProxyAPI auth-file 导出资源的后缀。
	AccountCLIProxyAPIExportSuffix = "/export/cliproxyapi"
	// AccountUsageSuffix 是账号成员下最近一次成功额度快照的资源后缀。
	AccountUsageSuffix = "/usage"
	// AccountUsageRefreshSuffix 是显式刷新账号额度快照的动作资源后缀。
	AccountUsageRefreshSuffix = "/usage/refresh"
)
