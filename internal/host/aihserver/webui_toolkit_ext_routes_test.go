package aihserver

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/transport/http/webuitoolkitextapi"
)

type toolkitExtStubAuthorizer struct{}

func (toolkitExtStubAuthorizer) Authorized(r *http.Request) bool {
	return r.Header.Get("Authorization") == "Bearer toolkit-ext-key"
}

func TestBuildWebUIToolkitExtRoutesAndServeMuxMount(t *testing.T) {
	emptyRoutes, err := buildWebUIToolkitExtRoutes(webuiRouteDependencies{})
	if err != nil {
		t.Fatalf("Authorizer 为空时不应报错: %v", err)
	}
	if len(emptyRoutes) != 0 {
		t.Fatalf("Authorizer 为空时应返回空路由列表，实际 %d", len(emptyRoutes))
	}

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatal(err)
	}
	routes, err := buildWebUIToolkitExtRoutes(webuiRouteDependencies{
		Authorizer:  toolkitExtStubAuthorizer{},
		AIHomeDir:   t.TempDir(),
		HostHomeDir: t.TempDir(),
		Catalog:     catalog,
	})
	if err != nil {
		t.Fatalf("装配 Toolkit 扩展路由失败: %v", err)
	}
	if len(routes) != 38 {
		t.Fatalf("预期 38 条路由，实际 %d", len(routes))
	}

	mux := http.NewServeMux()
	for _, route := range routes {
		mux.Handle(route.Pattern, route.Handler)
	}

	for _, path := range []string{
		webuitoolkitextapi.EdgePath,
		webuitoolkitextapi.ProviderConfigsPath,
		webuitoolkitextapi.SubAggregatorPath,
	} {
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.Header.Set("Authorization", "Bearer toolkit-ext-key")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("GET %s expected 200, got %d body=%s", path, rec.Code, rec.Body.String())
		}
	}
}
