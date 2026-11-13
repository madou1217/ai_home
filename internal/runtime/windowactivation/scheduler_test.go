package windowactivation

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

type stubAccountSource struct {
	mu       sync.Mutex
	accounts []AccountSnapshot
	models   map[string][]string
}

func (s *stubAccountSource) ListAccounts(context.Context) ([]AccountSnapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]AccountSnapshot(nil), s.accounts...), nil
}

func (s *stubAccountSource) ListAccountModels(_ context.Context, ref string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.models[ref]...), nil
}

func TestDecideActivationAllTriggers(t *testing.T) {
	t.Parallel()
	const now = int64(2_000_000_000_000)

	if d := DecideActivation(DecisionInput{NowMs: now, Enabled: false}); d.Trigger != "disabled" {
		t.Fatalf("disabled = %+v", d)
	}
	if d := DecideActivation(DecisionInput{NowMs: now, Enabled: true, HasSpec: true, APIKeyMode: true}); d.Trigger != "api_key_account" {
		t.Fatalf("apiKey = %+v", d)
	}
	if d := DecideActivation(DecisionInput{NowMs: now, Enabled: true, HasSpec: true, RuntimeStatus: "quota_exhausted"}); d.Trigger != "runtime_blocked" {
		t.Fatalf("runtime_blocked = %+v", d)
	}
	if d := DecideActivation(DecisionInput{NowMs: now, Enabled: true, HasSpec: true, LastProbeAtMs: now - 10_000}); d.Trigger != "debounced" {
		t.Fatalf("debounced = %+v", d)
	}
	if d := DecideActivation(DecisionInput{
		NowMs: now, Enabled: true, HasSpec: true, LastProbeAtMs: now - 120_000,
		LastOutcome: "account_not_matched", Ledger: Ledger{ProbeFailureCount: 1},
		EffectiveIntervalMs: DefaultIntervalMs,
	}); d.Trigger != "probe_retry_backoff" {
		t.Fatalf("slow backoff = %+v", d)
	}
	if d := DecideActivation(DecisionInput{
		NowMs: now, Enabled: true, HasSpec: true,
		View: &WindowView{Kind: "open", CloseAtMs: now + 60_000},
	}); d.Trigger != "window_open" || d.Action != "skip" {
		t.Fatalf("window_open = %+v", d)
	}
	if d := DecideActivation(DecisionInput{
		NowMs: now, Enabled: true, HasSpec: true,
		View: &WindowView{Kind: "closed", CloseAtMs: now - 30_000},
	}); d.Trigger != "close_grace" {
		t.Fatalf("close_grace = %+v", d)
	}
	if d := DecideActivation(DecisionInput{
		NowMs: now, Enabled: true, HasSpec: true,
		LastProbeAtMs:    now - 10*60_000,
		LastActivityAtMs: now - 60_000,
		View:             &WindowView{Kind: "closed", CloseAtMs: now - 120_000},
	}); d.Trigger != "user_reopened" || d.ReanchorAtMs != now-60_000 {
		t.Fatalf("user_reopened = %+v", d)
	}
	if d := DecideActivation(DecisionInput{
		NowMs: now, Enabled: true, HasSpec: true,
		View: &WindowView{Kind: "closed", CloseAtMs: now - 120_000},
	}); d.Action != "probe" || d.Trigger != "window_closed" {
		t.Fatalf("window_closed = %+v", d)
	}
	if d := DecideActivation(DecisionInput{
		NowMs: now, Enabled: true, HasSpec: true,
		View: &WindowView{Kind: "absent", ObservedAtMs: now - 60_000},
	}); d.Action != "probe" || d.Trigger != "window_absent" {
		t.Fatalf("window_absent = %+v", d)
	}
	if d := DecideActivation(DecisionInput{
		NowMs: now, Enabled: true, HasSpec: true,
		View: &WindowView{Kind: "unknown"},
	}); d.Action != "probe" || d.Trigger != "periodic_fallback" {
		t.Fatalf("periodic_fallback = %+v", d)
	}
}

func TestSchedulerConcurrencyRunNowAndLifecycle(t *testing.T) {
	dir := seedAppStateDB(t)
	ctx := context.Background()
	writeKVTest(t, dir, ConfigKeyPrefix+testAccountRef, `{"enabled":true,"intervalMs":3600000,"updatedAt":1}`)

	var nowOffset atomic.Int64
	baseTime := int64(1_750_000_000_000)
	var dispatchCalls atomic.Int32
	blockCh := make(chan struct{})
	startedCh := make(chan struct{})
	var signalOnce sync.Once

	source := &stubAccountSource{
		accounts: []AccountSnapshot{
			{
				Provider:   "codex",
				AccountRef: testAccountRef,
				Enabled:    true,
				Status:     "up",
				UsageSnapshot: &UsageSnapshot{
					CapturedAtMs: baseTime,
					Entries:      []UsageEntry{{WindowMinutes: 300, ResetAtMs: baseTime + 300*MsPerMinute}},
				},
			},
			{
				Provider:   "codex",
				AccountRef: testOtherRef,
				Enabled:    true,
			},
		},
		models: map[string][]string{
			testAccountRef: {"gpt-6-luna"},
		},
	}

	sched := NewScheduler(SchedulerOptions{
		AIHomeDir: dir,
		Config: SchedulerConfig{
			Enabled:           true,
			MinIntervalMs:     DefaultMinIntervalMs,
			DefaultIntervalMs: DefaultIntervalMs,
			TickInterval:      5 * time.Minute,
			StartDelay:        time.Hour,
			BatchSize:         4,
		},
		Accounts: source,
		Now: func() time.Time {
			return time.UnixMilli(baseTime + nowOffset.Load())
		},
		DispatchProbe: func(_ context.Context, input ProbeInput) ProbeResult {
			dispatchCalls.Add(1)
			signalOnce.Do(func() { close(startedCh) })
			<-blockCh
			status := 200
			return ProbeResult{
				OK:               true,
				Matched:          true,
				HTTPStatus:       &status,
				ServedAccountRef: input.AccountRef,
				Model:            input.Model,
			}
		},
	})

	sched.Start(ctx)
	defer sched.Stop()

	res1Ch := make(chan TickResult, 1)
	go func() {
		res1Ch <- sched.RunNow(ctx, "test1")
	}()
	<-startedCh

	// 并发二次触发应当被 non-overlapping cycling 跳过
	res2 := sched.RunNow(ctx, "test2")
	if !res2.Skipped || res2.Reason != "already_running" {
		t.Fatalf("concurrent RunNow = %+v", res2)
	}
	if st := sched.State(); !st.Running || !st.Cycling {
		t.Fatalf("expected running & cycling, got %+v", st)
	}

	close(blockCh)
	res1 := <-res1Ch
	if !res1.OK || len(res1.Probed) != 1 || res1.Probed[0].Outcome != "activated" || res1.Probed[0].Model != "gpt-6-luna" {
		t.Fatalf("res1 = %+v", res1)
	}
	if dispatchCalls.Load() != 1 {
		t.Fatalf("dispatchCalls = %d, want 1", dispatchCalls.Load())
	}

	// 验证落盘账本已被锚定为 open (probe 来源)
	persisted, found := ReadAccountState(ctx, dir, testAccountRef)
	if !found || persisted.WindowSource != "probe" || persisted.WindowAnchorAtMs != baseTime || persisted.WindowCloseAtMs != baseTime+300*MsPerMinute {
		t.Fatalf("persisted state = %+v (found=%v)", persisted, found)
	}
	// 下一轮应命中 window_open / debounced 并跳过
	nowOffset.Store(120_000)
	res3 := sched.RunNow(ctx, "test3")
	if !res3.OK || len(res3.Probed) != 0 || len(res3.Decisions) != 1 || res3.Decisions[0].Trigger != "window_open" {
		t.Fatalf("res3 = %+v", res3)
	}

	dbPath, _ := appstate.DatabasePath(dir)
	raw, _, _ := appstate.ReadKV(ctx, dbPath, StateKeyPrefix+testAccountRef)
	if raw == "" {
		t.Fatalf("expected persisted kv")
	}
}
