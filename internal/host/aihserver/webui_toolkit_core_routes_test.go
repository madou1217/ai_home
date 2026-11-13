package aihserver

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
)

type toolkitStubAuth bool

func (a toolkitStubAuth) Authorized(*http.Request) bool { return bool(a) }

func TestBuildWebUIToolkitCoreRoutesServeMuxCompatibility(t *testing.T) {
	cat, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatal(err)
	}
	routes, err := buildWebUIToolkitCoreRoutes(webuiRouteDependencies{
		Authorizer:  toolkitStubAuth(true),
		AIHomeDir:   t.TempDir(),
		HostHomeDir: t.TempDir(),
		Catalog:     cat,
	})
	if err != nil {
		t.Fatalf("buildWebUIToolkitCoreRoutes failed: %v", err)
	}
	if len(routes) == 0 {
		t.Fatal("expected non-empty toolkit core routes")
	}

	mux := http.NewServeMux()
	// 先注册同前缀的已有工具箱路由，验证全部模式在同一 ServeMux 中无冲突。
	noop := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	existingPatterns := []string{
		"GET /v1/management/webui/toolkit/apps/{appId}/settings",
		"PUT /v1/management/webui/toolkit/apps/{appId}/settings",
		"GET /v1/management/webui/toolkit/environments",
		"GET /v1/management/webui/toolkit/environments/targets",
		"GET /v1/management/webui/toolkit/provider-configs/{provider}",
		"GET /v1/management/webui/toolkit/edge/status",
		"GET /v1/management/webui/toolkit/native-resources",
		"GET /v1/management/webui/toolkit/subscription-aggregator/profiles",
	}
	for _, pat := range existingPatterns {
		mux.Handle(pat, noop)
	}
	for _, route := range routes {
		mux.Handle(route.Pattern, route.Handler)
	}

	// 验证典型路由都能正确进入处理器并返回合法响应码。
	for _, tc := range []struct {
		method string
		path   string
		want   int
	}{
		{http.MethodGet, "/v1/management/webui/toolkit/apps", http.StatusOK},
		{http.MethodGet, "/v1/management/webui/terminals", http.StatusOK},
		{http.MethodGet, "/v1/management/webui/toolkit/tools", http.StatusOK},
		{http.MethodGet, "/v1/management/webui/toolkit/tools/frpc/service", http.StatusOK},
		{http.MethodGet, "/v1/management/webui/toolkit/tools/jobs/missing", http.StatusNotFound},
		{http.MethodGet, "/v1/management/webui/app-install/jobs", http.StatusOK},
	} {
		req := httptest.NewRequest(tc.method, tc.path, nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Fatalf("%s %s = %d, want %d (%s)", tc.method, tc.path, rec.Code, tc.want, rec.Body.String())
		}
	}
}
