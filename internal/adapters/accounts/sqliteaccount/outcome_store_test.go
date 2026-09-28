package sqliteaccount

import (
	"context"
	"testing"

	"github.com/madou1217/ai_home/application/accountoutcomes"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestAccountOutcomesAccumulateQueryAndPrune 验证计数累加、按粒度查询、删除账号的计数
// 被丢弃（不违反外键）以及保留期清理。
func TestAccountOutcomesAccumulateQueryAndPrune(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	account := registerInitialModelRefreshTestAccount(t, store, "synthetic-outcome-account")
	missing, err := accountcore.ParseAccountRef("acct_ffffffffffffffffffff")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	deltas := []accountoutcomes.Delta{
		{AccountRef: account.Ref(), Granularity: accountoutcomes.Day, BucketStartMS: 1000, Outcome: "success", Count: 3},
		{AccountRef: account.Ref(), Granularity: accountoutcomes.Day, BucketStartMS: 1000, Outcome: "rate_limited", Count: 1},
		{AccountRef: account.Ref(), Granularity: accountoutcomes.Hour, BucketStartMS: 2000, Outcome: "success", Count: 3},
		{AccountRef: missing, Granularity: accountoutcomes.Day, BucketStartMS: 1000, Outcome: "success", Count: 9},
	}
	for range 2 {
		if err := store.AddAccountOutcomes(ctx, deltas); err != nil {
			t.Fatalf("AddAccountOutcomes() error = %v", err)
		}
	}
	days, err := store.ListAccountOutcomes(ctx, accountoutcomes.Day, 0)
	if err != nil {
		t.Fatalf("ListAccountOutcomes(day) error = %v", err)
	}
	counts := map[string]int64{}
	for _, bucket := range days {
		if bucket.AccountRef != account.Ref() {
			t.Fatalf("unexpected account in results: %s", bucket.AccountRef)
		}
		counts[bucket.Outcome] = bucket.Count
	}
	if counts["success"] != 6 || counts["rate_limited"] != 2 || len(counts) != 2 {
		t.Fatalf("day counts = %v", counts)
	}
	if err := store.PruneAccountOutcomes(ctx, accountoutcomes.Day, 1001); err != nil {
		t.Fatalf("PruneAccountOutcomes() error = %v", err)
	}
	days, _ = store.ListAccountOutcomes(ctx, accountoutcomes.Day, 0)
	hours, _ := store.ListAccountOutcomes(ctx, accountoutcomes.Hour, 0)
	if len(days) != 0 || len(hours) != 1 || hours[0].Count != 6 {
		t.Fatalf("after prune days=%v hours=%v", days, hours)
	}
}
