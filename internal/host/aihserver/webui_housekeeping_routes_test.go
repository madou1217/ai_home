package aihserver

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/runtime/housekeeping"
	"github.com/madou1217/ai_home/internal/runtime/persistent"
	"github.com/madou1217/ai_home/internal/runtime/remotebackup"
	"github.com/madou1217/ai_home/internal/transport/http/webuihousekeepingapi"
)

type stubHousekeepingAuthorizer struct {
	allow bool
}

func (s stubHousekeepingAuthorizer) Authorized(*http.Request) bool {
	return s.allow
}

type silentHousekeepingLogger struct {
	warnings []string
}

func (l *silentHousekeepingLogger) Info(string) {}
func (l *silentHousekeepingLogger) Warn(msg string) {
	l.warnings = append(l.warnings, msg)
}

type stubStartupInvalidator struct {
	removed []string
	err     error
}

func (s *stubStartupInvalidator) Invalidate(_ context.Context, target housekeeping.CodexAppServerTarget) error {
	if s.err != nil {
		return s.err
	}
	s.removed = append(s.removed, target.RuntimeScope)
	return os.Remove(target.StatePath)
}

func TestRunStartupHousekeepingPrunesStaleWithoutFailingBoot(t *testing.T) {
	ctx := context.Background()
	aiHome := t.TempDir()
	hostHome := t.TempDir()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatal(err)
	}
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: aiHome,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	now := time.Now().UTC()
	registrar, err := accountapp.NewRegistrar(catalog, store, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	cred, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: "sk-keep-1"})
	if err != nil {
		t.Fatal(err)
	}
	keptAcct, err := registrar.Register(ctx, cred, nil)
	if err != nil {
		t.Fatal(err)
	}

	staleRef := "acct_deadbeefdeadbeefdead"
	keptProj := filepath.Join(aiHome, "run", "auth-projections", "codex", keptAcct.Ref().String())
	staleProj := filepath.Join(aiHome, "run", "auth-projections", "codex", staleRef)
	if err := os.MkdirAll(keptProj, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(staleProj, ".codex", "sessions", "2026"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(staleProj, ".codex", "sessions", "2026", "rollout.jsonl"), []byte("line\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	appDir := filepath.Join(aiHome, "run", "codex-app-server")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(appDir, "gateway.json"), []byte(`{"port":4001}`), 0o600); err != nil {
		t.Fatal(err)
	}
	keptState, _ := json.Marshal(map[string]any{"accountRef": keptAcct.Ref().String(), "port": 4002})
	staleState, _ := json.Marshal(map[string]any{"accountRef": staleRef, "port": 4003})
	if err := os.WriteFile(filepath.Join(appDir, keptAcct.Ref().String()+".json"), keptState, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(appDir, staleRef+".json"), staleState, 0o600); err != nil {
		t.Fatal(err)
	}

	inv := &stubStartupInvalidator{}
	logger := &silentHousekeepingLogger{}
	summary, err := runStartupHousekeepingWithPorts(ctx, webuiRouteDependencies{
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		Catalog:     catalog,
		Store:       store,
	}, startupHousekeepingPorts{
		Invalidator: inv,
		Logger:      logger,
	})
	if err != nil {
		t.Fatalf("runStartupHousekeeping() err = %v", err)
	}
	if summary.Projections.Removed != 1 || summary.Projections.Kept != 1 {
		t.Fatalf("unexpected projection summary = %+v", summary.Projections)
	}
	if summary.AppServers.Removed != 1 || summary.AppServers.Kept != 2 || len(inv.removed) != 1 || inv.removed[0] != staleRef {
		t.Fatalf("unexpected app-server summary = %+v inv=%v", summary.AppServers, inv.removed)
	}
	if _, statErr := os.Stat(staleProj); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("expected stale projection deleted, statErr=%v", statErr)
	}
	migrated, err := os.ReadFile(filepath.Join(hostHome, ".codex", "sessions", "2026", "rollout.jsonl"))
	if err != nil || string(migrated) != "line\n" {
		t.Fatalf("expected reconciled session stored at hostHome, got %q err=%v", migrated, err)
	}

	// Non-fatal DB error must NOT fail Go Core startup.
	warnLogger := &silentHousekeepingLogger{}
	brokenSummary, err := runStartupHousekeepingWithPorts(ctx, webuiRouteDependencies{}, startupHousekeepingPorts{
		Logger: warnLogger,
	})
	if err != nil {
		t.Fatalf("expected non-fatal nil error on missing deps, got %v", err)
	}
	if brokenSummary.ProjectionsErr == nil || len(warnLogger.warnings) == 0 {
		t.Fatalf("expected warning recorded cleanly, summary=%+v warnings=%v", brokenSummary, warnLogger.warnings)
	}
}

type noopSessionStore struct {
	collectCalls atomic.Int32
}

func (s *noopSessionStore) CollectSessions(context.Context) ([]persistent.SessionRow, error) {
	s.collectCalls.Add(1)
	return nil, nil
}

func (s *noopSessionStore) CloseSession(context.Context, persistent.SessionRow) error {
	return nil
}

func TestStartHousekeepingDaemonsAndBuildRoutesLifecycle(t *testing.T) {
	// Authorizer == nil returns empty routes cleanly.
	unauthRoutes, err := buildWebUIHousekeepingRoutes(webuiRouteDependencies{})
	if err != nil || len(unauthRoutes) != 0 {
		t.Fatalf("expected nil,nil when Authorizer missing; got %v, %v", unauthRoutes, err)
	}

	aiHome := t.TempDir()
	if _, err := remotebackup.WriteBackupConfig(aiHome, remotebackup.BackupConfig{
		Version:         1,
		Enabled:         true,
		IntervalMinutes: 60,
		DebounceSeconds: 0,
		Targets: []remotebackup.BackupTarget{{
			ID: "t1", Strategy: "ssh", Enabled: true, Host: "10.0.0.1", Port: 22, Username: "ops", RemoteDir: ".aih-backup",
		}},
	}); err != nil {
		t.Fatal(err)
	}

	var backupRuns atomic.Int32
	backupDone := make(chan struct{})
	zeroDelay := time.Duration(0)
	sessionStore := &noopSessionStore{}

	daemons, err := startHousekeepingDaemonsWithPorts(context.Background(), webuiRouteDependencies{
		AIHomeDir: aiHome,
	}, housekeepingDaemonsPorts{
		TickInterval: time.Hour,
		StartupDelay: &zeroDelay,
		JanitorEvery: time.Hour,
		RunBackup: func(context.Context, remotebackup.RunOptions) (remotebackup.BackupRunResult, error) {
			if backupRuns.Add(1) == 1 {
				close(backupDone)
			}
			return remotebackup.BackupRunResult{OK: true}, nil
		},
		Collector: sessionStore,
		Closer:    sessionStore,
		PruneSockets: func(context.Context) (persistent.SocketPruneSummary, error) {
			return persistent.SocketPruneSummary{}, nil
		},
		Logger: &silentHousekeepingLogger{},
	})
	if err != nil {
		t.Fatalf("startHousekeepingDaemonsWithPorts() err = %v", err)
	}
	defer func() { _ = daemons.Close() }()

	if !daemons.TriggerBackup("lifecycle") {
		t.Fatal("expected TriggerBackup(lifecycle)=true")
	}
	select {
	case <-backupDone:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for TriggerBackup debounced run")
	}

	routes, err := buildWebUIHousekeepingRoutes(webuiRouteDependencies{
		Authorizer: stubHousekeepingAuthorizer{allow: true},
		AIHomeDir:  aiHome,
	}, daemons)
	if err != nil {
		t.Fatalf("buildWebUIHousekeepingRoutes() err = %v", err)
	}
	if len(routes) != 3 {
		t.Fatalf("len(routes) = %d, want 3", len(routes))
	}

	mux := http.NewServeMux()
	for _, r := range routes {
		mux.Handle(r.Pattern, r.Handler)
	}

	// 1. GET backup status
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, webuihousekeepingapi.BackupStatusPath, nil))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"schedulerActive":true`) {
		t.Fatalf("backup/status = %d body=%s", w.Code, w.Body.String())
	}

	// 2. POST backup trigger (runNow)
	w = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, webuihousekeepingapi.BackupTriggerPath, strings.NewReader(`{"reason":"http","runNow":true}`))
	req.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(w, req)
	if w.Code != http.StatusOK || backupRuns.Load() < 2 {
		t.Fatalf("backup/trigger runNow = %d runs=%d body=%s", w.Code, backupRuns.Load(), w.Body.String())
	}

	// 3. POST janitor run
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodPost, webuihousekeepingapi.JanitorRunPath, nil))
	if w.Code != http.StatusOK || sessionStore.collectCalls.Load() < 1 {
		t.Fatalf("janitor/run = %d collectCalls=%d body=%s", w.Code, sessionStore.collectCalls.Load(), w.Body.String())
	}

	if err := daemons.Close(); err != nil {
		t.Fatalf("Close() err = %v", err)
	}
}

func TestStartHousekeepingDaemonsWithRealStoreAndScopeProvider(t *testing.T) {
	ctx := context.Background()
	aiHome := t.TempDir()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatal(err)
	}
	store, err := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{
		AIHomeDir: aiHome,
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	now := time.Now().UTC()
	registrar, err := accountapp.NewRegistrar(catalog, store, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	cred, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: "sk-scope-1"})
	if err != nil {
		t.Fatal(err)
	}
	acct, err := registrar.Register(ctx, cred, nil)
	if err != nil {
		t.Fatal(err)
	}

	refs, err := (sqliteScopeProvider{store: store}).ListProviderAccountRefs(ctx, "codex")
	if err != nil || len(refs) != 1 || refs[0] != acct.Ref().String() {
		t.Fatalf("ListProviderAccountRefs() = %v, err=%v", refs, err)
	}

	daemons, err := startHousekeepingDaemons(webuiRouteDependencies{
		AIHomeDir: aiHome,
		Catalog:   catalog,
		Store:     store,
	})
	if err != nil {
		t.Fatalf("startHousekeepingDaemons() err = %v", err)
	}
	defer func() { _ = daemons.Close() }()

	if daemons.Scheduler() == nil || daemons.Janitor() == nil {
		t.Fatalf("expected non-nil Scheduler and Janitor")
	}
	routes, err := buildWebUIHousekeepingRoutes(webuiRouteDependencies{
		Authorizer: stubHousekeepingAuthorizer{allow: true},
		AIHomeDir:  aiHome,
		Catalog:    catalog,
		Store:      store,
	}, daemons)
	if err != nil || len(routes) != 3 {
		t.Fatalf("buildWebUIHousekeepingRoutes() = %d, err=%v", len(routes), err)
	}
}
