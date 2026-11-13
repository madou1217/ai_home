package accountoutcomes

import (
	"context"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

type memoryStore struct {
	deltas []Delta
	rows   []Bucket
}

func (m *memoryStore) AddAccountOutcomes(_ context.Context, deltas []Delta) error {
	m.deltas = append(m.deltas, deltas...)
	return nil
}

func (m *memoryStore) ListAccountOutcomes(_ context.Context, _ Granularity, _ int64) ([]Bucket, error) {
	return append([]Bucket(nil), m.rows...), nil
}

func (m *memoryStore) PruneAccountOutcomes(_ context.Context, _ Granularity, _ int64) error {
	return nil
}

func TestRecorderRecordAtUsesBucketAndPreservesNewestActivity(t *testing.T) {
	t.Parallel()

	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef: %v", err)
	}
	loc := time.FixedZone("CST", 8*3600)
	now := time.Date(2026, 11, 13, 14, 30, 0, 0, loc)
	older := now.Add(-2 * time.Hour)

	store := &memoryStore{}
	recorder, err := NewRecorder(RecorderOptions{
		Store:         store,
		Clock:         func() time.Time { return now },
		FlushInterval: time.Second,
		Location:      loc,
	})
	if err != nil {
		t.Fatalf("NewRecorder: %v", err)
	}

	recorder.RecordAt(ref, OutcomeSuccess, now)
	recorder.RecordAt(ref, OutcomeSuccess, older)
	recorder.RecordAt(ref, "rate_limited", older)
	recorder.RecordAt(ref, "upstream_error", now)

	snap := recorder.LastActivity()
	act := snap[ref]
	if !act.LastSuccessAt.Equal(now) {
		t.Fatalf("LastSuccessAt = %v, want %v", act.LastSuccessAt, now)
	}
	if !act.LastFailureAt.Equal(now) || act.LastFailureKind != "upstream_error" {
		t.Fatalf("LastFailure = (%v, %q), want (%v, upstream_error)", act.LastFailureAt, act.LastFailureKind, now)
	}

	if err := recorder.Flush(context.Background()); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if len(store.deltas) != 7 {
		t.Fatalf("len(deltas) = %d, want 7", len(store.deltas))
	}
}
