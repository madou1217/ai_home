package accounts

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"
)

// TestModelRefreshSweepPagesAndFiltersProvider 验证重扫按固定页大小遍历，并把
// Provider 过滤传给持久化层。
func TestModelRefreshSweepPagesAndFiltersProvider(t *testing.T) {
	t.Parallel()

	catalog := initialModelRefreshTestCatalog(t)
	candidates := make([]ModelRefreshSweepCandidate, 0, 257)
	for index := 1; index <= 257; index++ {
		candidates = append(candidates, newInitialModelRefreshTestCandidate(t, catalog, index, "codex"))
	}
	reader := &modelRefreshSweepReaderStub{candidates: candidates}
	scheduler := &initialModelRefreshSchedulerStub{}
	sweep, err := NewModelRefreshSweep(catalog, reader, scheduler)
	if err != nil {
		t.Fatalf("NewModelRefreshSweep() error = %v", err)
	}
	if err := sweep.SweepProvider(context.Background(), "codex"); err != nil {
		t.Fatalf("SweepProvider() error = %v", err)
	}
	if len(reader.queries) != 2 ||
		reader.queries[0].ProviderID() != "codex" ||
		reader.queries[1].AfterRef() != candidates[255].AccountRef() {
		t.Fatalf("重扫查询 = %#v", reader.queries)
	}
	if len(scheduler.candidates) != len(candidates) {
		t.Fatalf("调度数量 = %d, want %d", len(scheduler.candidates), len(candidates))
	}
}

// TestModelRefreshSweepRejectsCrossProviderPage 验证持久化层不能越过 Provider 过滤。
func TestModelRefreshSweepRejectsCrossProviderPage(t *testing.T) {
	t.Parallel()

	catalog := initialModelRefreshTestCatalog(t)
	reader := &modelRefreshSweepReaderStub{candidates: []ModelRefreshSweepCandidate{
		newInitialModelRefreshTestCandidate(t, catalog, 1, "claude"),
	}}
	sweep, err := NewModelRefreshSweep(catalog, reader, &initialModelRefreshSchedulerStub{})
	if err != nil {
		t.Fatalf("NewModelRefreshSweep() error = %v", err)
	}
	if err := sweep.SweepProvider(context.Background(), "codex"); !errors.Is(err, ErrInvalidModelRefreshSweepCandidate) {
		t.Fatalf("SweepProvider() error = %v, want ErrInvalidModelRefreshSweepCandidate", err)
	}
	if err := sweep.SweepProvider(context.Background(), "not-a-provider"); !errors.Is(err, ErrInvalidModelRefreshSweepQuery) {
		t.Fatalf("SweepProvider(unknown) error = %v, want ErrInvalidModelRefreshSweepQuery", err)
	}
}

// TestModelRefreshSweepSkipsUnsupportedProvider 验证未装配刷新能力的 Provider 不查询。
func TestModelRefreshSweepSkipsUnsupportedProvider(t *testing.T) {
	t.Parallel()

	catalog := initialModelRefreshTestCatalog(t)
	reader := &modelRefreshSweepReaderStub{}
	scheduler := &initialModelRefreshSchedulerStub{
		unsupportedProviders: map[string]struct{}{"claude": {}},
	}
	sweep, err := NewModelRefreshSweep(catalog, reader, scheduler)
	if err != nil {
		t.Fatalf("NewModelRefreshSweep() error = %v", err)
	}
	if err := sweep.SweepProvider(context.Background(), "claude"); err != nil {
		t.Fatalf("SweepProvider() error = %v", err)
	}
	if len(reader.queries) != 0 {
		t.Fatalf("未装配 Provider 仍查询: %#v", reader.queries)
	}
}

// TestRouteMissModelRefreshThrottlesPerProvider 验证同 Provider 节流窗口内只重扫一次，
// 不同 Provider 互不影响，窗口过后可再次触发。
func TestRouteMissModelRefreshThrottlesPerProvider(t *testing.T) {
	t.Parallel()

	now := time.Unix(1_790_000_000, 0)
	var clockMu sync.Mutex
	clock := func() time.Time {
		clockMu.Lock()
		defer clockMu.Unlock()
		return now
	}
	sweeper := &providerSweeperStub{}
	refresh, err := NewRouteMissModelRefresh(RouteMissModelRefreshOptions{
		Sweeper:      sweeper,
		MinInterval:  5 * time.Minute,
		SweepTimeout: time.Second,
		Clock:        clock,
	})
	if err != nil {
		t.Fatalf("NewRouteMissModelRefresh() error = %v", err)
	}
	refresh.ReportRouteMiss("codex")
	refresh.ReportRouteMiss("codex")
	refresh.ReportRouteMiss("claude")
	refresh.running.Wait()
	if got := sweeper.snapshot(); len(got) != 2 {
		t.Fatalf("节流窗口内重扫 = %v, want codex+claude 各一次", got)
	}

	clockMu.Lock()
	now = now.Add(5 * time.Minute)
	clockMu.Unlock()
	refresh.ReportRouteMiss("codex")
	if err := refresh.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if got := sweeper.snapshot(); len(got) != 3 || got[2] != "codex" {
		t.Fatalf("窗口过后重扫 = %v", got)
	}
	refresh.ReportRouteMiss("agy")
	if got := sweeper.snapshot(); len(got) != 3 {
		t.Fatalf("关闭后仍重扫: %v", got)
	}
}

// TestRouteMissModelRefreshReportsSweepFailure 验证重扫失败交给观察端口而不是调用方。
func TestRouteMissModelRefreshReportsSweepFailure(t *testing.T) {
	t.Parallel()

	failure := errors.New("synthetic sweep failure")
	observed := make(chan error, 1)
	refresh, err := NewRouteMissModelRefresh(RouteMissModelRefreshOptions{
		Sweeper:      &providerSweeperStub{err: failure},
		MinInterval:  time.Minute,
		SweepTimeout: time.Second,
		Clock:        time.Now,
		Observer: func(providerID string, err error) {
			if providerID == "codex" {
				observed <- err
			}
		},
	})
	if err != nil {
		t.Fatalf("NewRouteMissModelRefresh() error = %v", err)
	}
	refresh.ReportRouteMiss("codex")
	if err := <-observed; !errors.Is(err, failure) {
		t.Fatalf("观察到的错误 = %v", err)
	}
	_ = refresh.Close()
}

type modelRefreshSweepReaderStub struct {
	candidates []ModelRefreshSweepCandidate
	queries    []ModelRefreshSweepQuery
}

func (reader *modelRefreshSweepReaderStub) ListModelRefreshSweepCandidates(
	_ context.Context,
	query ModelRefreshSweepQuery,
) ([]ModelRefreshSweepCandidate, error) {
	reader.queries = append(reader.queries, query)
	start := 0
	for index, candidate := range reader.candidates {
		if candidate.AccountRef() > query.AfterRef() {
			start = index
			break
		}
		start = len(reader.candidates)
	}
	end := min(start+query.Limit(), len(reader.candidates))
	return append([]ModelRefreshSweepCandidate(nil), reader.candidates[start:end]...), nil
}

type providerSweeperStub struct {
	mu    sync.Mutex
	calls []string
	err   error
}

func (sweeper *providerSweeperStub) SweepProvider(_ context.Context, providerID string) error {
	sweeper.mu.Lock()
	defer sweeper.mu.Unlock()
	sweeper.calls = append(sweeper.calls, providerID)
	return sweeper.err
}

func (sweeper *providerSweeperStub) snapshot() []string {
	sweeper.mu.Lock()
	defer sweeper.mu.Unlock()
	return append([]string(nil), sweeper.calls...)
}
