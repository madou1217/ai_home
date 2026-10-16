package aihserver

import (
	"testing"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/clientversion"
	"github.com/madou1217/ai_home/internal/adapters/codex/codexidentity"
	"github.com/madou1217/ai_home/internal/transport/http/codebuddyfamilyrelay"
)

// TestModelRefreshQueueCoversEveryDiscoveryProvider 守住「有发现策略的 Provider 必须
// 有刷新队列」：漏登记的失败是静默的——账号永远不会被周期重扫与首次恢复刷新，
// 模型目录一直为空，而错误只会表现为「这个 Provider 的模型路由不到」。
func TestModelRefreshQueueCoversEveryDiscoveryProvider(t *testing.T) {
	t.Parallel()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	discovery, err := newModelDiscovery(
		catalog,
		nil,
		clientversion.Static(codexidentity.Floor),
		nil,
	)
	if err != nil {
		t.Fatalf("newModelDiscovery() error = %v", err)
	}
	queue := modelRefreshProviderConcurrency()
	for _, providerID := range discovery.ProviderIDs() {
		if _, found := queue[providerID]; !found {
			t.Fatalf(
				"Provider %s 有发现策略但没有刷新队列：账号永远不会被刷新",
				providerID,
			)
		}
	}
	// 家族四支必须在两侧都出现（Node 侧守卫 test/go-core-servable-providers.test.js
	// 盯着同一个集合，缺一侧就是静默不刷新或透传通道空目录）。
	for _, providerID := range codebuddyfamilyrelay.FamilyProviders {
		if _, found := queue[providerID]; !found {
			t.Fatalf("家族 Provider %s 缺少刷新队列", providerID)
		}
		registered := false
		for _, discovered := range discovery.ProviderIDs() {
			if discovered == providerID {
				registered = true
				break
			}
		}
		if !registered {
			t.Fatalf("家族 Provider %s 缺少发现策略", providerID)
		}
	}
}
