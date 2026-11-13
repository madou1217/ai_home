package aihserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	runtimeinmemory "github.com/madou1217/ai_home/internal/adapters/accountruntime/inmemory"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/transport/http/webuiimagestudioapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuitranslationapi"
)

type translationStudioTestAuthorizer struct{}

func (translationStudioTestAuthorizer) Authorized(req *http.Request) bool {
	return req != nil && req.Header.Get("Authorization") == "Bearer test-mgmt-key"
}

func TestBuildWebUITranslationStudioRoutes(t *testing.T) {
	t.Run("返回全部十七条路由并与现有切片路由无 ServeMux 模式冲突", func(t *testing.T) {
		aiHomeDir := t.TempDir()
		hostHomeDir := t.TempDir()
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

		rt, err := runtimeinmemory.New(time.Now)
		if err != nil {
			t.Fatalf("runtimeinmemory.New() error = %v", err)
		}

		deps := webuiRouteDependencies{
			Authorizer:     translationStudioTestAuthorizer{},
			AIHomeDir:      aiHomeDir,
			HostHomeDir:    hostHomeDir,
			Catalog:        catalog,
			Store:          store,
			AccountRuntime: rt,
		}
		accountSrc, err := buildImageStudioAccountSource(deps, aiHomeDir)
		if err != nil {
			t.Fatalf("buildImageStudioAccountSource() error = %v", err)
		}
		if accountSrc == nil {
			t.Fatal("expected non-nil image account source when Store, Catalog, and AccountRuntime are provided")
		}

		routes, err := buildWebUITranslationStudioRoutes(deps)
		if err != nil {
			t.Fatalf("buildWebUITranslationStudioRoutes() error = %v", err)
		}

		want := []string{
			"OPTIONS " + webuitranslationapi.Path + "/{rest...}",
			"GET " + webuitranslationapi.Path + "/settings",
			"POST " + webuitranslationapi.Path + "/settings",
			"GET " + webuitranslationapi.Path + "/providers",
			"POST " + webuitranslationapi.Path + "/providers",
			"GET " + webuitranslationapi.Path + "/languages",
			"POST " + webuitranslationapi.Path + "/detect",
			"GET " + webuitranslationapi.Path + "/models",
			"POST " + webuitranslationapi.Path + "/stream",
			"GET " + webuiimagestudioapi.Path + "/models",
			"GET " + webuiimagestudioapi.Path + "/sessions",
			"POST " + webuiimagestudioapi.Path + "/sessions",
			"GET " + webuiimagestudioapi.Path + "/sessions/{sessionId}",
			"PATCH " + webuiimagestudioapi.Path + "/sessions/{sessionId}",
			"DELETE " + webuiimagestudioapi.Path + "/sessions/{sessionId}",
			"POST " + webuiimagestudioapi.Path + "/sessions/{sessionId}/runs",
			"GET " + webuiimagestudioapi.Path + "/sessions/{sessionId}/assets/{assetId}",
		}
		if len(routes) != len(want) {
			t.Fatalf("路由数量 = %d, want %d", len(routes), len(want))
		}
		for i, expected := range want {
			if routes[i].Pattern != expected {
				t.Fatalf("route[%d].Pattern = %q, want %q", i, routes[i].Pattern, expected)
			}
			if routes[i].Handler == nil {
				t.Fatalf("route[%d].Handler = nil", i)
			}
		}

		mux := http.NewServeMux()
		for _, sibling := range []func(webuiRouteDependencies) ([]webuiRoute, error){
			buildWebUIKimiRoutes,
			buildWebUIModelsRulesRoutes,
			buildWebUIProjectsFSRoutes,
			buildWebUISessionsWatchRoutes,
		} {
			sibRoutes, sibErr := sibling(deps)
			if sibErr != nil {
				t.Fatalf("sibling builder error = %v", sibErr)
			}
			for _, r := range sibRoutes {
				mux.Handle(r.Pattern, r.Handler)
			}
		}
		for _, r := range routes {
			mux.Handle(r.Pattern, r.Handler)
		}

		// 验证扩展预检与鉴权保护。
		optReq := httptest.NewRequest(http.MethodOptions, webuitranslationapi.Path+"/stream", nil)
		optReq.Header.Set("Origin", "chrome-extension://abcdefghijklmnop")
		optRec := httptest.NewRecorder()
		mux.ServeHTTP(optRec, optReq)
		if optRec.Code != http.StatusNoContent {
			t.Fatalf("OPTIONS status = %d, want 204", optRec.Code)
		}
		if got := optRec.Header().Get("Access-Control-Allow-Origin"); got != "chrome-extension://abcdefghijklmnop" {
			t.Fatalf("CORS Allow-Origin = %q", got)
		}

		unauthReq := httptest.NewRequest(http.MethodGet, webuiimagestudioapi.Path+"/sessions", nil)
		unauthRec := httptest.NewRecorder()
		mux.ServeHTTP(unauthRec, unauthReq)
		if unauthRec.Code != http.StatusUnauthorized {
			t.Fatalf("unauth GET sessions status = %d, want 401", unauthRec.Code)
		}

		// 验证翻译语种检测、设置读写与模型目录端到端连通。
		detectReq := httptest.NewRequest(http.MethodPost, webuitranslationapi.Path+"/detect", strings.NewReader(`{"text":"你好，世界"}`))
		detectReq.Header.Set("Authorization", "Bearer test-mgmt-key")
		detectRec := httptest.NewRecorder()
		mux.ServeHTTP(detectRec, detectReq)
		if detectRec.Code != http.StatusOK {
			t.Fatalf("POST /detect status = %d body=%s", detectRec.Code, detectRec.Body.String())
		}
		var detectBody struct {
			OK   bool   `json:"ok"`
			Code string `json:"code"`
		}
		if err := json.Unmarshal(detectRec.Body.Bytes(), &detectBody); err != nil {
			t.Fatalf("decode detect json: %v", err)
		}
		if !detectBody.OK || detectBody.Code != "zh-Hans" {
			t.Fatalf("detect body = %+v", detectBody)
		}

		langReq := httptest.NewRequest(http.MethodGet, webuitranslationapi.Path+"/languages", nil)
		langReq.Header.Set("Authorization", "Bearer test-mgmt-key")
		langRec := httptest.NewRecorder()
		mux.ServeHTTP(langRec, langReq)
		if langRec.Code != http.StatusOK {
			t.Fatalf("GET /languages status = %d", langRec.Code)
		}

		modelsReq := httptest.NewRequest(http.MethodGet, webuitranslationapi.Path+"/models", nil)
		modelsReq.Header.Set("Authorization", "Bearer test-mgmt-key")
		modelsRec := httptest.NewRecorder()
		mux.ServeHTTP(modelsRec, modelsReq)
		if modelsRec.Code != http.StatusOK {
			t.Fatalf("GET /translation/models status = %d body=%s", modelsRec.Code, modelsRec.Body.String())
		}

		// 验证 Image Studio 创建、查询、改名与删除会话端到端连通。
		createReq := httptest.NewRequest(http.MethodPost, webuiimagestudioapi.Path+"/sessions", strings.NewReader(`{"title":"Routes Smoke"}`))
		createReq.Header.Set("Authorization", "Bearer test-mgmt-key")
		createRec := httptest.NewRecorder()
		mux.ServeHTTP(createRec, createReq)
		if createRec.Code != http.StatusCreated {
			t.Fatalf("POST /sessions status = %d body=%s", createRec.Code, createRec.Body.String())
		}
		var createResp struct {
			OK      bool `json:"ok"`
			Session struct {
				ID    string `json:"id"`
				Title string `json:"title"`
			} `json:"session"`
		}
		if err := json.Unmarshal(createRec.Body.Bytes(), &createResp); err != nil {
			t.Fatalf("decode create session json: %v", err)
		}
		if !createResp.OK || createResp.Session.ID == "" {
			t.Fatalf("unexpected createResp: %+v", createResp)
		}

		patchReq := httptest.NewRequest(http.MethodPatch, webuiimagestudioapi.Path+"/sessions/"+createResp.Session.ID, strings.NewReader(`{"title":"Renamed Smoke"}`))
		patchReq.Header.Set("Authorization", "Bearer test-mgmt-key")
		patchRec := httptest.NewRecorder()
		mux.ServeHTTP(patchRec, patchReq)
		if patchRec.Code != http.StatusOK {
			t.Fatalf("PATCH /sessions/{id} status = %d body=%s", patchRec.Code, patchRec.Body.String())
		}

		studioModelsReq := httptest.NewRequest(http.MethodGet, webuiimagestudioapi.Path+"/models", nil)
		studioModelsReq.Header.Set("Authorization", "Bearer test-mgmt-key")
		studioModelsRec := httptest.NewRecorder()
		mux.ServeHTTP(studioModelsRec, studioModelsReq)
		if studioModelsRec.Code != http.StatusOK {
			t.Fatalf("GET /studio/image/models status = %d body=%s", studioModelsRec.Code, studioModelsRec.Body.String())
		}
	})

	t.Run("缺少 Authorizer 返回明确错误", func(t *testing.T) {
		if _, err := buildWebUITranslationStudioRoutes(webuiRouteDependencies{AIHomeDir: t.TempDir()}); err == nil {
			t.Fatal("expected error when Authorizer is nil")
		}
	})
}
