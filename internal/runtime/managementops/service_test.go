package managementops

import (
	"context"
	"encoding/json"
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
)

type fakeAccountRowPort struct {
	rows []ManagementAccount
}

func (f fakeAccountRowPort) ListManagementAccountRows(context.Context) ([]ManagementAccount, error) {
	return append([]ManagementAccount(nil), f.rows...), nil
}

type fakeMetricsPort struct {
	metrics  MetricsResponse
	affinity map[string]int
}

func (f fakeMetricsPort) SnapshotMetrics() MetricsResponse { return f.metrics }
func (f fakeMetricsPort) SnapshotSessionAffinity() map[string]int {
	out := make(map[string]int, len(f.affinity))
	for k, v := range f.affinity {
		out[k] = v
	}
	return out
}

type fakeModelCatalogPort struct {
	calls  atomic.Int32
	models []string
	err    error
}

func (f *fakeModelCatalogPort) RefreshModels(context.Context) (ModelRefreshOutcome, error) {
	f.calls.Add(1)
	if f.err != nil {
		return ModelRefreshOutcome{FirstError: f.err.Error()}, f.err
	}
	return ModelRefreshOutcome{
		UpdatedAtMS:     1700000000000,
		Models:          append([]string(nil), f.models...),
		ScannedAccounts: 1,
		Sources:         1,
		Source:          "upstream",
	}, nil
}

type fakeRestarterPort struct {
	called atomic.Int32
}

func (f *fakeRestarterPort) RestartServer(context.Context) (RestartResponse, error) {
	f.called.Add(1)
	return RestartResponse{
		OK:      true,
		Stopped: RestartStoppedStatus{Stopped: true, Reason: "restarted"},
	}, nil
}

func openTestEnv(t *testing.T) (context.Context, string, *sqliteaccount.Store, *UsageStore) {
	t.Helper()
	ctx := context.Background()
	tmpDir := t.TempDir()
	aiHome := filepath.Join(tmpDir, "ai_home")
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

	dbPath, err := appstate.DatabasePath(aiHome)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	usageStore, err := NewUsageStore(ctx, dbPath, []string{"codex", "claude", "kimi"}, func() time.Time {
		return time.UnixMilli(1700000005000)
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
	return ctx, tmpDir, acctStore, usageStore
}

func TestManagementServiceStatusMetricsModelsReloadRestart(t *testing.T) {
	ctx, tmpDir, acctStore, usageStore := openTestEnv(t)
	aiHome := filepath.Join(tmpDir, "ai_home")
	hostHome := filepath.Join(tmpDir, "host")
	cat, _ := providers.NewCatalog(providers.BuiltinManifest())

	ref1 := accountcore.AccountRef("acct_0123456789abcdef0123")
	nowT := time.UnixMilli(1700000000000).UTC()
	acct, err := accountcore.RestoreAccount(cat, accountcore.RestoreAccountInput{
		Ref:          ref1,
		ProviderID:   "codex",
		CLIAccountID: accountcore.CLIAccountID(1),
		Enabled:      true,
		CreatedAt:    nowT,
		UpdatedAt:    nowT,
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	if err := acctStore.Create(ctx, acct); err != nil {
		t.Fatalf("acctStore.Create() error = %v", err)
	}

	modelPort := &fakeModelCatalogPort{models: []string{"gpt-5", "gpt-5-mini"}}
	restarter := &fakeRestarterPort{}
	svc := NewManagementService(ManagementOptions{
		AIHomeDir:        aiHome,
		HostHomeDir:      hostHome,
		Catalog:          cat,
		Store:            acctStore,
		UsageStore:       usageStore,
		Metrics:          fakeMetricsPort{metrics: MetricsResponse{TotalRequests: 9}, affinity: map[string]int{"s1": 1}},
		ModelCatalog:     modelPort,
		Restarter:        restarter,
		APIKeyConfigured: true,
		Host:             "127.0.0.1",
		Port:             9527,
		Now:              func() time.Time { return time.UnixMilli(1700000001000) },
		StartedAt:        time.UnixMilli(1700000000000),
	})

	status := svc.Status(ctx)
	if !status.OK || status.UptimeSec != 1 || !status.APIKeyConfigured {
		t.Fatalf("unexpected Status(): %+v", status)
	}
	metrics := svc.Metrics(ctx)
	if metrics.TotalRequests != 9 {
		t.Fatalf("Metrics().TotalRequests = %d, want 9", metrics.TotalRequests)
	}
	accts, err := svc.Accounts(ctx)
	if err != nil || len(accts.Accounts) != 1 || accts.Accounts[0].AccountRef != ref1.String() {
		t.Fatalf("Accounts() = %+v, err = %v", accts, err)
	}

	// 模型刷新与缓存命中验证
	m1, err := svc.Models(ctx, true, 3, time.Minute)
	if err != nil || len(m1.Models) != 2 || modelPort.calls.Load() != 1 {
		t.Fatalf("first Models(refresh=true) = %+v, err=%v calls=%d", m1, err, modelPort.calls.Load())
	}
	m2, err := svc.Models(ctx, false, 3, time.Minute)
	if err != nil || !m2.Cached || modelPort.calls.Load() != 1 {
		t.Fatalf("cached Models(refresh=false) = %+v, err=%v calls=%d", m2, err, modelPort.calls.Load())
	}

	reloadRes, err := svc.Reload(ctx)
	if err != nil || !reloadRes.OK || reloadRes.Reloaded != 1 {
		t.Fatalf("Reload() = %+v, err=%v", reloadRes, err)
	}

	restartRes, err := svc.Restart(ctx)
	if err != nil || !restartRes.OK || restarter.called.Load() != 1 {
		t.Fatalf("Restart() = %+v, err=%v calls=%d", restartRes, err, restarter.called.Load())
	}
}

func TestManagementServiceStateIndexAndWatchHub(t *testing.T) {
	ctx, tmpDir, acctStore, usageStore := openTestEnv(t)
	aiHome := filepath.Join(tmpDir, "ai_home")
	cat, _ := providers.NewCatalog(providers.BuiltinManifest())
	svc := NewManagementService(ManagementOptions{
		AIHomeDir:   aiHome,
		HostHomeDir: tmpDir,
		Catalog:     cat,
		Store:       acctStore,
		UsageStore:  usageStore,
		AccountRows: fakeAccountRowPort{rows: []ManagementAccount{
			{AccountRef: "acct_11111111111111111111", Provider: "codex", Status: accountstate.StatusUp, RuntimeStatus: "healthy", Configured: true},
		}},
		Now: func() time.Time { return time.UnixMilli(1700000010000) },
	})

	refA := "acct_11111111111111111111"
	refB := "acct_22222222222222222222"
	nameA := "Alpha"
	changed, err := svc.StateIndexUpsert(ctx, StateIndexUpsertInput{
		Provider:   "codex",
		AccountRef: refA,
		State:      StateIndexBaseState{Configured: true, DisplayName: &nameA},
	})
	if err != nil || !changed {
		t.Fatalf("StateIndexUpsert() = %v, %v", changed, err)
	}
	if _, err := svc.StateIndexUpsert(ctx, StateIndexUpsertInput{
		Provider:   "codex",
		AccountRef: refB,
		State:      StateIndexBaseState{Configured: true},
	}); err != nil {
		t.Fatalf("StateIndexUpsert(refB) error = %v", err)
	}

	changed, err = svc.StateIndexOperationalStatus(ctx, StateIndexOperationalStatusInput{
		Provider:   "codex",
		AccountRef: refA,
		Status:     "DOWN",
		BaseState:  StateIndexBaseState{Configured: true},
	})
	if err != nil || !changed {
		t.Fatalf("StateIndexOperationalStatus() = %v, %v", changed, err)
	}

	changed, err = svc.StateIndexRuntimeState(ctx, StateIndexRuntimeStateInput{
		Provider:     "codex",
		AccountRef:   refA,
		RuntimeState: map[string]any{"status": "cooldown", "cooldownUntil": 1700000099000},
		BaseState:    StateIndexBaseState{Configured: true},
	})
	if err != nil || !changed {
		t.Fatalf("StateIndexRuntimeState() = %v, %v", changed, err)
	}

	removed, err := svc.StateIndexPruneMissing(ctx, StateIndexPruneMissingInput{
		Provider:     "codex",
		ExistingRefs: []string{refA},
	})
	if err != nil || removed != 1 {
		t.Fatalf("StateIndexPruneMissing() = %d, %v", removed, err)
	}

	// WatchHub SSE 验证：首包 connected + snapshot，随后 EmitEvent
	watch := svc.Watch()
	ch, cancel := watch.Subscribe(ctx)
	defer cancel()

	var frames []string
	for i := 0; i < 2; i++ {
		select {
		case raw := <-ch:
			frames = append(frames, string(raw))
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for initial SSE frame %d", i)
		}
	}
	if !strings.Contains(frames[0], `"connected"`) || !strings.Contains(frames[1], `"snapshot"`) {
		t.Fatalf("unexpected initial watch frames: %v", frames)
	}
	if !watch.EmitEvent(map[string]any{"type": "reload", "ok": true}) {
		t.Fatalf("EmitEvent returned false")
	}
	select {
	case raw := <-ch:
		var ev map[string]any
		if json.Unmarshal(raw, &ev) != nil || ev["type"] != "reload" {
			t.Fatalf("unexpected emitted frame: %s", raw)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for reload event")
	}
}
