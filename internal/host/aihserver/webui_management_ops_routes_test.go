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
)

type stubMgmtAuthorizer struct{ allow bool }

func (a stubMgmtAuthorizer) Authorized(*http.Request) bool { return a.allow }

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

	// Mock Node internal restart bridge to verify HostRestarter wiring.
	nodeSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v0/internal/server/restart" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"pid":7788,"appliedConfig":{"port":9527}}`))
	}))
	defer nodeSrv.Close()

	routes, err := buildWebUIManagementOpsRoutesWithPorts(webuiRouteDependencies{
		Authorizer:    stubMgmtAuthorizer{allow: true},
		AIHomeDir:     aiHome,
		HostHomeDir:   hostHome,
		Catalog:       cat,
		Store:         acctStore,
		NodeBaseURL:   nodeSrv.URL,
		ManagementKey: func() string { return "secret" },
	}, webuiManagementOpsPorts{
		UsageStore: usageStore,
	})
	if err != nil {
		t.Fatalf("buildWebUIManagementOpsRoutesWithPorts() error = %v", err)
	}
	if len(routes) != 29 {
		t.Fatalf("len(routes) = %d, want 29", len(routes))
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

	// Verify /restart delegates through HostRestarter
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
