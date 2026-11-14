package aihserver

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/runtime/pluginhost"
	"github.com/madou1217/ai_home/internal/runtime/pricingcatalog"
	"github.com/madou1217/ai_home/internal/transport/http/webuicontrolplanebootstrapapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuipluginapi"
)

type stubPluginRouteAuthorizer struct{ allow bool }

func (a stubPluginRouteAuthorizer) Authorized(*http.Request) bool { return a.allow }

func newOfflinePricingServiceForPluginTest(t *testing.T, aiHomeDir string) *pricingcatalog.Service {
	t.Helper()
	store, err := pricingcatalog.NewStore(aiHomeDir)
	if err != nil {
		t.Fatalf("pricingcatalog.NewStore failed: %v", err)
	}
	client := stubPricingHTTPClient{
		do: func(req *http.Request) (*http.Response, error) {
			switch {
			case strings.Contains(req.URL.String(), "litellm"):
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": []string{"application/json"}},
					Body:       io.NopCloser(strings.NewReader(`{"anthropic/claude-sonnet-4":{"litellm_provider":"anthropic","input_cost_per_token":0.000003,"output_cost_per_token":0.000015}}`)),
				}, nil
			case strings.Contains(req.URL.String(), "openrouter"):
				return &http.Response{
					StatusCode: http.StatusOK,
					Header:     http.Header{"Content-Type": []string{"application/json"}},
					Body:       io.NopCloser(strings.NewReader(`{"data":[{"id":"openai/gpt-4.1","pricing":{"prompt":"0.000002","completion":"0.000008"}}]}`)),
				}, nil
			default:
				return &http.Response{
					StatusCode: http.StatusNotFound,
					Body:       io.NopCloser(strings.NewReader(`{}`)),
				}, nil
			}
		},
	}
	svc, err := pricingcatalog.NewService(pricingcatalog.ServiceDependencies{
		Store:      store,
		HTTPClient: client,
		Now:        func() time.Time { return time.Date(2026, 5, 16, 12, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatalf("pricingcatalog.NewService failed: %v", err)
	}
	return svc
}

func TestBuildWebUIPluginRoutes_NoAuthorizerSkipsCleanly(t *testing.T) {
	routes, err := buildWebUIPluginRoutes(webuiRouteDependencies{})
	if err != nil {
		t.Fatalf("buildWebUIPluginRoutes returned unexpected error: %v", err)
	}
	if len(routes) != 0 {
		t.Fatalf("expected 0 routes without authorizer, got %d", len(routes))
	}
}

func TestBuildWebUIPluginRoutes_ServeMuxAndFailClosedDoctorWithHostService(t *testing.T) {
	aiHomeDir := t.TempDir()
	pricingSvc := newOfflinePricingServiceForPluginTest(t, aiHomeDir)

	// 1) 未装配 PricingService 时，/pricing/refresh 也必须 503 失败关闭。
	routesNoPricing, err := buildWebUIPluginRoutes(webuiRouteDependencies{
		Authorizer: stubPluginRouteAuthorizer{allow: true},
	})
	if err != nil {
		t.Fatalf("buildWebUIPluginRoutes(no pricing) failed: %v", err)
	}
	muxNoPricing := http.NewServeMux()
	for _, r := range routesNoPricing {
		muxNoPricing.Handle(r.Pattern, r.Handler)
	}
	reqNoPricing := httptest.NewRequest(http.MethodPost, webuipluginapi.PricingRefreshPath, strings.NewReader(`{}`))
	reqNoPricing.Header.Set("Content-Type", "application/json")
	recNoPricing := httptest.NewRecorder()
	muxNoPricing.ServeHTTP(recNoPricing, reqNoPricing)
	if recNoPricing.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 when PricingService nil, got %d %s", recNoPricing.Code, recNoPricing.Body.String())
	}

	// 2) nil hostService + 已装配 PricingService：需要 HostService 的端点一律 503 失败关闭；
	//    /pricing/refresh 则以 runtimeActive:false 完成社区价格刷新。
	failClosedRoutes, err := buildWebUIPluginRoutes(webuiRouteDependencies{
		Authorizer:     stubPluginRouteAuthorizer{allow: true},
		PricingService: pricingSvc,
	})
	if err != nil {
		t.Fatalf("buildWebUIPluginRoutes failed: %v", err)
	}
	if len(failClosedRoutes) != 8 {
		t.Fatalf("expected 8 plugin routes, got %d", len(failClosedRoutes))
	}

	muxFail := http.NewServeMux()
	muxFail.Handle("GET "+webuicontrolplanebootstrapapi.Path, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	for _, r := range failClosedRoutes {
		muxFail.Handle(r.Pattern, r.Handler)
	}

	for _, tc := range []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, webuipluginapi.DoctorPath, ""},
		{http.MethodPost, webuipluginapi.InvokePath, `{"contributionId":"p:c"}`},
		{http.MethodPost, webuipluginapi.PricingQuotePath, `{"provider":"anthropic","model":"claude-sonnet-4"}`},
		{http.MethodGet, webuipluginapi.AccountsSourcesPath + "?provider=codex", ""},
		{http.MethodPost, webuipluginapi.AccountsImportPath, `{"provider":"codex","sourceId":"s"}`},
		{http.MethodPost, webuipluginapi.AccountsRefreshPath, `{"provider":"codex","accountRef":"acct_1"}`},
		{http.MethodPost, webuipluginapi.AccountsMaterializePath, `{"provider":"codex","accountRef":"acct_1","credential":{}}`},
	} {
		req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
		if tc.body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		rec := httptest.NewRecorder()
		muxFail.ServeHTTP(rec, req)
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("%s %s expected 503 when HostService nil, got %d %s", tc.method, tc.path, rec.Code, rec.Body.String())
		}
	}

	reqRefresh := httptest.NewRequest(http.MethodPost, webuipluginapi.PricingRefreshPath, strings.NewReader(`{}`))
	reqRefresh.Header.Set("Content-Type", "application/json")
	recRefresh := httptest.NewRecorder()
	muxFail.ServeHTTP(recRefresh, reqRefresh)
	if recRefresh.Code != http.StatusOK {
		t.Fatalf("POST /pricing/refresh expected 200 with offline community sources, got %d %s", recRefresh.Code, recRefresh.Body.String())
	}

	// 3) 传入真实 pluginhost.Service 时，/doctor 应返回结构化诊断 + 审计 + 定价健康状态。
	hostSvc, err := pluginhost.NewService(pluginhost.ServiceOptions{
		AIHomeDir:      aiHomeDir,
		PricingService: pricingSvc,
	})
	if err != nil {
		t.Fatalf("pluginhost.NewService failed: %v", err)
	}
	t.Cleanup(func() { _ = hostSvc.Close() })
	hostSvc.Audit("trust", map[string]any{"pluginId": "demo.plugin"})

	liveRoutes, err := buildWebUIPluginRoutesWithHostService(webuiRouteDependencies{
		Authorizer:     stubPluginRouteAuthorizer{allow: true},
		AIHomeDir:      aiHomeDir,
		PricingService: pricingSvc,
	}, hostSvc)
	if err != nil {
		t.Fatalf("buildWebUIPluginRoutesWithHostService failed: %v", err)
	}
	muxLive := http.NewServeMux()
	for _, r := range liveRoutes {
		muxLive.Handle(r.Pattern, r.Handler)
	}

	rec := httptest.NewRecorder()
	muxLive.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, webuipluginapi.DoctorPath, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /doctor failed: %d %s", rec.Code, rec.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("unmarshal /doctor failed: %v", err)
	}
	if payload["pricing"] == nil {
		t.Fatalf("expected pricing doctor report in /doctor payload: %v", payload)
	}
	auditItems, _ := payload["audit"].([]any)
	if len(auditItems) != 1 {
		t.Fatalf("expected 1 audit item in /doctor payload, got %v", payload["audit"])
	}
}

func TestPluginAccountRegistrar_ImportRefreshAndTombstone(t *testing.T) {
	ctx := context.Background()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog failed: %v", err)
	}
	aiHomeDir := t.TempDir()
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: aiHomeDir,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open failed: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	registrarSvc, err := accountapp.NewRegistrar(catalog, store, time.Now)
	if err != nil {
		t.Fatalf("NewRegistrar failed: %v", err)
	}
	reauthSvc, err := accountapp.NewReauthenticator(catalog, store, time.Now)
	if err != nil {
		t.Fatalf("NewReauthenticator failed: %v", err)
	}
	importer, err := accountapp.NewAccountImporter(registrarSvc, store, reauthSvc)
	if err != nil {
		t.Fatalf("NewAccountImporter failed: %v", err)
	}

	registrar := newPluginAccountRegistrar(webuiRouteDependencies{
		AIHomeDir:       aiHomeDir,
		Catalog:         catalog,
		Store:           store,
		AccountImporter: importer,
	})
	if registrar == nil {
		t.Fatal("expected non-nil registrar when store and importer provided")
	}

	runtimeDir := t.TempDir()
	geminiDir := filepath.Join(runtimeDir, ".gemini")
	if err := os.MkdirAll(geminiDir, 0o700); err != nil {
		t.Fatalf("mkdir geminiDir failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(geminiDir, "oauth_creds.json"), []byte(`{"access_token":"tok-1","refresh_token":"rt-1","expiry_date":1800000000000}`), 0o600); err != nil {
		t.Fatalf("write oauth_creds failed: %v", err)
	}
	if err := os.WriteFile(filepath.Join(geminiDir, "google_accounts.json"), []byte(`{"active":"plugin-user@example.com"}`), 0o600); err != nil {
		t.Fatalf("write google_accounts failed: %v", err)
	}

	// 1) 首次导入创建账号并写 UI 状态。
	reg1, err := registrar.RegisterProjection(ctx, pluginhost.ProjectionRegisterRequest{
		Provider:        "gemini",
		RuntimeDir:      runtimeDir,
		RespectDeletion: true,
	})
	if err != nil {
		t.Fatalf("RegisterProjection import failed: %v", err)
	}
	if !reg1.Registered || reg1.AccountRef == "" || reg1.CLIAccountID == "" || reg1.Provider != "gemini" {
		t.Fatalf("unexpected import registration result: %+v", reg1)
	}

	// 2) accountRef 不匹配时拒绝覆盖其他账号。
	mismatch, err := registrar.RegisterProjection(ctx, pluginhost.ProjectionRegisterRequest{
		Provider:   "gemini",
		RuntimeDir: runtimeDir,
		AccountRef: "acct_other_000000000000",
	})
	if err != nil {
		t.Fatalf("RegisterProjection mismatch check failed: %v", err)
	}
	if mismatch.Registered || mismatch.Reason != "account_ref_mismatch" {
		t.Fatalf("expected account_ref_mismatch, got %+v", mismatch)
	}

	// 3) 刷新已有账号：带更新 expiry_date 更新投影并匹配既有 accountRef。
	if err := os.WriteFile(filepath.Join(geminiDir, "oauth_creds.json"), []byte(`{"access_token":"tok-2","refresh_token":"rt-2","expiry_date":1900000000000}`), 0o600); err != nil {
		t.Fatalf("rewrite oauth_creds failed: %v", err)
	}
	reg2, err := registrar.RegisterProjection(ctx, pluginhost.ProjectionRegisterRequest{
		Provider:        "gemini",
		RuntimeDir:      runtimeDir,
		AccountRef:      reg1.AccountRef,
		RespectDeletion: false,
	})
	if err != nil {
		t.Fatalf("RegisterProjection refresh failed: %v", err)
	}
	if !reg2.Registered || reg2.AccountRef != reg1.AccountRef {
		t.Fatalf("expected refresh to keep accountRef %q, got %+v", reg1.AccountRef, reg2)
	}

	// 4) 删除账号后 RespectDeletion=true 禁止自动复活。
	ref, err := accountcore.ParseAccountRef(reg1.AccountRef)
	if err != nil {
		t.Fatalf("ParseAccountRef failed: %v", err)
	}
	if err := store.DeleteAccount(ctx, ref); err != nil {
		t.Fatalf("DeleteAccount failed: %v", err)
	}
	tombResult, err := registrar.RegisterProjection(ctx, pluginhost.ProjectionRegisterRequest{
		Provider:        "gemini",
		RuntimeDir:      runtimeDir,
		RespectDeletion: true,
	})
	if err != nil {
		t.Fatalf("RegisterProjection tombstone check failed: %v", err)
	}
	if tombResult.Registered || tombResult.Reason != "account_deleted_by_user" {
		t.Fatalf("expected account_deleted_by_user, got %+v", tombResult)
	}
}

func TestCollectProviderPluginAuthSourcesAndIdentityHelper(t *testing.T) {
	ctx := context.Background()
	empty, err := collectProviderPluginAuthSources(ctx, nil, "codex")
	if err != nil || empty == nil || len(empty) != 0 {
		t.Fatalf("expected empty non-nil slice when hostService nil, got %+v err=%v", empty, err)
	}
	if newPricingSnapshotCollector(nil) != nil {
		t.Fatal("expected nil snapshot collector when hostService nil")
	}

	hostSvc, err := pluginhost.NewService(pluginhost.ServiceOptions{
		AIHomeDir: t.TempDir(),
	})
	if err != nil {
		t.Fatalf("pluginhost.NewService failed: %v", err)
	}
	t.Cleanup(func() { _ = hostSvc.Close() })

	// 运行时未启动时 ListAccountSources 返回 plugin_runtime_inactive；聚合来源辅助应安全退化为空集合。
	sources, err := collectProviderPluginAuthSources(ctx, hostSvc, "codex")
	if err != nil {
		t.Fatalf("collectProviderPluginAuthSources inactive failed: %v", err)
	}
	if len(sources) != 0 {
		t.Fatalf("expected 0 sources on inactive runtime, got %+v", sources)
	}
	if newPricingSnapshotCollector(hostSvc) == nil {
		t.Fatal("expected non-nil pricing snapshot collector when hostService non-nil")
	}

	if got := extractPluginAuthSourceIdentity(json.RawMessage(`"  user@example.com  "`)); got != "user@example.com" {
		t.Fatalf("unexpected string identity: %q", got)
	}
	if got := extractPluginAuthSourceIdentity(json.RawMessage(`{"sub": "123"}`)); got != `{"sub":"123"}` {
		t.Fatalf("unexpected object identity: %q", got)
	}
	if got := extractPluginAuthSourceIdentity(json.RawMessage(`null`)); got != "" {
		t.Fatalf("expected empty identity for null, got %q", got)
	}
}
