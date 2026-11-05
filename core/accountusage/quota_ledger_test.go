package accountusage

import (
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func ledgerTestAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return accountRef
}

func ledgerTestSnapshot(
	t *testing.T,
	capturedAt time.Time,
	entries ...EntryInput,
) Snapshot {
	t.Helper()
	snapshot, err := NewSnapshot(SnapshotInput{
		AccountRef: ledgerTestAccountRef(t),
		ProviderID: "codex",
		Source:     "usage",
		CapturedAt: capturedAt,
		Entries:    entries,
	})
	if err != nil {
		t.Fatalf("NewSnapshot() error = %v", err)
	}
	return snapshot
}

func ledgerTestWindow(
	bucket string,
	windowSeconds int64,
	remainingPct float64,
	resetAt time.Time,
) EntryInput {
	return EntryInput{
		Bucket:               bucket,
		Kind:                 KindWindow,
		Scope:                ScopeAccount,
		HasRemaining:         true,
		RemainingBasisPoints: uint16(remainingPct * 100),
		WindowSeconds:        windowSeconds,
		ResetAt:              resetAt,
		Availability:         AvailabilityAvailable,
	}
}

func TestObserveQuotaWindowLive(t *testing.T) {
	base := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	snapshot := ledgerTestSnapshot(t, base,
		ledgerTestWindow("primary", 5*60*60, 60, base.Add(3*time.Hour)),
	)
	observation := ObserveQuotaWindow(snapshot)
	if observation.Kind != "live" || observation.Reason != "live_anchor" {
		t.Fatalf("observation = %+v, want live/live_anchor", observation)
	}
	if observation.WindowMinutes != 300 {
		t.Fatalf("window minutes = %d, want 300", observation.WindowMinutes)
	}
	if observation.AnchorAtMS != base.Add(-2*time.Hour).UnixMilli() {
		t.Fatalf("anchor = %d, want %d", observation.AnchorAtMS, base.Add(-2*time.Hour).UnixMilli())
	}
	if observation.CloseAtMS != base.Add(3*time.Hour).UnixMilli() {
		t.Fatalf("close = %d, want %d", observation.CloseAtMS, base.Add(3*time.Hour).UnixMilli())
	}
}

func TestObserveQuotaWindowPhantom(t *testing.T) {
	base := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	// 空闲期的 reset 就是「读取时刻 + 窗口时长」，锚点 ≈ 读取时刻 → 幻影。
	snapshot := ledgerTestSnapshot(t, base,
		ledgerTestWindow("primary", 5*60*60, 100, base.Add(5*time.Hour)),
	)
	observation := ObserveQuotaWindow(snapshot)
	if observation.Kind != "absent" || observation.Reason != "phantom_reset" {
		t.Fatalf("observation = %+v, want absent/phantom_reset", observation)
	}
	if observation.WindowMinutes != 300 {
		t.Fatalf("window minutes = %d, want 300", observation.WindowMinutes)
	}
	if observation.CloseAtMS != 0 || observation.AnchorAtMS != 0 {
		t.Fatalf("phantom observation must not carry anchor/close: %+v", observation)
	}
}

func TestObserveQuotaWindowPrefersShortestWindow(t *testing.T) {
	base := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	// 快照按 bucket 排序，周窗口排在前面也不能抢走账本：
	// 5h 滚动窗口才是激活调度关心的窗口。
	snapshot := ledgerTestSnapshot(t, base,
		ledgerTestWindow("a-weekly", 7*24*60*60, 80, base.Add(3*24*time.Hour)),
		ledgerTestWindow("z-five-hour", 5*60*60, 40, base.Add(3*time.Hour)),
	)
	observation := ObserveQuotaWindow(snapshot)
	if observation.Kind != "live" || observation.WindowMinutes != 300 {
		t.Fatalf("observation = %+v, want live 5h window", observation)
	}
}

func TestObserveQuotaWindowUnknownWithoutWindow(t *testing.T) {
	base := time.Date(2026, 11, 5, 10, 0, 0, 0, time.UTC)
	snapshot := ledgerTestSnapshot(t, base, EntryInput{
		Bucket:               "credits",
		Kind:                 KindCredits,
		Scope:                ScopeAccount,
		HasRemaining:         true,
		RemainingBasisPoints: 5000,
		Availability:         AvailabilityAvailable,
	})
	observation := ObserveQuotaWindow(snapshot)
	if observation.Kind != "unknown" || observation.Reason != "window_entry_missing" {
		t.Fatalf("observation = %+v, want unknown/window_entry_missing", observation)
	}
}

func TestReconcileQuotaWindowLedgerIsMonotonic(t *testing.T) {
	base := int64(1_800_000_000_000)
	ledger := QuotaWindowLedger{
		WindowMinutes: 300,
		AnchorAtMS:    base - 60*MS_PER_MINUTE,
		CloseAtMS:     base + 240*MS_PER_MINUTE,
		Source:        QuotaLedgerSourceSnapshot,
		ObservedAtMS:  base,
	}

	// 更旧的观察不能覆盖账本。
	older := ReconcileQuotaWindowLedger(ledger, QuotaWindowObservation{
		Kind: "live", ObservedAtMS: base - 1000, WindowMinutes: 300,
		AnchorAtMS: base - 10*MS_PER_MINUTE, CloseAtMS: base + 290*MS_PER_MINUTE,
	})
	if older != ledger {
		t.Fatalf("older observation must not overwrite ledger: %+v", older)
	}

	// 更新的真实窗口覆盖账本。
	newer := ReconcileQuotaWindowLedger(ledger, QuotaWindowObservation{
		Kind: "live", ObservedAtMS: base + 1000, WindowMinutes: 300,
		AnchorAtMS: base + 1000, CloseAtMS: base + 1000 + 300*MS_PER_MINUTE,
	})
	if newer.CloseAtMS != base+1000+300*MS_PER_MINUTE ||
		newer.Source != QuotaLedgerSourceSnapshot {
		t.Fatalf("newer live observation not applied: %+v", newer)
	}

	// 关窗时刻之前观察到「没有窗口」不改变账本（那时窗口本来就关着/或更旧）。
	beforeClose := ReconcileQuotaWindowLedger(ledger, QuotaWindowObservation{
		Kind: "absent", ObservedAtMS: base + 1000, WindowMinutes: 300,
	})
	if beforeClose != ledger {
		t.Fatalf("absent observation before close must not clear ledger: %+v", beforeClose)
	}

	// 关窗时刻之后确认没有窗口 → 清空锚点与关窗时刻，但保留窗口长度。
	afterClose := ReconcileQuotaWindowLedger(ledger, QuotaWindowObservation{
		Kind: "absent", ObservedAtMS: base + 241*MS_PER_MINUTE, WindowMinutes: 300,
	})
	if afterClose.CloseAtMS != 0 || afterClose.AnchorAtMS != 0 {
		t.Fatalf("absent after close must clear window: %+v", afterClose)
	}
	if afterClose.WindowMinutes != 300 {
		t.Fatalf("window minutes = %d, want 300", afterClose.WindowMinutes)
	}
}

func TestReconcileQuotaWindowLedgerIgnoresUnknown(t *testing.T) {
	ledger := QuotaWindowLedger{
		WindowMinutes: 300,
		CloseAtMS:     1_800_000_000_000,
		Source:        QuotaLedgerSourceActivity,
		ObservedAtMS:  1_799_000_000_000,
	}
	next := ReconcileQuotaWindowLedger(ledger, QuotaWindowObservation{
		Kind:         "unknown",
		ObservedAtMS: 1_800_100_000_000,
	})
	if next != ledger {
		t.Fatalf("unknown observation must keep ledger: %+v", next)
	}
}
