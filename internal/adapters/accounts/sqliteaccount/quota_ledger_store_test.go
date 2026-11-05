package sqliteaccount

import (
	"context"
	"testing"
	"time"

	usageapp "github.com/madou1217/ai_home/application/accountusage"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

func TestReplaceUsageSnapshotWritesWindowLedger(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	capturedAt := base.Add(10 * time.Minute)
	resetAt := base.Add(5 * time.Hour)

	snapshot := newQuotaSnapshot(t, accountRef, capturedAt,
		windowEntry("primary", 300, resetAt, 80),
	)
	if err := store.ReplaceUsageSnapshot(ctx, snapshot); err != nil {
		t.Fatalf("ReplaceUsageSnapshot() error = %v", err)
	}

	ledger, hasLedger, err := store.GetQuotaWindowLedger(ctx, accountRef.String())
	if err != nil {
		t.Fatalf("GetQuotaWindowLedger() error = %v", err)
	}
	if !hasLedger {
		t.Fatal("快照写入后必须有账本")
	}
	if ledger.WindowMinutes != 300 || ledger.CloseAtMS != resetAt.UnixMilli() {
		t.Fatalf("ledger = %+v", ledger)
	}
	if ledger.AnchorAtMS != resetAt.Add(-5*time.Hour).UnixMilli() {
		t.Fatalf("anchor = %d, want %d", ledger.AnchorAtMS, resetAt.Add(-5*time.Hour).UnixMilli())
	}
	if ledger.Source != usagecore.QuotaLedgerSourceSnapshot {
		t.Fatalf("source = %q", ledger.Source)
	}
	if ledger.ObservedAtMS != capturedAt.UnixMilli() {
		t.Fatalf("observed = %d, want %d", ledger.ObservedAtMS, capturedAt.UnixMilli())
	}
}

func TestPhantomSnapshotDoesNotOverwriteNewerLedger(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	resetAt := base.Add(5 * time.Hour)

	live := newQuotaSnapshot(t, accountRef, base.Add(10*time.Minute),
		windowEntry("primary", 300, resetAt, 80),
	)
	if err := store.ReplaceUsageSnapshot(ctx, live); err != nil {
		t.Fatalf("ReplaceUsageSnapshot(live) error = %v", err)
	}

	// 空闲期快照：reset = 读取时刻 + 5h，锚点≈读取时刻 → 幻影。
	phantomCapturedAt := base.Add(2 * time.Hour)
	phantom := newQuotaSnapshot(t, accountRef, phantomCapturedAt,
		windowEntry("primary", 300, phantomCapturedAt.Add(5*time.Hour), 100),
	)
	if err := store.ReplaceUsageSnapshot(ctx, phantom); err != nil {
		t.Fatalf("ReplaceUsageSnapshot(phantom) error = %v", err)
	}

	ledger, hasLedger, err := store.GetQuotaWindowLedger(ctx, accountRef.String())
	if err != nil {
		t.Fatalf("GetQuotaWindowLedger() error = %v", err)
	}
	if !hasLedger {
		t.Fatal("账本不应消失")
	}
	if ledger.CloseAtMS != resetAt.UnixMilli() {
		t.Fatalf("幻影快照不能覆盖账本: %+v", ledger)
	}
}

func TestReplaceUsageSnapshotDetectsEarlyReplenishment(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)

	first := newQuotaSnapshot(t, accountRef, base.Add(10*time.Minute),
		windowEntry("primary", 300, base.Add(5*time.Hour), 20),
	)
	if err := store.ReplaceUsageSnapshot(ctx, first); err != nil {
		t.Fatalf("ReplaceUsageSnapshot(first) error = %v", err)
	}
	replenished := newQuotaSnapshot(t, accountRef, base.Add(time.Hour),
		windowEntry("primary", 300, base.Add(6*time.Hour), 100),
	)
	if err := store.ReplaceUsageSnapshot(ctx, replenished); err != nil {
		t.Fatalf("ReplaceUsageSnapshot(replenished) error = %v", err)
	}

	events, err := store.ListQuotaResetEvents(
		ctx,
		accountRef.String(),
		"rate_limit:primary",
		base.UnixMilli(),
		base.Add(24*time.Hour).UnixMilli(),
	)
	if err != nil {
		t.Fatalf("ListQuotaResetEvents() error = %v", err)
	}
	if len(events) != 1 {
		t.Fatalf("事件数 = %d, want 1", len(events))
	}
	event := events[0]
	if event.EventKind != usagecore.QuotaResetKindReplenishment {
		t.Fatalf("event kind = %q, want replenishment", event.EventKind)
	}
	if event.Classification != "early_inferred" {
		t.Fatalf("classification = %q", event.Classification)
	}
	if event.PreviousRemainingPct == nil || *event.PreviousRemainingPct != 20 {
		t.Fatalf("previous remaining = %v", event.PreviousRemainingPct)
	}
	if event.OccurredAtMS != base.Add(time.Hour).UnixMilli() {
		t.Fatalf("occurred = %d, want 发现时刻", event.OccurredAtMS)
	}
}

func TestReplaceUsageSnapshotDoesNotEmitEventForFlatQuota(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)

	for index := 0; index < 2; index++ {
		snapshot := newQuotaSnapshot(t, accountRef, base.Add(time.Duration(10+index*10)*time.Minute),
			windowEntry("primary", 300, base.Add(5*time.Hour), 100),
		)
		if err := store.ReplaceUsageSnapshot(ctx, snapshot); err != nil {
			t.Fatalf("ReplaceUsageSnapshot() error = %v", err)
		}
	}

	events, err := store.ListQuotaResetEvents(
		ctx,
		accountRef.String(),
		"rate_limit:primary",
		base.UnixMilli(),
		base.Add(24*time.Hour).UnixMilli(),
	)
	if err != nil {
		t.Fatalf("ListQuotaResetEvents() error = %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("100%% → 100%% 不能产生重置事件: %+v", events)
	}
}

func TestQuotaStatsEndToEndFromSnapshots(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	now := base.Add(2 * time.Hour)

	first := newQuotaSnapshot(t, accountRef, base.Add(10*time.Minute),
		windowEntry("primary", 300, base.Add(5*time.Hour), 20),
	)
	if err := store.ReplaceUsageSnapshot(ctx, first); err != nil {
		t.Fatalf("ReplaceUsageSnapshot(first) error = %v", err)
	}
	// 01:00 提前回血：额度回到 100%，reset 推到 06:00。
	replenished := newQuotaSnapshot(t, accountRef, base.Add(time.Hour),
		windowEntry("primary", 300, base.Add(6*time.Hour), 100),
	)
	if err := store.ReplaceUsageSnapshot(ctx, replenished); err != nil {
		t.Fatalf("ReplaceUsageSnapshot(replenished) error = %v", err)
	}

	service, err := usageapp.NewQuotaStatsService(usageapp.QuotaStatsDependencies{
		Samples:   store,
		Usage:     store,
		Ledger:    store,
		Events:    store,
		Snapshots: store,
		Clock:     func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewQuotaStatsService() error = %v", err)
	}
	result, err := service.BuildQuotaStats(ctx, usageapp.QuotaStatsQuery{
		AccountRef:    accountRef,
		WindowMinutes: 300,
		RangeDays:     30,
	})
	if err != nil {
		t.Fatalf("BuildQuotaStats() error = %v", err)
	}
	if len(result.Windows) != 1 {
		t.Fatalf("窗口数 = %d, want 1: %+v", len(result.Windows), result.Windows)
	}
	window := result.Windows[0]
	if !window.Truncated || window.CloseAtMS != base.Add(time.Hour).UnixMilli() {
		t.Fatalf("提前回血窗口未截断: %+v", window)
	}
	if window.ScheduledCloseAtMS != base.Add(5*time.Hour).UnixMilli() {
		t.Fatalf("scheduled close = %d", window.ScheduledCloseAtMS)
	}
	if window.ConsumedPct == nil || *window.ConsumedPct != 80 {
		t.Fatalf("consumed = %v, want 80", window.ConsumedPct)
	}
	if result.Summary.LastResetAtMS != base.Add(time.Hour).UnixMilli() {
		t.Fatalf("summary.last_reset = %d", result.Summary.LastResetAtMS)
	}
}
