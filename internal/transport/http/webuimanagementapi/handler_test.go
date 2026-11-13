package webuimanagementapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/accountstate"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/managementops"
)

type stubAuthorizer struct {
	allow bool
}

func (a stubAuthorizer) Authorized(*http.Request) bool { return a.allow }

type stubMetrics struct {
	metrics managementops.MetricsResponse
}

func (m stubMetrics) SnapshotMetrics() managementops.MetricsResponse { return m.metrics }
func (m stubMetrics) SnapshotSessionAffinity() map[string]int        { return map[string]int{"s1": 2} }

type stubModels struct {
	calls atomic.Int32
}

func (m *stubModels) RefreshModels(context.Context) (managementops.ModelRefreshOutcome, error) {
	m.calls.Add(1)
	return managementops.ModelRefreshOutcome{
		UpdatedAtMS:     1700000000000,
		Models:          []string{"gpt-5", "claude-sonnet-4-5"},
		ScannedAccounts: 1,
		Sources:         1,
		Source:          "upstream",
	}, nil
}

type stubRestarter struct {
	called atomic.Int32
}

func (r *stubRestarter) RestartServer(context.Context) (managementops.RestartResponse, error) {
	r.called.Add(1)
	return managementops.RestartResponse{
		OK:      true,
		Action:  "restart",
		Running: true,
		PID:     9988,
		Started: true,
	}, nil
}

func buildTestHandler(t *testing.T, withRestarter bool) (*Handler, *managementops.ManagementService, *managementops.UsageStore) {
	t.Helper()
	ctx := context.Background()
	tmpDir := t.TempDir()
	aiHome := filepath.Join(tmpDir, "ai_home")
	hostHome := filepath.Join(tmpDir, "host")
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
	t.Cleanup(func() { _ = acctStore.Close() })

	nowT := time.UnixMilli(1700000000000).UTC()
	ref1 := accountcore.AccountRef("acct_0123456789abcdef0123")
	acct, err := accountcore.RestoreAccount(cat, accountcore.RestoreAccountInput{
		Ref:          ref1,
		ProviderID:   "codex",
		CLIAccountID: accountcore.CLIAccountID(1),
		Enabled:      true,
		CreatedAt:    nowT,
		UpdatedAt:    nowT,
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	if err := acctStore.Create(ctx, acct); err != nil {
		t.Fatalf("acctStore.Create() error = %v", err)
	}

	dbPath, err := appstate.DatabasePath(aiHome)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	usageStore, err := managementops.NewUsageStore(ctx, dbPath, []string{"codex", "claude"}, func() time.Time {
		return time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC)
	})
	if err != nil {
		t.Fatalf("NewUsageStore() error = %v", err)
	}
	t.Cleanup(func() { _ = usageStore.Close() })
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

	var restarter managementops.ServerRestarterPort
	if withRestarter {
		restarter = &stubRestarter{}
	}

	svc := managementops.NewManagementService(managementops.ManagementOptions{
		AIHomeDir:        aiHome,
		HostHomeDir:      hostHome,
		Catalog:          cat,
		Store:            acctStore,
		UsageStore:       usageStore,
		Metrics:          stubMetrics{metrics: managementops.MetricsResponse{TotalRequests: 42, TotalSuccess: 40}},
		ModelCatalog:     &stubModels{},
		Restarter:        restarter,
		APIKeyConfigured: true,
		Host:             "127.0.0.1",
		Port:             9527,
		Now:              func() time.Time { return time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC) },
		StartedAt:        time.Date(2026, 2, 1, 11, 59, 0, 0, time.UTC),
	})
	h, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allow: true},
		Service:    svc,
		Now:        func() time.Time { return time.Date(2026, 2, 1, 12, 0, 0, 0, time.UTC) },
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return h, svc, usageStore
}

func doJSONReq(t *testing.T, handler http.Handler, method, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("json.Marshal() error = %v", err)
		}
		reader = bytes.NewReader(encoded)
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, target, reader)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func TestHandlerAuthAndLifecycleFailClosed(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); err == nil {
		t.Fatalf("NewHandler(empty) should return error")
	}
	_, svc, _ := buildTestHandler(t, false)
	h, err := NewHandler(Dependencies{Authorizer: stubAuthorizer{allow: false}, Service: svc})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	rec := doJSONReq(t, h, http.MethodGet, StatusPath, nil)
	if rec.Code != http.StatusUnauthorized || rec.Header().Get("WWW-Authenticate") != "Bearer" {
		t.Fatalf("unauthorized status=%d headers=%v", rec.Code, rec.Header())
	}

	var nilHandler *Handler
	recNil := doJSONReq(t, nilHandler, http.MethodGet, StatusPath, nil)
	if recNil.Code != http.StatusServiceUnavailable {
		t.Fatalf("nilHandler status=%d, want 503", recNil.Code)
	}
}

func TestHandlerCoreManagementAndStateIndex(t *testing.T) {
	h, _, _ := buildTestHandler(t, false)

	// UI HTML
	uiRec := doJSONReq(t, h, http.MethodGet, UIPath, nil)
	if uiRec.Code != http.StatusOK || !strings.Contains(uiRec.Header().Get("Content-Type"), "text/html") || !strings.Contains(uiRec.Body.String(), "AIH Proxy Live Status") {
		t.Fatalf("GET /ui unexpected code=%d ct=%q", uiRec.Code, uiRec.Header().Get("Content-Type"))
	}

	// Status / Metrics / Models / Accounts
	if rec := doJSONReq(t, h, http.MethodGet, StatusPath, nil); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"uptimeSec":60`) {
		t.Fatalf("GET /status code=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := doJSONReq(t, h, http.MethodGet, MetricsPath, nil); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"totalRequests":42`) {
		t.Fatalf("GET /metrics code=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := doJSONReq(t, h, http.MethodGet, ModelsPath+"?refresh=1", nil); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"gpt-5"`) {
		t.Fatalf("GET /models code=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := doJSONReq(t, h, http.MethodGet, AccountsPath, nil); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "acct_0123456789abcdef0123") {
		t.Fatalf("GET /accounts code=%d body=%s", rec.Code, rec.Body.String())
	}

	// Reload / Cooldown / Restart(unavailable)
	if rec := doJSONReq(t, h, http.MethodPost, ReloadPath, nil); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"reloaded":1`) {
		t.Fatalf("POST /reload code=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := doJSONReq(t, h, http.MethodPost, CooldownClearPath, nil); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("POST /cooldown/clear code=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := doJSONReq(t, h, http.MethodPost, RestartPath, nil); rec.Code != http.StatusServiceUnavailable || !strings.Contains(rec.Body.String(), `"management_restart_unavailable"`) {
		t.Fatalf("POST /restart(nil) code=%d body=%s", rec.Code, rec.Body.String())
	}

	// State index validation & CRUD
	if rec := doJSONReq(t, h, http.MethodPost, StateIndexUpsertPath, map[string]any{"provider": "codex", "accountRef": "bad"}); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"invalid_state_index_payload"`) {
		t.Fatalf("POST /state-index/upsert bad code=%d body=%s", rec.Code, rec.Body.String())
	}
	ref := "acct_0123456789abcdef0123"
	if rec := doJSONReq(t, h, http.MethodPost, StateIndexUpsertPath, map[string]any{"provider": "codex", "accountRef": ref, "state": map[string]any{"configured": true}}); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"updated":true`) {
		t.Fatalf("POST /state-index/upsert code=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := doJSONReq(t, h, http.MethodPost, StateIndexOperationalStatusPath, map[string]any{"provider": "codex", "accountRef": ref, "status": "down"}); rec.Code != http.StatusOK {
		t.Fatalf("POST /state-index/operational-status code=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := doJSONReq(t, h, http.MethodPost, StateIndexRuntimeStatePath, map[string]any{"provider": "codex", "accountRef": ref, "runtimeState": map[string]any{"status": "cooldown"}}); rec.Code != http.StatusOK {
		t.Fatalf("POST /state-index/runtime-state code=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := doJSONReq(t, h, http.MethodPost, StateIndexPruneMissingPath, map[string]any{"provider": "codex", "existingRefs": []string{ref}}); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"removed":0`) {
		t.Fatalf("POST /state-index/prune-missing code=%d body=%s", rec.Code, rec.Body.String())
	}

	// Watch snapshot + SSE stream via httptest.Server
	if rec := doJSONReq(t, h, http.MethodPost, WatchSnapshotPath, nil); rec.Code != http.StatusAccepted || !strings.Contains(rec.Body.String(), `"accepted":true`) {
		t.Fatalf("POST /watch/snapshot code=%d body=%s", rec.Code, rec.Body.String())
	}
	srv := httptest.NewServer(h)
	defer srv.Close()
	sseCtx, sseCancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer sseCancel()
	req, _ := http.NewRequestWithContext(sseCtx, http.MethodGet, srv.URL+WatchPath, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /watch error = %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	scanner := bufio.NewScanner(resp.Body)
	var firstData string
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data: ") {
			firstData = line
			break
		}
	}
	if !strings.Contains(firstData, `"type":"connected"`) {
		t.Fatalf("GET /watch first SSE line = %q", firstData)
	}
	sseCancel()

	// Method/route errors
	if rec := doJSONReq(t, h, http.MethodDelete, StatusPath, nil); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE /status code=%d, want 405", rec.Code)
	}
	if rec := doJSONReq(t, h, http.MethodGet, BasePath+"/unknown", nil); rec.Code != http.StatusNotFound {
		t.Fatalf("GET /unknown code=%d, want 404", rec.Code)
	}
}

func TestHandlerRestartSuccessAndUsageEndpointsAndSSE(t *testing.T) {
	h, svc, usageStore := buildTestHandler(t, true)
	ctx := context.Background()
	tsMS := time.Date(2026, 2, 1, 10, 0, 0, 0, time.UTC).UnixMilli()
	costUSD := 0.01
	if _, err := usageStore.InsertUsageBatch(ctx, []managementops.UsageRecordInput{
		{
			EventKey:     "req-1",
			Provider:     "codex",
			AccountRef:   "acct_0123456789abcdef0123",
			SessionID:    "sess-a",
			SourceKind:   "server_openai_proxy",
			Model:        "gpt-5",
			InputTokens:  100,
			OutputTokens: 25,
			TotalTokens:  125,
			CostUSD:      &costUSD,
			TimestampMS:  tsMS,
		},
	}); err != nil {
		t.Fatalf("InsertUsageBatch() error = %v", err)
	}

	// Restart success
	if rec := doJSONReq(t, h, http.MethodPost, RestartPath, nil); rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"pid":9988`) {
		t.Fatalf("POST /restart code=%d body=%s", rec.Code, rec.Body.String())
	}

	// Usage validation errors
	if rec := doJSONReq(t, h, http.MethodGet, UsageStatsPath+"?from=invalid-date", nil); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"invalid_usage_query"`) {
		t.Fatalf("bad query code=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := doJSONReq(t, h, http.MethodGet, UsageBreakdownPath+"?from=2026-02-01&to=2026-02-01", nil); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"usage_breakdown_scope_required"`) {
		t.Fatalf("breakdown no scope code=%d body=%s", rec.Code, rec.Body.String())
	}
	if rec := doJSONReq(t, h, http.MethodGet, UsageSessionDetailPath+"?from=2026-02-01&to=2026-02-01", nil); rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), `"session_id_required"`) {
		t.Fatalf("session-detail no id code=%d body=%s", rec.Code, rec.Body.String())
	}

	q := "?from=2026-02-01&to=2026-02-01"
	for _, path := range []string{
		UsagePath + q,
		UsageStatsPath + q,
		UsageDashboardPath + q,
		UsageModelsPath + q,
		UsageSessionsPath + q,
		UsageRequestsPath + q,
		UsageBreakdownPath + q + "&sessionId=sess-a",
		UsageSessionDetailPath + q + "&sessionId=sess-a",
	} {
		rec := doJSONReq(t, h, http.MethodGet, path, nil)
		if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
			t.Fatalf("GET %s code=%d body=%s", path, rec.Code, rec.Body.String())
		}
	}

	// Write a tiny log so hostHome exists cleanly for scan
	_ = os.MkdirAll(svc.HostHomeDir(), 0o755)
	if rec := doJSONReq(t, h, http.MethodPost, UsageScanPath+"?provider=codex", nil); rec.Code != http.StatusAccepted || !strings.Contains(rec.Body.String(), `"job"`) {
		t.Fatalf("POST /usage/scan code=%d body=%s", rec.Code, rec.Body.String())
	}

	// Start dashboard query, fetch, cancel, missing 404
	qRec := doJSONReq(t, h, http.MethodPost, UsageDashboardQueryPath+q, nil)
	if qRec.Code != http.StatusAccepted {
		t.Fatalf("POST /usage/dashboard/query code=%d body=%s", qRec.Code, qRec.Body.String())
	}
	var started struct {
		Job struct {
			ID string `json:"id"`
		} `json:"job"`
	}
	if err := json.Unmarshal(qRec.Body.Bytes(), &started); err != nil || started.Job.ID == "" {
		t.Fatalf("decode dashboard query job error=%v body=%s", err, qRec.Body.String())
	}
	if rec := doJSONReq(t, h, http.MethodGet, UsageDashboardQueryPath+"/"+started.Job.ID, nil); rec.Code != http.StatusOK {
		t.Fatalf("GET /usage/dashboard/query/%s code=%d", started.Job.ID, rec.Code)
	}
	if rec := doJSONReq(t, h, http.MethodDelete, UsageDashboardQueryPath+"/"+started.Job.ID, nil); rec.Code != http.StatusOK {
		t.Fatalf("DELETE /usage/dashboard/query/%s code=%d", started.Job.ID, rec.Code)
	}
	if rec := doJSONReq(t, h, http.MethodDelete, UsageDashboardQueryPath+"/missing-job", nil); rec.Code != http.StatusNotFound || !strings.Contains(rec.Body.String(), `"model_usage_query_job_not_found"`) {
		t.Fatalf("DELETE missing code=%d body=%s", rec.Code, rec.Body.String())
	}

	// Usage SSE streams
	srv := httptest.NewServer(h)
	defer srv.Close()
	for _, watchURL := range []string{UsageScanWatchPath, UsageDashboardQueryWatchPath} {
		wCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		req, _ := http.NewRequestWithContext(wCtx, http.MethodGet, srv.URL+watchURL, nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			cancel()
			t.Fatalf("GET %s error = %v", watchURL, err)
		}
		sc := bufio.NewScanner(resp.Body)
		var line string
		for sc.Scan() {
			if strings.HasPrefix(sc.Text(), "data: ") {
				line = sc.Text()
				break
			}
		}
		_ = resp.Body.Close()
		cancel()
		if !strings.Contains(line, `"type":"connected"`) {
			t.Fatalf("GET %s first SSE line = %q", watchURL, line)
		}
	}
}
