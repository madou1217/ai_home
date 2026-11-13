package aihserver

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/runtime/peer"
	"github.com/madou1217/ai_home/internal/runtime/usagedaemons"
	"github.com/madou1217/ai_home/internal/transport/http/webuidaemonsapi"
	_ "modernc.org/sqlite"
)

type testDaemonsAuthorizer struct{}

func (testDaemonsAuthorizer) Authorized(r *http.Request) bool {
	return r != nil && r.Header.Get("Authorization") == "Bearer daemon-secret"
}

type fakeHostQuotaProbePort struct {
	mu     sync.Mutex
	probed []usagedaemons.QuotaAccount
}

func (p *fakeHostQuotaProbePort) SupportsProvider(provider string) bool {
	return provider == "agy" || provider == "codex"
}

func (p *fakeHostQuotaProbePort) ProbeAccountQuota(_ context.Context, acc usagedaemons.QuotaAccount) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.probed = append(p.probed, acc)
	return nil
}

func TestBuildWebUIDaemonsRoutesContractAndAuth(t *testing.T) {
	t.Parallel()

	aiHome := t.TempDir()
	routesNil, err := buildWebUIDaemonsRoutesWithPorts(webuiRouteDependencies{AIHomeDir: aiHome}, webuiDaemonsPorts{
		DisablePricingSync: true,
	})
	if err != nil || routesNil != nil {
		t.Fatalf("expected (nil, nil) without Authorizer, got (%v, %v)", routesNil, err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	zeroDelay := time.Duration(0)
	rt, err := startBackgroundDaemonsWithPorts(ctx, webuiRouteDependencies{
		AIHomeDir: aiHome,
	}, webuiDaemonsPorts{
		DisablePricingSync:  true,
		UsageScanStartDelay: &zeroDelay,
	})
	if err != nil {
		t.Fatalf("startBackgroundDaemonsWithPorts() error = %v", err)
	}
	t.Cleanup(func() { _ = rt.Close() })

	routes, err := buildWebUIDaemonsRoutesWithPorts(webuiRouteDependencies{
		Authorizer: testDaemonsAuthorizer{},
		AIHomeDir:  aiHome,
	}, webuiDaemonsPorts{
		Runtime: rt,
	})
	if err != nil {
		t.Fatalf("buildWebUIDaemonsRoutesWithPorts() error = %v", err)
	}
	if len(routes) != 2 {
		t.Fatalf("expected 2 routes, got %d", len(routes))
	}
	wantPatterns := map[string]bool{
		"GET " + webuidaemonsapi.StatusPath:   true,
		"POST " + webuidaemonsapi.TriggerPath: true,
	}
	mux := http.NewServeMux()
	for _, route := range routes {
		if !wantPatterns[route.Pattern] {
			t.Fatalf("unexpected route pattern %q", route.Pattern)
		}
		delete(wantPatterns, route.Pattern)
		mux.Handle(route.Pattern, route.Handler)
	}
	if len(wantPatterns) != 0 {
		t.Fatalf("missing patterns: %v", wantPatterns)
	}

	rec401 := httptest.NewRecorder()
	mux.ServeHTTP(rec401, httptest.NewRequest(http.MethodGet, webuidaemonsapi.StatusPath, nil))
	if rec401.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d, want 401", rec401.Code)
	}

	recOK := httptest.NewRecorder()
	reqOK := httptest.NewRequest(http.MethodGet, webuidaemonsapi.StatusPath, nil)
	reqOK.Header.Set("Authorization", "Bearer daemon-secret")
	mux.ServeHTTP(recOK, reqOK)
	if recOK.Code != http.StatusOK {
		t.Fatalf("GET status code = %d, body=%s", recOK.Code, recOK.Body.String())
	}
	var payload struct {
		OK     bool                         `json:"ok"`
		Status webuidaemonsapi.StatusReport `json:"status"`
	}
	if err := json.Unmarshal(recOK.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.OK || payload.Status.Peer == nil || payload.Status.Retention == nil || payload.Status.QuotaProbe == nil || payload.Status.UsageScan == nil || payload.Status.ProviderRefresh == nil {
		t.Fatalf("incomplete status report: %+v", payload.Status)
	}
}

func TestBackgroundDaemonsIntegrationPeerRetentionQuotaAndZcode(t *testing.T) {
	t.Parallel()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	aiHome := t.TempDir()
	nowMs := int64(1_700_000_010_000)
	nowFn := func() time.Time { return time.UnixMilli(nowMs) }

	// 1) 初始化 SQLite 账号库并注册一个启用状态的 OAuth (agy) 账号。
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: aiHome,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "daemon-test@example.com",
		AccessToken:   "agy-access-token",
		RefreshToken:  "agy-refresh-token",
		ExpiresAtMS:   nowMs + 3600_000,
		RefreshedAtMS: nowMs,
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
		IDToken:       "header.payload.signature",
	})
	if err != nil {
		t.Fatalf("agy.NewOAuthAuth() error = %v", err)
	}
	registrar, err := accountapp.NewRegistrar(catalog, store, nowFn)
	if err != nil {
		t.Fatalf("NewRegistrar() error = %v", err)
	}
	activeAccount, err := registrar.Register(ctx, auth, nil)
	if err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	activeRef := activeAccount.Ref().String()

	// 2) 初始化 app-state.db model_usage_records 并插入一条未归属 ZCode 记录与对应写者审计日志。
	dbPath := filepath.Join(aiHome, "app-state.db")
	rawDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	t.Cleanup(func() { _ = rawDB.Close() })
	_, err = rawDB.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS model_usage_records (
			event_key TEXT PRIMARY KEY,
			provider TEXT NOT NULL,
			account_ref TEXT NOT NULL,
			session_id TEXT NOT NULL,
			request_id TEXT NOT NULL,
			source_kind TEXT NOT NULL,
			model TEXT NOT NULL,
			input_tokens INTEGER NOT NULL,
			output_tokens INTEGER NOT NULL,
			cache_read_input_tokens INTEGER NOT NULL,
			cache_creation_input_tokens INTEGER NOT NULL,
			reasoning_output_tokens INTEGER NOT NULL,
			total_tokens INTEGER NOT NULL,
			cost_usd REAL NOT NULL,
			timestamp_ms INTEGER NOT NULL,
			project TEXT NOT NULL,
			cwd TEXT NOT NULL,
			git_branch TEXT NOT NULL,
			created_at_ms INTEGER NOT NULL
		);
		INSERT INTO model_usage_records (
			event_key, provider, account_ref, session_id, request_id, source_kind, model,
			input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
			reasoning_output_tokens, total_tokens, cost_usd, timestamp_ms,
			project, cwd, git_branch, created_at_ms
		) VALUES (
			'zcode:model_usage:usage_z1', 'zcode', '', 'sess_z1', 'req_1', 'session_db', 'gpt-5',
			100, 50, 0, 0, 0, 150, 0.01, 1700000005000,
			'', '', '', 1700000005000
		);
	`)
	if err != nil {
		t.Fatalf("seed zcode model_usage_records error = %v", err)
	}

	zcodeOwnerFile := filepath.Join(aiHome, "run", "auth-projections", "zcode", activeRef, ".aih-runtime", "zcode-model-usage-owners.jsonl")
	if err := os.MkdirAll(filepath.Dir(zcodeOwnerFile), 0o700); err != nil {
		t.Fatal(err)
	}
	ownerLine := fmt.Sprintf(`{"version":1,"accountRef":%q,"usageId":"usage_z1","sessionId":"sess_z1","startedAtMs":1700000000000,"timestampMs":1700000005000}`+"\n", activeRef)
	if err := os.WriteFile(zcodeOwnerFile, []byte(ownerLine), 0o600); err != nil {
		t.Fatal(err)
	}

	// 3) 种入一个已删除账号的孤儿 chat-harness 目录与活跃账号的 harness 目录。
	orphanHarness := filepath.Join(aiHome, "run", "chat-harness", "acct_00000000000000000000")
	activeHarness := filepath.Join(aiHome, "run", "chat-harness", activeRef)
	if err := os.MkdirAll(orphanHarness, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(orphanHarness, "config.toml"), []byte("stale"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(activeHarness, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(activeHarness, "config.toml"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}

	// 4) 在 peer/pending 写入一条 inject 消息。
	peerStore := peer.NewDispatchStore(aiHome, peer.StoreOptions{Now: nowFn})
	peerRec, err := peerStore.CreateMessage(peer.CreateMessageInput{
		To: peer.RecordParty{
			Channel:  "inject",
			Provider: "codex",
			Name:     "s1",
			Address:  "s1",
			Delivery: &peer.DeliveryTarget{
				CLIName:      "codex",
				RuntimeScope: "gateway",
				SessionName:  "s1",
			},
		},
		Body: "hello from daemon integration",
	})
	if err != nil {
		t.Fatalf("peer CreateMessage() error = %v", err)
	}

	var sentTmux []string
	var tmuxMu sync.Mutex
	fakeQuota := &fakeHostQuotaProbePort{}
	zeroDelay := time.Duration(0)

	rt, err := startBackgroundDaemonsWithPorts(ctx, webuiRouteDependencies{
		Authorizer: testDaemonsAuthorizer{},
		AIHomeDir:  aiHome,
		Catalog:    catalog,
		Store:      store,
	}, webuiDaemonsPorts{
		Now:                 nowFn,
		DisablePricingSync:  true,
		QuotaProbePort:      fakeQuota,
		UsageScanStartDelay: &zeroDelay,
		PeerDelivery: &peer.DeliveryOptions{
			TmuxPath: "tmux",
			TmuxRunner: func(_ context.Context, _ string, args []string) (string, int, error) {
				tmuxMu.Lock()
				sentTmux = append(sentTmux, strings.Join(args, " "))
				tmuxMu.Unlock()
				for _, a := range args {
					if a == "display-message" {
						return "0\n", 0, nil
					}
				}
				return "", 0, nil
			},
		},
	})
	if err != nil {
		t.Fatalf("startBackgroundDaemonsWithPorts() error = %v", err)
	}
	defer rt.Close()

	// 验证启动期保留清扫：已删孤儿被立即清理，活跃账号保留。
	if _, err := os.Stat(orphanHarness); !os.IsNotExist(err) {
		t.Fatalf("expected orphanHarness deleted on startup retention sweep, err=%v", err)
	}
	if _, err := os.Stat(activeHarness); err != nil {
		t.Fatalf("expected activeHarness preserved, err=%v", err)
	}

	// 验证通过 HTTP Trigger 驱动 peer / quota-probe / provider-refresh(zcode)。
	routes, err := buildWebUIDaemonsRoutesWithPorts(webuiRouteDependencies{
		Authorizer: testDaemonsAuthorizer{},
		AIHomeDir:  aiHome,
	}, webuiDaemonsPorts{Runtime: rt})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	for _, route := range routes {
		mux.Handle(route.Pattern, route.Handler)
	}

	doTrigger := func(body string) {
		req := httptest.NewRequest(http.MethodPost, webuidaemonsapi.TriggerPath, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer daemon-secret")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("POST trigger(%s) status=%d body=%s", body, rec.Code, rec.Body.String())
		}
	}

	doTrigger(`{"daemon":"peer"}`)
	if _, err := os.Stat(filepath.Join(aiHome, "run", "peer", "archive", peerRec.ID+".json")); err != nil {
		t.Fatalf("expected peer message archived after trigger, err=%v", err)
	}

	doTrigger(`{"daemon":"quota-probe"}`)
	fakeQuota.mu.Lock()
	if len(fakeQuota.probed) != 1 || fakeQuota.probed[0].AccountRef != activeRef {
		fakeQuota.mu.Unlock()
		t.Fatalf("expected OAuth account %s probed, got %+v", activeRef, fakeQuota.probed)
	}
	fakeQuota.mu.Unlock()

	doTrigger(`{"daemon":"provider-refresh","provider":"zcode"}`)
	var reconciledRef string
	if err := rawDB.QueryRowContext(ctx, `SELECT account_ref FROM model_usage_records WHERE event_key = 'zcode:model_usage:usage_z1'`).Scan(&reconciledRef); err != nil {
		t.Fatalf("query reconciled row error = %v", err)
	}
	if reconciledRef != activeRef {
		t.Fatalf("reconciled account_ref = %q, want %q", reconciledRef, activeRef)
	}
}
