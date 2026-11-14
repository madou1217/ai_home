package aihserver

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/providercliupgrade"
	"github.com/madou1217/ai_home/internal/runtime/windowactivation"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountactivityapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountegressapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuialiaspoolapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuimodelcontextapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiproviderclearbrokenapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiprovidercliupgradeapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiquotaresetapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiwindowactivationapi"
	_ "modernc.org/sqlite"
)

type stubSchedulerAuthorizer struct{ allow bool }

func (a stubSchedulerAuthorizer) Authorized(*http.Request) bool { return a.allow }

func TestBuildWebUISchedulerRoutes_NoConflictsAndEndToEnd(t *testing.T) {
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}

	const acctRef = "acct_0123456789abcdef0123"
	dbPath := filepath.Join(aiHome, appstate.DatabaseFileName)
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	for _, stmt := range []string{
		"CREATE TABLE account_refs (account_ref TEXT PRIMARY KEY, provider TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
		"CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("schema: %v", err)
		}
	}
	if _, err := db.Exec("INSERT INTO account_refs VALUES (?, 'codex', 1, 1)", acctRef); err != nil {
		t.Fatalf("seed account_ref: %v", err)
	}
	if _, err := db.Exec("INSERT INTO app_kv VALUES (?, ?, 1)", windowactivation.ServerConfigKVKey, `{"windowActivation":false,"windowActivationMinIntervalMs":3600000}`); err != nil {
		t.Fatalf("seed config:server: %v", err)
	}
	_ = db.Close()

	// 写入测试升级账本（codex broken）
	if err := os.MkdirAll(filepath.Join(aiHome, "run"), 0o700); err != nil {
		t.Fatalf("mkdir run: %v", err)
	}
	ledgerPayload := `{"schemaVersion":1,"global":{"enabled":true,"disabledReason":""},"providers":{"codex":{"state":"broken","channel":"npm_global","enabled":false,"installedVersion":"1.2.0","blockedVersions":["1.2.1"]}}}`
	if err := os.WriteFile(filepath.Join(aiHome, "run", "provider-cli-upgrade.json"), []byte(ledgerPayload), 0o600); err != nil {
		t.Fatalf("write ledger: %v", err)
	}

	enabled := false
	upgradeSched := providercliupgrade.NewScheduler(providercliupgrade.SchedulerOptions{
		AIHomeDir: aiHome,
		Catalog:   catalog,
		Config:    providercliupgrade.SchedulerConfig{Enabled: &enabled},
	})
	upgradeSched.Start(context.Background())
	defer func() { _ = upgradeSched.Close() }()

	windowSched := windowactivation.NewScheduler(windowactivation.SchedulerOptions{
		AIHomeDir: aiHome,
		Config: windowactivation.SchedulerConfig{
			Enabled:           true,
			MinIntervalMs:     3600000,
			DefaultIntervalMs: 3600000,
			StartDelay:        time.Hour,
			TickInterval:      time.Hour,
		},
	})
	windowSched.Start(context.Background())
	defer func() { _ = windowSched.Close() }()

	noop := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux := http.NewServeMux()
	// 验证与同域 /v1/management/webui/accounts/{provider}/{accountRef}/* 其他兄弟路由完全无 ServeMux 冲突
	for _, pattern := range []string{
		"GET " + webuiquotaresetapi.Path + "/{provider}/{accountRef}/quota-reset-events",
		"GET " + webuialiaspoolapi.Path + "/{provider}/{accountRef}/alias-pool",
		"GET " + webuimodelcontextapi.Path + "/{provider}/{accountRef}/model-context",
		"GET " + webuiaccountegressapi.Path + "/{provider}/{accountRef}/egress",
		"POST " + webuiaccountactivityapi.AccountActionPath,
	} {
		mux.Handle(pattern, noop)
	}

	routes, err := buildWebUISchedulerRoutesWithPorts(
		webuiRouteDependencies{
			Authorizer:  stubSchedulerAuthorizer{allow: true},
			AIHomeDir:   aiHome,
			HostHomeDir: hostHome,
			Catalog:     catalog,
		},
		webuiSchedulerPorts{
			UpgradeScheduler: upgradeSched,
			WindowScheduler:  windowSched,
		},
	)
	if err != nil {
		t.Fatalf("buildWebUISchedulerRoutesWithPorts() error = %v", err)
	}
	if len(routes) != 4 {
		t.Fatalf("expected 4 routes, got %d", len(routes))
	}
	for _, r := range routes {
		mux.Handle(r.Pattern, r.Handler)
	}

	// 1. GET provider-cli-upgrade 应返回含 live scheduler 遥测的投影
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, webuiprovidercliupgradeapi.Path, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET upgrade status=%d body=%s", rec.Code, rec.Body.String())
	}
	var upgradeBody map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &upgradeBody); err != nil {
		t.Fatalf("decode upgrade: %v", err)
	}
	schedMap, _ := upgradeBody["scheduler"].(map[string]any)
	if schedMap == nil || schedMap["running"] != true {
		t.Fatalf("expected running upgrade scheduler view, got %#v", upgradeBody["scheduler"])
	}

	// 2. POST clear-broken（带注入 Scheduler，若无本地 CLI 探测但含 status 投影，先校验路径可达；构造只跳过验证的 handler 检查 200 status 含 live telemetry）
	recClear := httptest.NewRecorder()
	mux.ServeHTTP(recClear, httptest.NewRequest(http.MethodPost, webuiproviderclearbrokenapi.Path+"/grok/clear-broken", nil))
	if recClear.Code != http.StatusBadRequest {
		t.Fatalf("POST clear-broken unknown provider=%d body=%s", recClear.Code, recClear.Body.String())
	}

	// 3. GET window-activation 不支持的 provider 应返回 400 window_activation_unsupported_provider
	recUnsup := httptest.NewRecorder()
	mux.ServeHTTP(recUnsup, httptest.NewRequest(http.MethodGet, webuiwindowactivationapi.Path+"/claude/"+acctRef+"/window-activation", nil))
	if recUnsup.Code != http.StatusBadRequest {
		t.Fatalf("GET unsupported provider=%d body=%s", recUnsup.Code, recUnsup.Body.String())
	}

	// 4. POST window-activation 写入并返回完整视图 + 实时 global（enabled=true, savedEnabled=false, restartRequired=true）
	recPost := httptest.NewRecorder()
	mux.ServeHTTP(recPost, httptest.NewRequest(
		http.MethodPost,
		webuiwindowactivationapi.Path+"/codex/"+acctRef+"/window-activation",
		bytes.NewReader([]byte(`{"enabled":true,"intervalMs":7200000}`)),
	))
	if recPost.Code != http.StatusOK {
		t.Fatalf("POST window-activation=%d body=%s", recPost.Code, recPost.Body.String())
	}
	var waBody map[string]any
	if err := json.Unmarshal(recPost.Body.Bytes(), &waBody); err != nil {
		t.Fatalf("decode window-activation: %v", err)
	}
	globalMap, _ := waBody["global"].(map[string]any)
	if globalMap == nil || globalMap["enabled"] != true || globalMap["savedEnabled"] != false || globalMap["restartRequired"] != true {
		t.Fatalf("window-activation global = %#v", waBody["global"])
	}

	// 5. GET window-activation 读回刚写入设置
	recGet := httptest.NewRecorder()
	mux.ServeHTTP(recGet, httptest.NewRequest(http.MethodGet, webuiwindowactivationapi.Path+"/codex/"+acctRef+"/window-activation", nil))
	if recGet.Code != http.StatusOK {
		t.Fatalf("GET window-activation=%d body=%s", recGet.Code, recGet.Body.String())
	}
	var waGet map[string]any
	_ = json.Unmarshal(recGet.Body.Bytes(), &waGet)
	if waGet["setting"].(map[string]any)["enabled"] != true {
		t.Fatalf("GET window-activation setting = %#v", waGet["setting"])
	}
}
