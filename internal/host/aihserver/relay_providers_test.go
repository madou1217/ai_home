package aihserver

import (
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// TestModelRefreshQueuesAreCoveredByCatalogDeclarations 守住刷新队列与目录声明的一致性。
//
// 刷新队列里的每个 Provider 都必须能被模型目录构建接受：要么有 Canonical 工厂
// （codex / claude / agy），要么在 relayProviderIDs 的透传声明里。漏掉后者的
// 表现是 builder.Build 在 buildRule 里硬错误 ErrProviderRouteFactoryNotFound，
// 整个模型快照永不发布（/v1/models 5xx、别名不生效、路由判定拿不到可路由集合）。
func TestModelRefreshQueuesAreCoveredByCatalogDeclarations(t *testing.T) {
	canonical := map[string]struct{}{
		string(inference.ProviderCodex):  {},
		string(inference.ProviderClaude): {},
		string(inference.ProviderAgy):    {},
	}
	relay := make(map[string]struct{}, len(relayProviderIDs()))
	for _, providerID := range relayProviderIDs() {
		relay[providerID] = struct{}{}
	}
	for providerID := range modelRefreshProviderConcurrency() {
		_, hasFactory := canonical[providerID]
		_, isRelay := relay[providerID]
		if !hasFactory && !isRelay {
			t.Fatalf(
				"provider %q has a model refresh queue but no catalog declaration (canonical factory or relay)",
				providerID,
			)
		}
	}
}

// TestRelayProvidersHaveModelRefreshQueues 是反向守卫：透传 Provider 没有刷新队列
// 时账号永远不会被扫描，模型目录一直是空的，请求只会被判成 model_not_routable。
func TestRelayProvidersHaveModelRefreshQueues(t *testing.T) {
	queues := modelRefreshProviderConcurrency()
	for _, providerID := range relayProviderIDs() {
		if _, ok := queues[providerID]; !ok {
			t.Fatalf("relay provider %q has no model refresh queue", providerID)
		}
	}
}
