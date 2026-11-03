package aihserver

import (
	"github.com/madou1217/ai_home/internal/transport/http/clinerelay"
	"github.com/madou1217/ai_home/internal/transport/http/codebuddyfamilyrelay"
	"github.com/madou1217/ai_home/internal/transport/http/grokrelay"
	"github.com/madou1217/ai_home/internal/transport/http/kimirelay"
	"github.com/madou1217/ai_home/internal/transport/http/opencoderelay"
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
func relayProviderIDs() []string {
	providers := make([]string, 0, len(codebuddyfamilyrelay.FamilyProviders)+4)
	providers = append(providers, codebuddyfamilyrelay.FamilyProviders...)
	providers = append(
		providers,
		clinerelay.ProviderID,
		grokrelay.ProviderID,
		kimirelay.ProviderID,
		opencoderelay.ProviderID,
	)
	return providers
}
