package usageledger

import (
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
)

func bucketRecord(t *testing.T, occurredAt time.Time, input, output uint64) Record {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	usage, err := inference.NewUsage(inference.UsageInput{InputTokens: input, OutputTokens: output})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	record, err := NewRecord(RecordInput{
		AccountRef: accountRef,
		Provider:   "codex",
		Model:      "gpt-6.1-sol",
		OccurredAt: occurredAt.UTC(),
		Usage:      usage,
	})
	if err != nil {
		t.Fatalf("NewRecord() error = %v", err)
	}
	return record
}

func bucketQuery(t *testing.T, from, to time.Time) Query {
	t.Helper()
	query := Query{From: from.UTC(), To: to.UTC()}
	if err := query.Validate(); err != nil {
		t.Fatalf("Query.Validate() error = %v", err)
	}
	return query
}

func TestAggregateBucketsUsesUTCDayBoundaries(t *testing.T) {
	from := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	to := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	records := []Record{
		bucketRecord(t, time.Date(2026, 11, 2, 23, 59, 0, 0, time.UTC), 10, 5),
		bucketRecord(t, time.Date(2026, 11, 2, 0, 0, 1, 0, time.UTC), 1, 1),
		bucketRecord(t, time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC), 7, 3),
	}
	buckets := AggregateBuckets(records, bucketQuery(t, from, to), BucketGranularityDay)
	if len(buckets) != 2 {
		t.Fatalf("buckets = %d, want 2", len(buckets))
	}
	if buckets[0].StartMS != time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("首桶起点 = %v", time.UnixMilli(buckets[0].StartMS).UTC())
	}
	if buckets[0].Tokens != 17 || buckets[0].RequestCount != 2 {
		t.Fatalf("首桶 = %+v", buckets[0])
	}
	if buckets[1].Tokens != 10 || buckets[1].RequestCount != 1 {
		t.Fatalf("次桶 = %+v", buckets[1])
	}
}

func TestAggregateBucketsWeekStartsOnMonday(t *testing.T) {
	// 2026-11-02 是周一；周日 11-08 的记录应落在同一个周桶。
	monday := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	sunday := time.Date(2026, 11, 8, 23, 0, 0, 0, time.UTC)
	records := []Record{bucketRecord(t, monday, 1, 1), bucketRecord(t, sunday, 2, 2)}
	buckets := AggregateBuckets(records, bucketQuery(t, monday, sunday), BucketGranularityWeek)
	if len(buckets) != 1 {
		t.Fatalf("buckets = %d, want 1", len(buckets))
	}
	if buckets[0].StartMS != monday.UnixMilli() || buckets[0].Tokens != 6 {
		t.Fatalf("周桶 = %+v", buckets[0])
	}
}

func TestAggregateBucketsRejectsUnknownGranularity(t *testing.T) {
	records := []Record{bucketRecord(t, time.Now().UTC(), 1, 1)}
	if buckets := AggregateBuckets(records, bucketQuery(t, time.Now().Add(-time.Hour).UTC(), time.Now().UTC()), "month"); buckets != nil {
		t.Fatalf("未知粒度应返回 nil，实际 %+v", buckets)
	}
}
