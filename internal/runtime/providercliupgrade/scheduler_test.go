package providercliupgrade

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/providers"
)

type stubClearVerifier struct{}

func (stubClearVerifier) ProbeInstalledVersion(context.Context, string) (string, error) {
	return "2.0.0", nil
}
func (stubClearVerifier) Verify(context.Context, string, string) (Verification, error) {
	return Verification{Verdict: VerdictPass, Detail: "app_server_ok"}, nil
}

func TestSchedulerConcurrencyLifecycleAndProjection(t *testing.T) {
	t.Parallel()
	aiHome := t.TempDir()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}

	gate := make(chan struct{})
	entered := make(chan struct{}, 1)
	var closeOnce sync.Once
	deps := CycleDeps{
		Now: func() int64 { return 1_700_000_000_000 },
	}
	s := NewScheduler(SchedulerOptions{
		AIHomeDir:   aiHome,
		Catalog:     catalog,
		Providers:   []string{"codex", "claude"},
		CycleDeps:   &deps,
		ClearVerify: stubClearVerifier{},
		Now:         func() int64 { return 1_700_000_000_000 },
		RunCycleFn: func(_ context.Context, provider string, ledger Ledger, _ CycleDeps, _ CycleConfig) CycleOutcome {
			if provider == "codex" {
				closeOnce.Do(func() { close(entered) })
				<-gate
			}
			rec := ledger.Record(provider)
			rec.State = StateHealthy
			rec.Channel = ChannelStandaloneRelease
			rec.InstalledVersion = "1.0.0"
			rec.LatestVersion = "1.1.0"
			return CycleOutcome{
				OK:     true,
				Ledger: ledger.WithProvider(provider, rec),
				State:  StateHealthy,
				Reason: "up_to_date",
			}
		},
	})

	startDelay := int64(60 * 60 * 1000)
	s.config.StartDelayMs = startDelay
	st := s.Start(context.Background())
	if !st.Running {
		t.Fatalf("expected running=true")
	}
	defer s.Stop()

	done := make(chan RunResult, 1)
	go func() {
		done <- s.RunNow(context.Background(), "manual")
	}()
	<-entered

	// 运行中触发并发 RunNow 和 ClearBroken 均应互斥拒绝 already_running。
	dup := s.RunNow(context.Background(), "manual")
	if !dup.Skipped || dup.Reason != "already_running" {
		t.Fatalf("dup = %+v", dup)
	}
	cbBusy := s.ClearBroken(context.Background(), "codex", nil)
	if cbBusy.OK || cbBusy.Reason != "already_running" {
		t.Fatalf("cbBusy = %+v", cbBusy)
	}

	// 读取实时快照不应产生竞态。
	snapBusy := s.StatusSnapshot()
	schedMap := snapBusy["scheduler"].(SchedulerState)
	if !schedMap.Cycling || schedMap.ApplyingProvider != "codex" {
		t.Fatalf("busy schedMap = %+v", schedMap)
	}

	close(gate)
	res := <-done
	if !res.OK || res.Providers["codex"].Reason != "up_to_date" {
		t.Fatalf("res = %+v", res)
	}

	snap := s.StatusSnapshot()
	rows := snap["providers"].([]map[string]any)
	if len(rows) < 2 || rows[0]["lastTickState"] != StateHealthy || rows[0]["lastTickReason"] != "up_to_date" {
		t.Fatalf("projected rows = %+v", rows)
	}

	// 写入熔断账本后调用 ClearBroken 并验证状态更新。
	ledger := ReadLedger(aiHome)
	brokenRec := ledger.Record("codex")
	brokenRec.State = StateBroken
	brokenRec.Enabled = false
	brokenRec.Channel = ChannelStandaloneRelease
	brokenRec.InstalledVersion = "2.0.0"
	brokenRec.BlockedVersions = []string{"2.0.0", "2.1.0"}
	if err := WriteLedger(aiHome, ledger.WithProvider("codex", brokenRec)); err != nil {
		t.Fatalf("WriteLedger: %v", err)
	}
	cb := s.ClearBroken(context.Background(), "codex", nil)
	if !cb.OK || cb.Reason != "cleared" || cb.Version != "2.0.0" || !cb.Verified {
		t.Fatalf("clear broken = %+v", cb)
	}
	after := ReadLedger(aiHome).Record("codex")
	if after.State != StateHealthy || !after.Enabled || len(after.BlockedVersions) != 1 || after.BlockedVersions[0] != "2.1.0" {
		t.Fatalf("after = %+v", after)
	}

	// 带 0 延迟启动并在极短时间内 Stop 验证无竞态或 goroutine 卡死。
	sZero := NewScheduler(SchedulerOptions{
		AIHomeDir: aiHome,
		Catalog:   catalog,
		Providers: []string{"codex"},
		CycleDeps: &deps,
		Config:    SchedulerConfig{StartDelayMs: new(int64)},
		RunCycleFn: func(_ context.Context, provider string, ledger Ledger, _ CycleDeps, _ CycleConfig) CycleOutcome {
			return CycleOutcome{OK: true, Ledger: ledger, State: StateHealthy, Reason: "ok"}
		},
	})
	sZero.Start(context.Background())
	time.Sleep(20 * time.Millisecond)
	stopped := sZero.Stop()
	if stopped.Running {
		t.Fatalf("expected stopped")
	}
}
