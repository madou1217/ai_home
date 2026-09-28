package accountoutcomes

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

type memoryStore struct {
	mu     sync.Mutex
	deltas []Delta
	fail   bool
}

func (store *memoryStore) AddAccountOutcomes(_ context.Context, deltas []Delta) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.fail {
		return errors.New("synthetic write failure")
	}
	store.deltas = append(store.deltas, deltas...)
	return nil
}

func (store *memoryStore) ListAccountOutcomes(context.Context, Granularity, int64) ([]Bucket, error) {
	return nil, nil
}

func (store *memoryStore) PruneAccountOutcomes(context.Context, Granularity, int64) error { return nil }

// TestRecorderAggregatesIntoDayAndHourBucketsAndKeepsFailedFlushes 验证同一时刻的结果同时
// 计入本地日桶与小时桶，写入失败的计数不会丢失。
func TestRecorderAggregatesIntoDayAndHourBucketsAndKeepsFailedFlushes(t *testing.T) {
	t.Parallel()

	location := time.FixedZone("UTC+8", 8*3600)
	now := time.Date(2026, 9, 28, 17, 45, 0, 0, location)
	store := &memoryStore{fail: true}
	recorder, err := NewRecorder(RecorderOptions{
		Store:         store,
		Clock:         func() time.Time { return now },
		FlushInterval: time.Hour,
		Location:      location,
	})
	if err != nil {
		t.Fatalf("NewRecorder() error = %v", err)
	}
	ref, _ := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	recorder.Record(ref, OutcomeSuccess)
	recorder.Record(ref, OutcomeSuccess)
	recorder.Record(ref, "rate_limited")
	recorder.Record("", OutcomeSuccess)
	if err := recorder.Flush(context.Background()); err == nil {
		t.Fatal("flush error was swallowed")
	}
	store.fail = false
	if err := recorder.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	dayStart := time.Date(2026, 9, 28, 0, 0, 0, 0, location).UnixMilli()
	hourStart := time.Date(2026, 9, 28, 17, 0, 0, 0, location).UnixMilli()
	got := map[[3]string]int64{}
	for _, delta := range store.deltas {
		got[[3]string{string(delta.Granularity), time.UnixMilli(delta.BucketStartMS).String(), delta.Outcome}] = delta.Count
	}
	for _, want := range []struct {
		granularity Granularity
		bucket      int64
		outcome     string
		count       int64
	}{
		{Day, dayStart, OutcomeSuccess, 2},
		{Day, dayStart, "rate_limited", 1},
		{Hour, hourStart, OutcomeSuccess, 2},
		{Hour, hourStart, "rate_limited", 1},
	} {
		key := [3]string{string(want.granularity), time.UnixMilli(want.bucket).String(), want.outcome}
		if got[key] != want.count {
			t.Fatalf("count %v = %d, want %d (all=%v)", key, got[key], want.count, got)
		}
	}
	if len(store.deltas) != 4 {
		t.Fatalf("deltas = %d, want 4 (invalid account ignored)", len(store.deltas))
	}
}
