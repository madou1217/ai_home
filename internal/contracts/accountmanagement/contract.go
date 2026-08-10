// Package accountmanagement 定义账号管理客户端与服务端共享的稳定 HTTP 路径。
package accountmanagement

const (
	// AccountsPath 是账号管理集合资源的规范路径。
	AccountsPath = "/v1/management/accounts"
	// AccountAliasesPath 是 Provider 数字别名只读解析资源的规范路径。
	AccountAliasesPath = "/v1/management/account-aliases"
	// AccountUsageSuffix 是账号成员下最近一次成功额度快照的资源后缀。
	AccountUsageSuffix = "/usage"
	// AccountUsageRefreshSuffix 是显式刷新账号额度快照的动作资源后缀。
	AccountUsageRefreshSuffix = "/usage/refresh"
)
