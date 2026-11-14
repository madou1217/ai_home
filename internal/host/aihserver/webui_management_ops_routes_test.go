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
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/accountstate"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/managementops"
	"github.com/madou1217/ai_home/internal/transport/http/webuimanagementapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiserverrestartapi"
)

type stubMgmtAuthorizer struct{ allow bool }

func (a stubMgmtAuthorizer) Authorized(*http.Request) bool { return a.allow }

type stubMgmtRestarter struct{}

func (stubMgmtRestarter) RestartServer(context.Context) (managementops.RestartResponse, error) {
	return managementops.RestartResponse{
		OK:            true,
		Action:        "restart",
		Running:       true,
		PID:           7788,
		Started:       true,
		AppliedConfig: map[string]any{"port": 9527, "apiKey": "", "managementKey": ""},
	}, nil
}

func TestBuildWebUIManagementOpsRoutes_NoAuthorizerSkipsCleanly(t *testing.T) {
	routes, err := buildWebUIManagementOpsRoutes(webuiRouteDependencies{})
	if err != nil {
		t.Fatalf("buildWebUIManagementOpsRoutes(empty) error = %v", err)
	}
	if len(routes) != 0 {
		t.Fatalf("expected 0 routes when Authorizer is nil, got %d", len(routes))
	}
}

func TestBuildWebUIManagementOpsRoutes_NoServeMuxConflictsAndWorksEndToEnd(t *testing.T) {
	ctx := context.Background()
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	cat, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	acctStore, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: aiHome,
		Catalog:   cat,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	defer func() { _ = acctStore.Close() }()

	dbPath, err := appstate.DatabasePath(aiHome)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	usageStore, err := managementops.NewUsageStore(ctx, dbPath, catalogProviderIDs(cat), time.Now)
	if err != nil {
		t.Fatalf("NewUsageStore() error = %v", err)
	}
	defer func() { _ = usageStore.Close() }()
	if _, err := usageStore.DB().ExecContext(ctx, `CREATE TABLE IF NOT EXISTS account_refs (
		account_ref TEXT PRIMARY KEY,
		provider TEXT NOT NULL,
		created_at INTEGER NOT NULL,
		updated_at INTEGER NOT NULL
	)`); err != nil {
		t.Fatalf("create account_refs error = %v", err)
	}
	if err := accountstate.EnsureSchema(ctx, usageStore.DB()); err != nil {
		t.Fatalf("accountstate.EnsureSchema() error = %v", err)
	}

	routes, err := buildWebUIManagementOpsRoutesWithPorts(webuiRouteDependencies{
		Authorizer:    stubMgmtAuthorizer{allow: true},
		AIHomeDir:     aiHome,
		HostHomeDir:   hostHome,
		Catalog:       cat,
		Store:         acctStore,
		ManagementKey: func() string { return "secret" },
	}, webuiManagementOpsPorts{
		UsageStore: usageStore,
		Restarter:  stubMgmtRestarter{},
	})
	if err != nil {
		t.Fatalf("buildWebUIManagementOpsRoutesWithPorts() error = %v", err)
	}
	if len(routes) != 31 {
		t.Fatalf("len(routes) = %d, want 31", len(routes))
	}

	mux := http.NewServeMux()
	for _, r := range routes {
		mux.Handle(r.Pattern, r.Handler)
	}

	// Verify /status
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, webuimanagementapi.StatusPath, nil))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"backend":"go-core"`) {
		t.Fatalf("GET /status code=%d body=%s", rec.Code, rec.Body.String())
	}

	// 浏览器正式面：/v0/webui/management/* 与管理工作面是同一份实现。
	pubRec := httptest.NewRecorder()
	mux.ServeHTTP(pubRec, httptest.NewRequest(http.MethodGet, "/v0/webui/management/status", nil))
	if pubRec.Code != http.StatusOK || !strings.Contains(pubRec.Body.String(), `"backend":"go-core"`) {
		t.Fatalf("GET /v0/webui/management/status code=%d body=%s", pubRec.Code, pubRec.Body.String())
	}

	// Verify /restart delegates through configured Restarter port
	rRec := httptest.NewRecorder()
	mux.ServeHTTP(rRec, httptest.NewRequest(http.MethodPost, webuimanagementapi.RestartPath, nil))
	if rRec.Code != http.StatusOK || !strings.Contains(rRec.Body.String(), `"pid":7788`) {
		t.Fatalf("POST /restart code=%d body=%s", rRec.Code, rRec.Body.String())
	}

	// Verify /state-index/upsert -> /usage/stats -> /usage/dashboard/query/{jobId}
	upReq := httptest.NewRequest(http.MethodPost, webuimanagementapi.StateIndexUpsertPath, strings.NewReader(`{"provider":"codex","accountRef":"acct_0123456789abcdef0123","state":{"configured":true}}`))
	upReq.Header.Set("Content-Type", "application/json")
	upRec := httptest.NewRecorder()
	mux.ServeHTTP(upRec, upReq)
	if upRec.Code != http.StatusOK || !strings.Contains(upRec.Body.String(), `"updated":true`) {
		t.Fatalf("POST /state-index/upsert code=%d body=%s", upRec.Code, upRec.Body.String())
	}

	qStart := httptest.NewRecorder()
	mux.ServeHTTP(qStart, httptest.NewRequest(http.MethodPost, webuimanagementapi.UsageDashboardQueryPath+"?from=2026-02-01&to=2026-02-01", nil))
	if qStart.Code != http.StatusAccepted {
		t.Fatalf("POST /usage/dashboard/query code=%d body=%s", qStart.Code, qStart.Body.String())
	}
	var started struct {
		Job struct {
			ID string `json:"id"`
		} `json:"job"`
	}
	if err := json.Unmarshal(qStart.Body.Bytes(), &started); err != nil || started.Job.ID == "" {
		t.Fatalf("decode query job err=%v body=%s", err, qStart.Body.String())
	}
	qGet := httptest.NewRecorder()
	mux.ServeHTTP(qGet, httptest.NewRequest(http.MethodGet, webuimanagementapi.UsageDashboardQueryPath+"/"+started.Job.ID, nil))
	if qGet.Code != http.StatusOK {
		t.Fatalf("GET query job code=%d body=%s", qGet.Code, qGet.Body.String())
	}
	qDel := httptest.NewRecorder()
	mux.ServeHTTP(qDel, httptest.NewRequest(http.MethodDelete, webuimanagementapi.UsageDashboardQueryPath+"/"+started.Job.ID, nil))
	if qDel.Code != http.StatusOK {
		t.Fatalf("DELETE query job code=%d body=%s", qDel.Code, qDel.Body.String())
	}
}

func TestBuildWebUIManagementOpsRoutes_DefaultNativeRestarterWiring(t *testing.T) {
	// 1. AIHomeDir 与 HostHomeDir 均为空时保持 nil restarter -> 503 management_restart_unavailable
	emptyRoutes, err := buildWebUIManagementOpsRoutes(webuiRouteDependencies{
		Authorizer: stubMgmtAuthorizer{allow: true},
	})
	if err != nil {
		t.Fatalf("buildWebUIManagementOpsRoutes(empty dir) error = %v", err)
	}
	emptyMux := http.NewServeMux()
	for _, r := range emptyRoutes {
		emptyMux.Handle(r.Pattern, r.Handler)
	}
	rec := httptest.NewRecorder()
	emptyMux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, webuimanagementapi.RestartPath, nil))
	if rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), `"management_restart_unavailable"`) {
		t.Fatalf("expected 503 management_restart_unavailable when AIHomeDir empty, got %d body=%s", rec.Code, rec.Body.String())
	}

	// 2. 提供 AIHomeDir 时自动装配 NativeRestarter；测试注入无服务探测，
	// 避免依赖本机是否真的挂着 launchd/systemd 服务。
	wiredRoutes, err := buildWebUIManagementOpsRoutesWithPorts(webuiRouteDependencies{
		Authorizer: stubMgmtAuthorizer{allow: true},
		AIHomeDir:  t.TempDir(),
	}, webuiManagementOpsPorts{
		RestartCommandResolver: func() (string, []string, error) {
			return "", nil, webuiserverrestartapi.ErrRestartUnavailable
		},
	})
	if err != nil {
		t.Fatalf("buildWebUIManagementOpsRoutes(with aiHome) error = %v", err)
	}
	wiredMux := http.NewServeMux()
	for _, r := range wiredRoutes {
		wiredMux.Handle(r.Pattern, r.Handler)
	}
	rec = httptest.NewRecorder()
	wiredMux.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, webuimanagementapi.RestartPath, nil))
	if rec.Code != http.StatusInternalServerError || !strings.Contains(rec.Body.String(), `"server_restart_unavailable"`) {
		t.Fatalf("expected 500 server_restart_unavailable from wired NativeRestarter, got %d body=%s", rec.Code, rec.Body.String())
	}

}
