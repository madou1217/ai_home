package sqliteaccount

import (
	"context"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

// BenchmarkUsageStoreWithTenThousandAccounts 测量 1 万账号下当前快照点查和原子替换。
func BenchmarkUsageStoreWithTenThousandAccounts(benchmark *testing.B) {
	const accountCount = 10_000
	ctx := context.Background()
	store := openBenchmarkStore(benchmark)
	seedBenchmarkAccounts(benchmark, store, accountCount)
	seedBenchmarkUsageSnapshots(benchmark, store, accountCount)
	accountRef := benchmarkAccountRef(benchmark, accountCount/2)
	replacement := benchmarkUsageSnapshot(
		benchmark,
		accountRef,
		testAccountTime().Add(time.Minute),
	)

	benchmark.Run("read_current_snapshot", func(benchmark *testing.B) {
		benchmark.ReportAllocs()
		benchmark.ResetTimer()
		for range benchmark.N {
			snapshot, err := store.GetUsageSnapshot(ctx, accountRef)
			if err != nil || len(snapshot.Entries()) == 0 {
				benchmark.Fatalf(
					"GetUsageSnapshot() snapshot=%#v error=%v",
					snapshot,
					err,
				)
			}
		}
	})
	benchmark.Run("replace_current_snapshot", func(benchmark *testing.B) {
		benchmark.ReportAllocs()
		benchmark.ResetTimer()
		for range benchmark.N {
			if err := store.ReplaceUsageSnapshot(
				ctx,
				replacement,
			); err != nil {
				benchmark.Fatalf("ReplaceUsageSnapshot() error = %v", err)
			}
		}
	})
	benchmark.ReportMetric(accountCount, "accounts")
}

// seedBenchmarkUsageSnapshots 为每个账号写入一条有效当前窗口。
func seedBenchmarkUsageSnapshots(
	benchmark *testing.B,
	store *Store,
	accountCount int,
) {
	benchmark.Helper()

	transaction, err := store.db.Begin()
	if err != nil {
		benchmark.Fatalf("Begin() error = %v", err)
	}
	defer func() {
		_ = transaction.Rollback()
	}()
	statement, err := transaction.Prepare(`
		INSERT INTO account_usage (
			account_ref, limit_id, limit_name, bucket, kind, scope, scope_key,
			remaining_bps, availability, window_seconds, reset_at_ms,
			source, captured_at_ms
		) VALUES (
			?, '', '', 'primary', 'window', 'account', '',
			7500, 'available', 18000, NULL,
			'codex_wham_usage', 1785110400000
		)`)
	if err != nil {
		benchmark.Fatalf("Prepare() error = %v", err)
	}
	defer func() {
		_ = statement.Close()
	}()
	for index := 0; index < accountCount; index++ {
		accountRef := benchmarkAccountRef(benchmark, index)
		if _, err := statement.Exec(accountRef.String()); err != nil {
			benchmark.Fatalf("insert usage %d error = %v", index, err)
		}
	}
	if err := transaction.Commit(); err != nil {
		benchmark.Fatalf("Commit() error = %v", err)
	}
}

// benchmarkUsageSnapshot 创建含窗口和 Credits 的规范替换快照。
func benchmarkUsageSnapshot(
	benchmark *testing.B,
	accountRef accountcore.AccountRef,
	capturedAt time.Time,
) usagecore.Snapshot {
	benchmark.Helper()

	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: accountRef,
		ProviderID: "codex",
		Source:     "codex_wham_usage",
		CapturedAt: capturedAt,
		Entries: []usagecore.EntryInput{
			{
				Bucket:               "primary",
				Kind:                 usagecore.KindWindow,
				Scope:                usagecore.ScopeAccount,
				HasRemaining:         true,
				RemainingBasisPoints: 7_500,
				WindowSeconds:        18_000,
				Availability:         usagecore.AvailabilityAvailable,
			},
			{
				Bucket:               "secondary",
				Kind:                 usagecore.KindWindow,
				Scope:                usagecore.ScopeAccount,
				HasRemaining:         true,
				RemainingBasisPoints: 8_000,
				WindowSeconds:        604_800,
				Availability:         usagecore.AvailabilityAvailable,
			},
			{
				Bucket:       "credits",
				Kind:         usagecore.KindCredits,
				Scope:        usagecore.ScopeAccount,
				Availability: usagecore.AvailabilityUnlimited,
			},
		},
	})
	if err != nil {
		benchmark.Fatalf("NewSnapshot() error = %v", err)
	}
	return snapshot
}
