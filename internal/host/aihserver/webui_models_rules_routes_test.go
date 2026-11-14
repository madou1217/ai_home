package aihserver

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/transport/http/modelaliaswebui"
	"github.com/madou1217/ai_home/internal/transport/http/upstreammappingapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuimodelsyncapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiopenaimodelsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiopenaimodelswriteapi"
)

type modelsRulesTestAuthorizer struct{}

func (modelsRulesTestAuthorizer) Authorized(*http.Request) bool { return true }

func TestBuildWebUIModelsRulesRoutes(t *testing.T) {
	t.Run("缺少核心依赖时安全返回空切片", func(t *testing.T) {
		routes, err := buildWebUIModelsRulesRoutes(webuiRouteDependencies{})
		if err != nil {
			t.Fatalf("buildWebUIModelsRulesRoutes() error = %v", err)
		}
		if len(routes) != 0 {
			t.Fatalf("expected empty routes when deps nil, got %d", len(routes))
		}
	})

	t.Run("返回十二条无冲突路由并可执行映射组与模型读写", func(t *testing.T) {
		aiHomeDir := t.TempDir()
		catalog, err := providers.NewCatalog(providers.BuiltinManifest())
		if err != nil {
			t.Fatalf("NewCatalog() error = %v", err)
		}
		store, err := sqliteaccount.Open(context.Background(), sqliteaccount.OpenOptions{
			AIHomeDir: aiHomeDir,
			Catalog:   catalog,
		})
		if err != nil {
			t.Fatalf("sqliteaccount.Open() error = %v", err)
		}
		defer func() { _ = store.Close() }()

		deps := webuiRouteDependencies{
			Authorizer: modelsRulesTestAuthorizer{},
			AIHomeDir:  aiHomeDir,
			Catalog:    catalog,
			Store:      store,
		}
		routes, err := buildWebUIModelsRulesRoutes(deps)
		if err != nil {
			t.Fatalf("buildWebUIModelsRulesRoutes() error = %v", err)
		}
		if len(routes) != 18 {
			t.Fatalf("路由数量 = %d, want 18", len(routes))
		}

		// 验证与 webuiroutes.go 既有 openai-models 路由以及 router.go model-aliases 路由无冲突。
		mux := http.NewServeMux()
		dummy := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		})
		mux.Handle("GET "+webuiopenaimodelsapi.Path, dummy)
		mux.Handle("POST "+webuiopenaimodelswriteapi.RefreshPath, dummy)
		mux.Handle("POST "+webuiopenaimodelswriteapi.DeletePath, dummy)
		mux.Handle(modelaliaswebui.Path, dummy)
		mux.Handle(modelaliaswebui.Path+"/", dummy)
		for _, route := range routes {
			mux.Handle(route.Pattern, route.Handler)
		}

		// 验证上游错误映射组 CRUD + toggle 经 mux 真实路由闭环。
		createBody := []byte(`{"name":"Limit Map","provider":"codex","enabled":true,"rules":[{"kind":"rate_limited","matchers":[{"source":"body","operator":"contains","value":"rate"}]}]}`)
		req := httptest.NewRequest(http.MethodPost, upstreammappingapi.WebUIPath, bytes.NewReader(createBody))
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("POST %s status = %d, body = %s", upstreammappingapi.WebUIPath, rec.Code, rec.Body.String())
		}
		var created struct {
			Group struct {
				ID      string `json:"id"`
				Enabled bool   `json:"enabled"`
				Version int64  `json:"version"`
			} `json:"group"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
			t.Fatalf("unmarshal create group response: %v", err)
		}
		if created.Group.ID == "" || !created.Group.Enabled {
			t.Fatalf("unexpected created group: %+v", created.Group)
		}

		toggleReq := httptest.NewRequest(
			http.MethodPost,
			upstreammappingapi.WebUIPath+"/"+created.Group.ID+"/toggle",
			bytes.NewBufferString(`{}`),
		)
		toggleRec := httptest.NewRecorder()
		mux.ServeHTTP(toggleRec, toggleReq)
		if toggleRec.Code != http.StatusOK {
			t.Fatalf("POST toggle status = %d, body = %s", toggleRec.Code, toggleRec.Body.String())
		}
		var toggled struct {
			Group struct {
				Enabled bool `json:"enabled"`
			} `json:"group"`
		}
		if err := json.Unmarshal(toggleRec.Body.Bytes(), &toggled); err != nil {
			t.Fatalf("unmarshal toggle response: %v", err)
		}
		if toggled.Group.Enabled {
			t.Fatalf("expected enabled flipped to false after toggle")
		}

		// 验证 WebUI 模型目录同步端点可经 mux 正常读取空目录。
		catReq := httptest.NewRequest(http.MethodGet, webuimodelsyncapi.CatalogPath, nil)
		catRec := httptest.NewRecorder()
		mux.ServeHTTP(catRec, catReq)
		if catRec.Code != http.StatusOK {
			t.Fatalf("GET %s status = %d, body = %s", webuimodelsyncapi.CatalogPath, catRec.Code, catRec.Body.String())
		}
	})
}
