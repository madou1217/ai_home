package sqliteaccount

import (
	"context"
	"errors"
	"testing"
	"time"

	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

// TestUsageStoreReplacesAndRestoresCompleteSnapshot 验证额度刷新是账号级原子全量替换。
func TestUsageStoreReplacesAndRestoresCompleteSnapshot(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	account := newCodexAPIKeyAccount(t, store, 1, "sk-usage-store")
	if err := store.Create(ctx, account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	first := newUsageStoreSnapshot(
		t,
		account.Ref(),
		testAccountTime(),
		[]usagecore.EntryInput{
			{
				Bucket:               "primary",
				Kind:                 usagecore.KindWindow,
				Scope:                usagecore.ScopeAccount,
				HasRemaining:         true,
				RemainingBasisPoints: 8_000,
				WindowSeconds:        5 * 60 * 60,
				ResetAt:              testAccountTime().Add(time.Hour),
				Availability:         usagecore.AvailabilityAvailable,
			},
			{
				Bucket:       "credits",
				Kind:         usagecore.KindCredits,
				Scope:        usagecore.ScopeAccount,
				Availability: usagecore.AvailabilityUnlimited,
			},
		},
	)
	if err := store.ReplaceUsageSnapshot(ctx, first); err != nil {
		t.Fatalf("ReplaceUsageSnapshot(first) error = %v", err)
	}
	restored, err := store.GetUsageSnapshot(ctx, account.Ref())
	if err != nil {
		t.Fatalf("GetUsageSnapshot(first) error = %v", err)
	}
	if !restored.IsValid() ||
		restored.AccountRef() != first.AccountRef() ||
		restored.ProviderID() != first.ProviderID() ||
		restored.Source() != first.Source() ||
		!restored.CapturedAt().Equal(first.CapturedAt()) ||
		len(restored.Entries()) != 2 {
		t.Fatalf("restored first = %#v", restored)
	}

	second := newUsageStoreSnapshot(
		t,
		account.Ref(),
		testAccountTime().Add(time.Minute),
		[]usagecore.EntryInput{{
			LimitID:              "codex",
			LimitName:            "Codex",
			Bucket:               "primary",
			Kind:                 usagecore.KindWindow,
			Scope:                usagecore.ScopeAccount,
			HasRemaining:         true,
			RemainingBasisPoints: 0,
			Availability:         usagecore.AvailabilityExhausted,
		}},
	)
	if err := store.ReplaceUsageSnapshot(ctx, second); err != nil {
		t.Fatalf("ReplaceUsageSnapshot(second) error = %v", err)
	}
	replaced, err := store.GetUsageSnapshot(ctx, account.Ref())
	if err != nil {
		t.Fatalf("GetUsageSnapshot(second) error = %v", err)
	}
	entries := replaced.Entries()
	if len(entries) != 1 ||
		entries[0].LimitID() != "codex" ||
		entries[0].Availability() != usagecore.AvailabilityExhausted ||
		!replaced.CapturedAt().Equal(second.CapturedAt()) {
		t.Fatalf("replaced snapshot = %#v entries=%#v", replaced, entries)
	}
}

// TestUsageStoreKeepsLastKnownGoodWhenReplacementFails 验证约束失败不会删除旧快照。
func TestUsageStoreKeepsLastKnownGoodWhenReplacementFails(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	account := newCodexAPIKeyAccount(t, store, 1, "sk-usage-rollback")
	if err := store.Create(ctx, account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	snapshot := newUsageStoreSnapshot(
		t,
		account.Ref(),
		testAccountTime(),
		[]usagecore.EntryInput{{
			Bucket:       "primary",
			Kind:         usagecore.KindWindow,
			Scope:        usagecore.ScopeAccount,
			Availability: usagecore.AvailabilityUnknown,
		}},
	)
	if err := store.ReplaceUsageSnapshot(ctx, snapshot); err != nil {
		t.Fatalf("ReplaceUsageSnapshot() error = %v", err)
	}
	if _, err := store.db.ExecContext(
		ctx,
		`CREATE TRIGGER reject_usage_insert
		 BEFORE INSERT ON account_usage
		 BEGIN
		   SELECT RAISE(ABORT, 'synthetic usage failure');
		 END`,
	); err != nil {
		t.Fatalf("CREATE TRIGGER error = %v", err)
	}
	replacement := newUsageStoreSnapshot(
		t,
		account.Ref(),
		testAccountTime().Add(time.Minute),
		[]usagecore.EntryInput{{
			Bucket:               "primary",
			Kind:                 usagecore.KindWindow,
			Scope:                usagecore.ScopeAccount,
			HasRemaining:         true,
			RemainingBasisPoints: 5_000,
			Availability:         usagecore.AvailabilityAvailable,
		}},
	)
	if err := store.ReplaceUsageSnapshot(ctx, replacement); err == nil {
		t.Fatal("ReplaceUsageSnapshot(rejected) error = nil")
	}
	restored, err := store.GetUsageSnapshot(ctx, account.Ref())
	if err != nil {
		t.Fatalf("GetUsageSnapshot() error = %v", err)
	}
	if !restored.CapturedAt().Equal(snapshot.CapturedAt()) ||
		restored.Entries()[0].Availability() != usagecore.AvailabilityUnknown {
		t.Fatalf("失败替换破坏 last-known-good: %#v", restored)
	}
}

// TestUsageStoreReturnsNotFoundWithoutCurrentSnapshot 验证缺省读取不会伪造空额度。
func TestUsageStoreReturnsNotFoundWithoutCurrentSnapshot(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	account := newCodexAPIKeyAccount(t, store, 1, "sk-usage-missing")
	if err := store.Create(context.Background(), account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	_, err := store.GetUsageSnapshot(context.Background(), account.Ref())
	if !errors.Is(err, usageapp.ErrSnapshotNotFound) {
		t.Fatalf("GetUsageSnapshot() error = %v", err)
	}
}

// newUsageStoreSnapshot 创建持久化测试使用的规范 Codex 快照。
func newUsageStoreSnapshot(
	t *testing.T,
	accountRef accountcore.AccountRef,
	capturedAt time.Time,
	entries []usagecore.EntryInput,
) usagecore.Snapshot {
	t.Helper()

	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: "codex",
		Source:     "codex_wham_usage",
		CapturedAt: capturedAt,
		Entries:    entries,
	})
	if err != nil {
		t.Fatalf("NewSnapshot() error = %v", err)
	}
	return snapshot
}
