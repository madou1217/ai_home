package sqliteaccount

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
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

// TestUsageStoreRejectsSnapshotFromStaleCredentialVersion 验证凭据版本推进后，
// 旧上游请求不能删除或覆盖此前成功的额度快照。
func TestUsageStoreRejectsSnapshotFromStaleCredentialVersion(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	credential := mustCodexAPIKey(t, "sk-usage-generation-cas")
	account := newAccountForCredential(t, store, credential, 1)
	registerAccountWithCredential(t, store, account, credential)
	lastKnownGood := newUsageStoreSnapshot(
		t,
		account.Ref(),
		testAccountTime(),
		[]usagecore.EntryInput{{
			Bucket:       "primary",
			Kind:         usagecore.KindWindow,
			Scope:        usagecore.ScopeAccount,
			Availability: usagecore.AvailabilityAvailable,
		}},
	)
	if err := store.ReplaceUsageSnapshot(ctx, lastKnownGood); err != nil {
		t.Fatalf("ReplaceUsageSnapshot() error = %v", err)
	}
	staleCredential, err := store.GetCredentialSnapshot(ctx, account.Ref())
	if err != nil {
		t.Fatalf("GetCredentialSnapshot() error = %v", err)
	}
	replacement, err := accountapp.NewCredentialReplacement(
		staleCredential,
		staleCredential.Credential(),
		staleCredential.UpdatedAt().Add(time.Second),
	)
	if err != nil {
		t.Fatalf("NewCredentialReplacement() error = %v", err)
	}
	if err := store.ReplaceCredential(ctx, replacement); err != nil {
		t.Fatalf("ReplaceCredential() error = %v", err)
	}
	staleUsage := newUsageStoreSnapshot(
		t,
		account.Ref(),
		testAccountTime().Add(time.Minute),
		[]usagecore.EntryInput{{
			Bucket:       "primary",
			Kind:         usagecore.KindWindow,
			Scope:        usagecore.ScopeAccount,
			Availability: usagecore.AvailabilityExhausted,
		}},
	)
	err = store.ReplaceUsageSnapshotIfCredentialVersion(
		ctx,
		staleUsage,
		staleCredential.UpdatedAt(),
	)
	if !errors.Is(err, accountapp.ErrCredentialConflict) {
		t.Fatalf("ReplaceUsageSnapshotIfCredentialVersion() error = %v", err)
	}
	restored, err := store.GetUsageSnapshot(ctx, account.Ref())
	if err != nil {
		t.Fatalf("GetUsageSnapshot() error = %v", err)
	}
	if !restored.CapturedAt().Equal(lastKnownGood.CapturedAt()) ||
		restored.Entries()[0].Availability() != usagecore.AvailabilityAvailable {
		t.Fatalf("stale usage changed last-known-good = %#v", restored)
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

// TestUsageAndModelRefreshesSerializeSQLiteWrites 验证账号创建后的两个后台
// 生命周期任务可同时启动，但不会让 SQLite deferred transaction 互相升级失败。
func TestUsageAndModelRefreshesSerializeSQLiteWrites(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	account := newCodexAPIKeyAccount(t, store, 1, "sk-concurrent-derived-state")
	if err := store.Create(ctx, account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	models := []runtimecore.ModelID{runtimecore.ModelID("gpt-concurrent-refresh")}
	if !accountapp.ValidDiscoveredModelIDs(models) {
		t.Fatal("测试模型集合无效")
	}

	for iteration := 0; iteration < 64; iteration++ {
		started := make(chan struct{})
		errorsByTask := make(chan error, 2)
		capturedAt := testAccountTime().Add(time.Duration(iteration) * time.Millisecond)
		snapshot := newUsageStoreSnapshot(
			t,
			account.Ref(),
			capturedAt,
			[]usagecore.EntryInput{{
				Bucket:       "primary",
				Kind:         usagecore.KindWindow,
				Scope:        usagecore.ScopeAccount,
				Availability: usagecore.AvailabilityAvailable,
			}},
		)
		var ready sync.WaitGroup
		ready.Add(2)
		go func() {
			ready.Done()
			<-started
			errorsByTask <- store.ReplaceUsageSnapshot(ctx, snapshot)
		}()
		go func() {
			ready.Done()
			<-started
			_, err := store.ReplaceDiscoveredModels(
				ctx,
				account.Ref(),
				models,
				capturedAt,
			)
			errorsByTask <- err
		}()
		ready.Wait()
		close(started)
		for range 2 {
			if err := <-errorsByTask; err != nil {
				t.Fatalf("iteration %d derived-state write error = %v", iteration, err)
			}
		}
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
