package persistent

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestResolveReapPolicy(t *testing.T) {
	p := ResolveReapPolicy(func(string) string { return "" })
	if !p.Enabled || p.IdleTTLMinutes != 1440 || p.IdleTTL != 24*time.Hour || p.MaxIdle != 10 {
		t.Fatalf("default policy = %+v", p)
	}

	env := map[string]string{
		"AIH_SESSION_REAP":             "0",
		"AIH_SESSION_IDLE_TTL_MINUTES": "120",
		"AIH_SESSION_MAX_IDLE":         "0",
	}
	p2 := ResolveReapPolicy(func(k string) string { return env[k] })
	if p2.Enabled || p2.IdleTTLMinutes != 120 || p2.MaxIdle != 0 {
		t.Fatalf("custom policy = %+v", p2)
	}

	envBad := map[string]string{
		"AIH_SESSION_IDLE_TTL_MINUTES": "-5",
		"AIH_SESSION_MAX_IDLE":         "abc",
	}
	p3 := ResolveReapPolicy(func(k string) string { return envBad[k] })
	if p3.IdleTTLMinutes != 1440 || p3.MaxIdle != 10 {
		t.Fatalf("invalid env fallback = %+v", p3)
	}
}

func TestSessionLastActiveAtNormalization(t *testing.T) {
	if got := SessionLastActiveAt(SessionRow{CreatedAtMS: 1700000000}); got != 1700000000000 {
		t.Fatalf("seconds normalized created = %d, want 1700000000000", got)
	}
	if got := SessionLastActiveAt(SessionRow{
		CreatedAtMS:      1700000000,
		LastActivityAtMS: 1700001000000,
		LastActiveAtMS:   1700002000000,
	}); got != 1700002000000 {
		t.Fatalf("max activity = %d, want 1700002000000", got)
	}
}

func TestPlanIdleSessionReapTTLAndLRUEviction(t *testing.T) {
	now := time.UnixMilli(2_000_000_000_000).UTC()
	hour := int64(time.Hour.Milliseconds())
	policy := ReapPolicy{
		Enabled:        true,
		IdleTTLMinutes: 1440,
		IdleTTL:        24 * time.Hour,
		MaxIdle:        2,
	}

	rows := []SessionRow{
		{Name: "attached-ancient", Live: true, LastActiveAtMS: now.UnixMilli() - 100*hour},
		{Name: "expired-ttl", Live: false, LastActiveAtMS: now.UnixMilli() - 25*hour},
		{Name: "unknown-zero", Live: false, LastActiveAtMS: 0},
		{Name: "older-lru", Live: false, LastActiveAtMS: now.UnixMilli() - 10*hour},
		{Name: "newest-1", Live: false, LastActiveAtMS: now.UnixMilli() - 2*hour},
		{Name: "newest-2", Live: false, LastActiveAtMS: now.UnixMilli() - 1*hour},
	}

	plan := PlanIdleSessionReap(rows, now, policy)
	if len(plan.Expired) != 1 || plan.Expired[0].Row.Name != "expired-ttl" {
		t.Fatalf("Expired = %+v", plan.Expired)
	}
	if len(plan.Evicted) != 2 || plan.Evicted[0].Row.Name != "unknown-zero" || plan.Evicted[1].Row.Name != "older-lru" {
		t.Fatalf("Evicted = %+v, want [unknown-zero older-lru]", plan.Evicted)
	}
	if len(plan.Kept) != 3 {
		t.Fatalf("Kept = %+v, want 3 entries", plan.Kept)
	}

	// MaxIdle == 0 不按上限淘汰。
	policyNoLRU := policy
	policyNoLRU.MaxIdle = 0
	planNoLRU := PlanIdleSessionReap(rows, now, policyNoLRU)
	if len(planNoLRU.Evicted) != 0 || len(planNoLRU.Expired) != 1 {
		t.Fatalf("MaxIdle=0 plan = %+v", planNoLRU)
	}
}

type stubCloser struct {
	failNames map[string]bool
	closed    []string
}

func (s *stubCloser) CloseSession(_ context.Context, row SessionRow) error {
	if s.failNames[row.Name] {
		return errors.New("kill failed")
	}
	s.closed = append(s.closed, row.Name)
	return nil
}

func TestReapIdleSessionsAndDescribeReapResult(t *testing.T) {
	now := time.UnixMilli(2_000_000_000_000).UTC()
	hour := int64(time.Hour.Milliseconds())
	policy := ReapPolicy{
		Enabled:        true,
		IdleTTLMinutes: 1440,
		IdleTTL:        24 * time.Hour,
		MaxIdle:        1,
	}
	rows := []SessionRow{
		{Name: "exp-1", LastActiveAtMS: now.UnixMilli() - 30*hour},
		{Name: "lru-1", LastActiveAtMS: now.UnixMilli() - 5*hour},
		{Name: "fail-1", LastActiveAtMS: now.UnixMilli() - 6*hour},
		{Name: "keep-1", LastActiveAtMS: now.UnixMilli() - hour},
	}
	closer := &stubCloser{failNames: map[string]bool{"fail-1": true}}
	res := ReapIdleSessions(context.Background(), rows, ReapOptions{
		Now:    func() time.Time { return now },
		Policy: &policy,
		Closer: closer,
	})
	if res.Closed != 2 || res.Failed != 1 || len(res.Expired) != 1 || len(res.Evicted) != 2 {
		t.Fatalf("res = %+v", res)
	}
	desc := DescribeReapResult(res)
	want := "已回收 2 个空闲会话（空闲超 1 天 1 个，超出 1 个空闲上限 2 个），1 个失败"
	if desc != want {
		t.Fatalf("DescribeReapResult() = %q, want %q", desc, want)
	}
	if empty := DescribeReapResult(ReapResult{}); empty != "" {
		t.Fatalf("empty DescribeReapResult = %q", empty)
	}
}
