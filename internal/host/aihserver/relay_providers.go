package aihserver

import (
	"sort"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/transport/http/clinerelay"
	"github.com/madou1217/ai_home/internal/transport/http/codebuddyfamilyrelay"
	"github.com/madou1217/ai_home/internal/transport/http/grokrelay"
	"github.com/madou1217/ai_home/internal/transport/http/kimirelay"
	"github.com/madou1217/ai_home/internal/transport/http/opencoderelay"
	"github.com/madou1217/ai_home/internal/transport/http/qoderrelay"
)

// relayProviderIDs 是「由透传通道直接服务」的 Provider 集合的唯一声明处。
//
// 这些 Provider 的模型必须进展示目录与账号路由索引（/v1/models、路由未命中与
// 交还判定都依赖它），但它们不存在也不应该存在 Canonical RouteRule：透传通道
// 直接打上游，不经过 Canonical 执行计划。
//
// 目录构建（inference.go）与模型刷新队列（composition.go）都消费这份声明。
// 两处各写一份名单曾造成真实故障：刷新队列登记了 cline/grok/kimi，目录构建却没有
// 声明它们，Builder 在 buildRule 里因缺 Factory 硬失败，整个快照永不发布。
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

func relayProviderIDs() []string {
	providers := make([]string, 0, len(codebuddyfamilyrelay.FamilyProviders)+4)
	providers = append(providers, codebuddyfamilyrelay.FamilyProviders...)
	providers = append(
		providers,
		clinerelay.ProviderID,
		grokrelay.ProviderID,
		kimirelay.ProviderID,
		opencoderelay.ProviderID,
		qoderrelay.QoderProviderID,
		qoderrelay.QoderCNProviderID,
	)
	return providers
}
