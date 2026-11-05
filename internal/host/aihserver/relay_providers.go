package aihserver

import (
	"sort"

	"github.com/madou1217/ai_home/core/providers"
)

// nodeOnlyProviderIDs 是「Go 没有推理上游、只能由 Node 服务」的 Provider。
//
// 从 Catalog 的 RelayHosts 派生（Go 声明 Supported=false），不在别处手写名单：
// 声明了 Node-only 的 Provider 若混进 Canonical 目录，会因为没有 Factory 让整个
// 路由快照构建失败（实测 kiro 就是这样让 Go 的路由目录变成空的）。
func nodeOnlyProviderIDs(catalog *providers.Catalog) []string {
	if catalog == nil {
		return nil
	}
	ids := make([]string, 0, 4)
	for _, definition := range catalog.List() {
		host, ok := definition.RelayHosts[providers.RelayHostGo]
		if ok && !host.Supported {
			ids = append(ids, definition.ID)
		}
	}
	sort.Strings(ids)
	return ids
}
