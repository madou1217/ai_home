package aihserver

import (
	"context"
	"net/http"
	"sort"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/clientversion"
	clinemodelcatalog "github.com/madou1217/ai_home/internal/adapters/cline/modelcatalog"
)

func testProviderCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return catalog
}

// 覆盖守卫：目录源注册表与刷新队列必须一一覆盖 Provider Catalog。
//
// 漏登记的两种形态都是静默的：
//   - 有 Catalog、没有目录源 → 该 Provider 的账号永远没有 account_models；
//   - 有目录源、没有刷新队列 → 周期重扫/首次恢复不会入队，目录永远为空。
//
// 之前正是靠手工维护两份名单，cline 出现过「账号在池里、目录为空」。
func TestModelProviderSourcesCoverEveryCatalogProvider(t *testing.T) {
	catalog := testProviderCatalog(t)
	// 目录源构造只持有依赖，不发请求；给真实客户端即可（本用例不出网）。
	sources, err := buildModelProviderSources(modelProviderContext{
		client:        &http.Client{},
		codexVersions: clientversion.Static("test-version"),
	})
	if err != nil {
		t.Fatalf("buildModelProviderSources() error = %v", err)
	}
	// NewModelDiscovery 会校验每条源的 Provider 规范且不重复，等于顺带守住「注册表里
	// 不能出现 Catalog 之外的 Provider」。
	discovery, err := accountapp.NewModelDiscovery(catalog, sources)
	if err != nil {
		t.Fatalf("NewModelDiscovery() error = %v", err)
	}
	registered := discovery.ProviderIDs()
	if len(registered) == 0 {
		t.Fatal("目录源注册表为空")
	}
	registeredSet := make(map[string]bool, len(registered))
	for _, providerID := range registered {
		registeredSet[providerID] = true
	}
	queues := modelRefreshProviderConcurrency(registered)
	var missingSource []string
	var missingQueue []string
	for _, definition := range catalog.List() {
		if !registeredSet[definition.ID] {
			missingSource = append(missingSource, definition.ID)
		}
		if queues[definition.ID] != modelRefreshConcurrency {
			missingQueue = append(missingQueue, definition.ID)
		}
	}
	sort.Strings(missingSource)
	sort.Strings(missingQueue)
	if len(missingSource) > 0 {
		t.Fatalf("这些 Provider 没有模型目录源（账号目录会永远为空）: %v", missingSource)
	}
	if len(missingQueue) > 0 {
		t.Fatalf("这些 Provider 没有模型刷新队列（周期重扫不会入队）: %v", missingQueue)
	}
}

// cline 的目录是静态清单：不联网、不依赖客户端。
//
// 装配上下文故意不给 HTTP 客户端与版本源——静态源若偷偷出网，这里会直接失败。
func TestClineModelSourceIsStatic(t *testing.T) {
	sources, err := buildClineModelProvider(modelProviderContext{})
	if err != nil {
		t.Fatalf("buildClineModelProvider() error = %v", err)
	}
	if len(sources) != 1 {
		t.Fatalf("cline 目录源数 = %d, want 1", len(sources))
	}
	source := sources[0]
	if source.ProviderID() != "cline" {
		t.Fatalf("ProviderID() = %q, want cline", source.ProviderID())
	}
	identity, err := accountcore.NewNativeSubjectIdentity("cline", "user_test")
	if err != nil {
		t.Fatalf("构造身份失败: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, []byte(`{"auth":{}}`))
	if err != nil {
		t.Fatalf("构造凭据失败: %v", err)
	}
	models, err := source.DiscoverModels(context.Background(), credential)
	if err != nil {
		t.Fatalf("DiscoverModels() error = %v", err)
	}
	if len(models) != len(clinemodelcatalog.KnownModels) {
		t.Fatalf("模型数 = %d, want %d", len(models), len(clinemodelcatalog.KnownModels))
	}
	for index, want := range clinemodelcatalog.KnownModels {
		if models[index] != want {
			t.Fatalf("models[%d] = %q, want %q", index, models[index], want)
		}
	}
}
