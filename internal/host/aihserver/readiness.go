package aihserver

import (
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
)

// accountCountsByProvider 返回每个受支持 Provider 的账号数量，缺席者记 0。
//
// 与 Node 的 `/readyz` 口径一致：Node 用 `SUPPORTED_SERVER_PROVIDERS.reduce(...)` 把
// **全部** Provider 都写进 `accounts`，没有账号的记 0 而不是省略键。这不只是风格问题——
// Fabric 的 `--runtime-diagnostics` 按 `accounts[provider] === 0` 推导
// `missing_provider_account:<provider>`；省略键会让它把「这个 Provider 没有账号」
// 读成「不认识这个 Provider」，诊断直接落空。
//
// 数据来自进程内路由索引（`store.CountAccountsByProvider`），不访问 SQLite，因此这个
// 函数可以安全地跑在未鉴权的 `/readyz` 上。
func accountCountsByProvider(
	catalog *providers.Catalog,
	store *sqliteaccount.Store,
) map[string]int {
	counts := map[string]int{}
	if catalog == nil {
		return counts
	}
	// 先铺满全部受支持 Provider 的 0，再覆盖真实计数。
	for _, definition := range catalog.List() {
		counts[definition.ID] = 0
	}
	if store == nil {
		return counts
	}
	for providerID, count := range store.CountAccountsByProvider() {
		// 只统计注册表认识的 Provider：数据库里可能残留已下线 Provider 的账号，
		// 把它们塞进 accounts 会让消费方看到一个「不存在的 Provider 有账号」。
		if _, found := counts[providerID]; !found {
			continue
		}
		counts[providerID] = count
	}
	return counts
}
