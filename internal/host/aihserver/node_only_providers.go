package aihserver

import (
	"sort"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// providerIDs 返回 Provider 目录里的全部 ID（归属解析的唯一真值源）。
func providerIDs(catalog *providers.Catalog) []string {
	if catalog == nil {
		return nil
	}
	definitions := catalog.List()
	ids := make([]string, 0, len(definitions))
	for _, definition := range definitions {
		if id := strings.TrimSpace(definition.ID); id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}

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
