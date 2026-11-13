package usagedaemons

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type fakeQuotaSource struct {
	accounts []QuotaAccount
	err      error
}

func (f *fakeQuotaSource) ListQuotaAccounts(context.Context) ([]QuotaAccount, error) {
	return f.accounts, f.err
}

type fakeQuotaPort struct {
	mu      sync.Mutex
	probed  []string
	failRef string
}

func (f *fakeQuotaPort) SupportsProvider(provider string) bool {
	return provider == "codex" || provider == "claude" || provider == "cline"
}

func (f *fakeQuotaPort) ProbeAccountQuota(_ context.Context, acc QuotaAccount) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.probed = append(f.probed, acc.AccountRef)
	if acc.AccountRef == f.failRef {
		return errors.New("probe_http_500")
	}
	return nil
}

func floatPtr(v float64) *float64 { return &v }

func TestQuotaProbeSchedulerPrioritizationCooldownAndBatch(t *testing.T) {
	t.Parallel()

	nowMs := atomic.Int64{}
	nowMs.Store(1_700_000_000_000)
	nowFn := func() time.Time { return time.UnixMilli(nowMs.Load()) }

	port := &fakeQuotaPort{failRef: "acct_near_reset_fail"}
	accounts := []QuotaAccount{
		// APIKey 模式跳过
		{Provider: "codex", AccountRef: "acct_apikey", APIKeyMode: true},
		// 不支持额度源的 provider 跳过
		{Provider: "unknown", AccountRef: "acct_unknown"},
		// 冷账号（无快照）urgency = 1
		{Provider: "codex", AccountRef: "acct_cold", Snapshot: nil},
		// 满额且未过期（不探测）
		{
			Provider:   "codex",
			AccountRef: "acct_full_fresh",
			Snapshot: &QuotaSnapshot{
				CapturedAtMs: nowMs.Load() - 60_000,
				Entries:      []QuotaEntry{{RemainingPct: floatPtr(100), ResetAtMs: nowMs.Load() + 60_000}},
			},
		},
		// 超过 15 分钟且有消耗 urgency = 2
		{
			Provider:   "claude",
			AccountRef: "acct_stale_consumed",
			Snapshot: &QuotaSnapshot{
				CapturedAtMs: nowMs.Load() - 20*60_000,
				Entries:      []QuotaEntry{{RemainingPct: floatPtr(40), ResetAtMs: nowMs.Load() + 3600_000}},
			},
		},
		// 临近重置（3m 内且 <= 95%）urgency = 10
		{
			Provider:   "codex",
			AccountRef: "acct_near_reset_1",
			Snapshot: &QuotaSnapshot{
				CapturedAtMs: nowMs.Load() - 10_000,
				Entries:      []QuotaEntry{{RemainingPct: floatPtr(20), ResetAtMs: nowMs.Load() + 60_000}},
			},
		},
		// 临近重置但探测失败也不影响同批其他账号
		{
			Provider:   "cline",
			AccountRef: "acct_near_reset_fail",
			Snapshot: &QuotaSnapshot{
				CapturedAtMs: nowMs.Load() - 10_000,
				Entries:      []QuotaEntry{{RemainingPct: nil, ResetAtMs: nowMs.Load() - 1_000}},
			},
		},
		// 再来 2 个冷账号，检验 batchSize=4 截断后剩 1 个未探测
		{Provider: "codex", AccountRef: "acct_cold_extra_1"},
		{Provider: "codex", AccountRef: "acct_cold_extra_2"},
	}

	s := NewQuotaProbeScheduler(QuotaProbeOptions{
		BatchSize: 4,
		Source:    &fakeQuotaSource{accounts: accounts},
		Port:      port,
		Now:       nowFn,
	})

	summary, err := s.Tick(context.Background())
	if err != nil {
		t.Fatalf("Tick 1 error = %v", err)
	}
	if summary.Candidates != 6 || summary.Probed != 3 || summary.Failed != 1 {
		t.Fatalf("Tick 1 summary = %+v, want candidates=6 probed=3 failed=1", summary)
	}
	wantOrder := []string{"acct_near_reset_1", "acct_near_reset_fail", "acct_stale_consumed", "acct_cold"}
	port.mu.Lock()
	gotOrder := append([]string(nil), port.probed...)
	port.mu.Unlock()
	for i, w := range wantOrder {
		if gotOrder[i] != w {
			t.Fatalf("probe order = %v, want %v", gotOrder, wantOrder)
		}
	}

	// 10s 内再 Tick：前 4 个均处于 45s 冷却期，仅剩后两个冷账号被探测
	nowMs.Add(10_000)
	summary2, err := s.Tick(context.Background())
	if err != nil {
		t.Fatalf("Tick 2 error = %v", err)
	}
	if summary2.Candidates != 2 || summary2.Probed != 2 {
		t.Fatalf("Tick 2 summary = %+v, want candidates=2 probed=2", summary2)
	}

	// 跨过 45s 冷却后再 Tick，所有 6 个重新入候选
	nowMs.Add(46_000)
	summary3, err := s.Tick(context.Background())
	if err != nil {
		t.Fatalf("Tick 3 error = %v", err)
	}
	if summary3.Candidates != 6 {
		t.Fatalf("Tick 3 summary = %+v, want candidates=6", summary3)
	}
}

type fakeUsageScanPort struct {
	mu          sync.Mutex
	calls       []UsageScanRequest
	pricingHits int
	enteredCh   chan struct{}
	releaseCh   chan struct{}
	scanErr     error
}

func (f *fakeUsageScanPort) ScanUsage(_ context.Context, req UsageScanRequest) (UsageScanResult, error) {
	if f.enteredCh != nil {
		select {
		case <-f.enteredCh:
		default:
			close(f.enteredCh)
		}
	}
	if f.releaseCh != nil {
		<-f.releaseCh
	}
	f.mu.Lock()
	f.calls = append(f.calls, req)
	f.mu.Unlock()
	if f.scanErr != nil {
		return UsageScanResult{}, f.scanErr
	}
	return UsageScanResult{RecordsScanned: 42, FilesScanned: 3}, nil
}

func (f *fakeUsageScanPort) SyncPricingIfStale(context.Context) (map[string]any, error) {
	f.mu.Lock()
	f.pricingHits++
	f.mu.Unlock()
	return map[string]any{"ok": true, "updated": 1}, nil
}

func TestUsageScanSchedulerNonOverlappingAndLifecycle(t *testing.T) {
	t.Parallel()

	port := &fakeUsageScanPort{
		enteredCh: make(chan struct{}),
		releaseCh: make(chan struct{}),
	}
	var tokenUpdated atomic.Int32
	var completed atomic.Int32
	initCh := make(chan time.Time, 1)
	loopCh := make(chan time.Time, 1)

	s := NewUsageScanScheduler(UsageScanSchedulerOptions{
		Port:          port,
		testInitialCh: initCh,
		testLoopCh:    loopCh,
		OnTokenUsageUpdated: func(context.Context, string, UsageScanResult) error {
			tokenUpdated.Add(1)
			return nil
		},
		OnScanComplete: func(context.Context, string, UsageScanResult) error {
			completed.Add(1)
			return nil
		},
	})
	s.Start(context.Background())
	defer s.Close()

	// 驱动 startup 触发并阻塞在 ScanUsage 内
	initCh <- time.Now()
	<-port.enteredCh

	// 并发手动 Trigger 应返回 already_running
	skipped := s.Trigger(context.Background(), "manual")
	if skipped.OK || !skipped.Skipped || skipped.SkipReason != "already_running" {
		close(port.releaseCh)
		t.Fatalf("expected already_running skip, got %+v", skipped)
	}
	close(port.releaseCh)

	// 等待扫描状态收尾
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if st := s.State(); st.ScanCount == 1 && !st.Scanning {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	st := s.State()
	if st.ScanCount != 1 || st.LastResult == nil || st.LastResult.Result.RecordsScanned != 42 {
		t.Fatalf("unexpected scheduler state after startup scan: %+v", st)
	}
	if tokenUpdated.Load() != 1 || completed.Load() != 1 {
		t.Fatalf("expected post-scan callbacks once each, got token=%d complete=%d", tokenUpdated.Load(), completed.Load())
	}
}

type fakeProviderPort struct {
	mu       sync.Mutex
	attempts int
	calls    []SessionScanRequest
	failOnce error
}

func (f *fakeProviderPort) ScanGrokSessionUsage(_ context.Context, sessionID string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.attempts++
	f.calls = append(f.calls, SessionScanRequest{Provider: "grok", SessionID: sessionID})
	if f.failOnce != nil && f.attempts == 1 {
		return 0, f.failOnce
	}
	return 3, nil
}

func (f *fakeProviderPort) ScanCodebuddySessionUsage(_ context.Context, provider, sessionID string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.attempts++
	f.calls = append(f.calls, SessionScanRequest{Provider: provider, SessionID: sessionID})
	return 5, nil
}

func (f *fakeProviderPort) ScanProviderNativeUsage(_ context.Context, provider string) (int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.attempts++
	f.calls = append(f.calls, SessionScanRequest{Provider: provider, SessionID: "native-billing"})
	return 2, nil
}

func TestProviderRefreshCoordinatorCoalescingBackpressureAndFSWatch(t *testing.T) {
	t.Parallel()

	aiHome := t.TempDir()
	hostHome := t.TempDir()
	cbProj := filepath.Join(hostHome, ".codebuddy", "projects", "demo")
	if err := os.MkdirAll(cbProj, 0o700); err != nil {
		t.Fatal(err)
	}
	zcodeOwnerDir := filepath.Join(aiHome, "run", "auth-projections", "zcode", "acct_1", ".aih-runtime")
	if err := os.MkdirAll(zcodeOwnerDir, 0o700); err != nil {
		t.Fatal(err)
	}

	port := &fakeProviderPort{failOnce: ErrScanQueueFull}
	coord := NewProviderRefreshCoordinator(ProviderRefreshOptions{
		HostHomeDir:       hostHome,
		AIHomeDir:         aiHome,
		Port:              port,
		Delays:            []time.Duration{10 * time.Millisecond, 20 * time.Millisecond, 30 * time.Millisecond},
		DiscoveryInterval: time.Second,
	})
	if err := coord.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	defer coord.Close()

	// 同一个 Grok 会话连续收到 2 次结束事件：合流成同 key revision，背压错误后自动重试一次拿到 3 条记录
	if !coord.NotifyEvent(SessionEvent{Provider: "grok", SessionID: "grok_s1", Type: "session:turn-completed"}) {
		t.Fatal("expected grok event accepted")
	}
	if !coord.NotifyEvent(SessionEvent{Provider: "grok", SessionID: "grok_s1", Type: "session:turn-completed"}) {
		t.Fatal("expected second coalesced grok event accepted")
	}

	// WorkBuddy 国内站文件变化事件应归并到 codebuddycn 并带出同区 peers
	target, ok := resolveRefreshTarget(SessionEvent{
		Provider:  "workbuddycn",
		SessionID: "wb_sess_1",
		Type:      "session:file-changed",
	})
	if !ok || target.provider != "codebuddycn" || len(target.usageProviders) != 2 {
		t.Fatalf("unexpected CodeBuddy region mapping: %+v ok=%v", target, ok)
	}

	// 写入 ZCode owner log 文件触发 fsnotify 增量刷新
	ownerLog := filepath.Join(zcodeOwnerDir, "zcode-model-usage-owners.jsonl")
	if err := os.WriteFile(ownerLog, []byte(`{"usageId":"u1"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		st := coord.State()
		if st.ScansExecuted >= 1 && st.BackpressureHits >= 1 && st.PendingEntries == 0 {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	st := coord.State()
	if st.BackpressureHits < 1 || st.ScansExecuted < 1 || st.LastError != "" {
		t.Fatalf("unexpected coordinator state: %+v", st)
	}

	n, err := coord.Trigger(context.Background(), "zcode")
	if err != nil || n != 2 {
		t.Fatalf("manual Trigger(zcode) = (%d, %v), want (2, nil)", n, err)
	}
}
