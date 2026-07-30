package accounts_test

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestModelRefreshCoordinatorCoalescesAccountsAndIsolatesProviders 验证同账号合并和 Provider 队列隔离。
func TestModelRefreshCoordinatorCoalescesAccountsAndIsolatesProviders(
	t *testing.T,
) {
	t.Parallel()

	started := make(chan refreshInvocation, 4)
	release := make(chan struct{})
	refresher := &refreshCoordinatorStub{
		execute: func(
			_ context.Context,
			accountRef accountcore.AccountRef,
		) error {
			started <- refreshInvocation{
				accountRef: accountRef,
				startedAt:  time.Now(),
			}
			<-release
			return nil
		},
	}
	results := make(chan accountapp.ModelRefreshResult, 4)
	coordinator := newTestRefreshCoordinator(
		t,
		refresher,
		map[string]int{"codex": 1, "claude": 1},
		10*time.Millisecond,
		func(result accountapp.ModelRefreshResult) {
			results <- result
		},
	)
	t.Cleanup(func() {
		_ = coordinator.Close()
	})
	codexFirst := testRefreshAccountRef(t, 1)
	codexSecond := testRefreshAccountRef(t, 2)
	claudeFirst := testRefreshAccountRef(t, 3)
	for range 100 {
		if err := coordinator.ScheduleModelRefresh(
			context.Background(),
			codexFirst,
			"codex",
		); err != nil {
			t.Fatalf("ScheduleModelRefresh(coalesced) error = %v", err)
		}
	}
	if err := coordinator.ScheduleModelRefresh(
		context.Background(),
		codexSecond,
		"codex",
	); err != nil {
		t.Fatalf("ScheduleModelRefresh(codex second) error = %v", err)
	}
	if err := coordinator.ScheduleModelRefresh(
		context.Background(),
		claudeFirst,
		"claude",
	); err != nil {
		t.Fatalf("ScheduleModelRefresh(claude) error = %v", err)
	}

	firstTwo := map[accountcore.AccountRef]bool{}
	for range 2 {
		invocation := receiveRefreshInvocation(t, started)
		firstTwo[invocation.accountRef] = true
	}
	if !firstTwo[codexFirst] ||
		!firstTwo[claudeFirst] ||
		firstTwo[codexSecond] {
		t.Fatalf("first provider-isolated starts = %#v", firstTwo)
	}
	select {
	case invocation := <-started:
		t.Fatalf("同 Provider 并发越界: %#v", invocation)
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	third := receiveRefreshInvocation(t, started)
	if third.accountRef != codexSecond {
		t.Fatalf("third invocation = %#v, want codex second", third)
	}
	observed := make(map[accountcore.AccountRef]int)
	for range 3 {
		result := receiveRefreshResult(t, results)
		if result.Err != nil {
			t.Fatalf("refresh result error = %v", result.Err)
		}
		observed[result.AccountRef]++
	}
	if observed[codexFirst] != 1 ||
		observed[codexSecond] != 1 ||
		observed[claudeFirst] != 1 {
		t.Fatalf("refresh counts = %#v", observed)
	}
}

// TestModelRefreshCoordinatorBacksOffOnlyFailingProvider 验证失败退避不会阻塞兄弟 Provider。
func TestModelRefreshCoordinatorBacksOffOnlyFailingProvider(t *testing.T) {
	t.Parallel()

	var mu sync.Mutex
	codexCalls := 0
	started := make(chan refreshInvocation, 4)
	codexFailureRef := testRefreshAccountRef(t, 10)
	refresher := &refreshCoordinatorStub{
		execute: func(
			_ context.Context,
			accountRef accountcore.AccountRef,
		) error {
			invocation := refreshInvocation{
				accountRef: accountRef,
				startedAt:  time.Now(),
			}
			started <- invocation
			mu.Lock()
			defer mu.Unlock()
			if accountRef == codexFailureRef {
				codexCalls++
				if codexCalls == 1 {
					return errors.New("synthetic catalog failure")
				}
			}
			return nil
		},
	}
	results := make(chan accountapp.ModelRefreshResult, 4)
	baseBackoff := 60 * time.Millisecond
	coordinator := newTestRefreshCoordinator(
		t,
		refresher,
		map[string]int{"codex": 1, "claude": 1},
		baseBackoff,
		func(result accountapp.ModelRefreshResult) {
			results <- result
		},
	)
	t.Cleanup(func() {
		_ = coordinator.Close()
	})
	codexFirst := codexFailureRef
	codexSecond := testRefreshAccountRef(t, 11)
	claudeFirst := testRefreshAccountRef(t, 12)
	if err := coordinator.ScheduleModelRefresh(
		context.Background(),
		codexFirst,
		"codex",
	); err != nil {
		t.Fatalf("ScheduleModelRefresh(first) error = %v", err)
	}
	firstStart := receiveRefreshInvocation(t, started)
	firstResult := receiveRefreshResult(t, results)
	if firstResult.Err == nil {
		t.Fatal("首个 Codex 刷新没有产生测试失败")
	}
	if err := coordinator.ScheduleModelRefresh(
		context.Background(),
		codexSecond,
		"codex",
	); err != nil {
		t.Fatalf("ScheduleModelRefresh(second) error = %v", err)
	}
	if err := coordinator.ScheduleModelRefresh(
		context.Background(),
		claudeFirst,
		"claude",
	); err != nil {
		t.Fatalf("ScheduleModelRefresh(claude) error = %v", err)
	}
	next := receiveRefreshInvocation(t, started)
	if next.accountRef != claudeFirst {
		t.Fatalf("退避期间先启动了错误任务: %#v", next)
	}
	codexRetry := receiveRefreshInvocation(t, started)
	if codexRetry.accountRef != codexSecond ||
		codexRetry.startedAt.Sub(firstStart.startedAt) < baseBackoff-10*time.Millisecond {
		t.Fatalf(
			"Codex retry=%#v first=%#v backoff=%s",
			codexRetry,
			firstStart,
			codexRetry.startedAt.Sub(firstStart.startedAt),
		)
	}
}

// TestModelRefreshCoordinatorTimesOutAndRejectsAfterClose 验证单任务超时和关闭边界。
func TestModelRefreshCoordinatorTimesOutAndRejectsAfterClose(t *testing.T) {
	t.Parallel()

	started := make(chan struct{})
	refresher := &refreshCoordinatorStub{
		execute: func(
			ctx context.Context,
			_ accountcore.AccountRef,
		) error {
			close(started)
			<-ctx.Done()
			return ctx.Err()
		},
	}
	results := make(chan accountapp.ModelRefreshResult, 1)
	coordinator, err := accountapp.NewModelRefreshCoordinator(
		accountapp.ModelRefreshCoordinatorOptions{
			Catalog:             testCatalog(t),
			Refresher:           refresher,
			ProviderConcurrency: map[string]int{"codex": 1},
			RefreshTimeout:      30 * time.Millisecond,
			BaseBackoff:         time.Millisecond,
			MaxBackoff:          time.Second,
			Clock:               time.Now,
			Random:              bytes.NewReader(make([]byte, 32)),
			Observer: func(result accountapp.ModelRefreshResult) {
				results <- result
			},
		},
	)
	if err != nil {
		t.Fatalf("NewModelRefreshCoordinator() error = %v", err)
	}
	t.Cleanup(func() {
		_ = coordinator.Close()
	})
	accountRef := testRefreshAccountRef(t, 20)
	if err := coordinator.ScheduleModelRefresh(
		context.Background(),
		accountRef,
		"codex",
	); err != nil {
		t.Fatalf("ScheduleModelRefresh() error = %v", err)
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("等待超时刷新任务启动失败")
	}
	result := receiveRefreshResult(t, results)
	if result.AccountRef != accountRef ||
		!errors.Is(result.Err, context.DeadlineExceeded) {
		t.Fatalf("timeout result = %#v", result)
	}
	if err := coordinator.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if err := coordinator.ScheduleModelRefresh(
		context.Background(),
		accountRef,
		"codex",
	); !errors.Is(err, accountapp.ErrModelRefreshCoordinatorClosed) {
		t.Fatalf("closed ScheduleModelRefresh() error = %v", err)
	}
}

// refreshInvocation 保存测试观察到的账号和启动时间。
type refreshInvocation struct {
	accountRef accountcore.AccountRef
	startedAt  time.Time
}

// refreshCoordinatorStub 以函数实现单账号刷新端口。
type refreshCoordinatorStub struct {
	execute func(context.Context, accountcore.AccountRef) error
}

func (stub *refreshCoordinatorStub) RefreshAccountModels(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) ([]accountapp.AccountModel, error) {
	return nil, stub.execute(ctx, accountRef)
}

// newTestRefreshCoordinator 创建使用零抖动随机源的测试协调器。
func newTestRefreshCoordinator(
	t *testing.T,
	refresher accountapp.AccountModelRefresher,
	concurrency map[string]int,
	baseBackoff time.Duration,
	observer accountapp.ModelRefreshObserver,
) *accountapp.ModelRefreshCoordinator {
	t.Helper()

	coordinator, err := accountapp.NewModelRefreshCoordinator(
		accountapp.ModelRefreshCoordinatorOptions{
			Catalog:             testCatalog(t),
			Refresher:           refresher,
			ProviderConcurrency: concurrency,
			RefreshTimeout:      time.Second,
			BaseBackoff:         baseBackoff,
			MaxBackoff:          time.Second,
			Clock:               time.Now,
			Random:              bytes.NewReader(make([]byte, 1024)),
			Observer:            observer,
		},
	)
	if err != nil {
		t.Fatalf("NewModelRefreshCoordinator() error = %v", err)
	}
	return coordinator
}

// testRefreshAccountRef 创建可排序的稳定测试账号身份。
func testRefreshAccountRef(
	t *testing.T,
	value int,
) accountcore.AccountRef {
	t.Helper()

	accountRef, err := accountcore.ParseAccountRef(
		"acct_" + formatRefreshRef(value),
	)
	if err != nil {
		t.Fatalf("ParseAccountRef(%d) error = %v", value, err)
	}
	return accountRef
}

// formatRefreshRef 把小整数编码为 AccountRef 所需的二十位十六进制。
func formatRefreshRef(value int) string {
	const digits = "0123456789abcdef"
	var buffer [20]byte
	for index := len(buffer) - 1; index >= 0; index-- {
		buffer[index] = digits[value&15]
		value >>= 4
	}
	return string(buffer[:])
}

// receiveRefreshInvocation 在有界时间内等待 worker 启动事实。
func receiveRefreshInvocation(
	t *testing.T,
	started <-chan refreshInvocation,
) refreshInvocation {
	t.Helper()

	select {
	case invocation := <-started:
		return invocation
	case <-time.After(time.Second):
		t.Fatal("等待模型刷新启动超时")
		return refreshInvocation{}
	}
}

// receiveRefreshResult 在有界时间内等待刷新观察结果。
func receiveRefreshResult(
	t *testing.T,
	results <-chan accountapp.ModelRefreshResult,
) accountapp.ModelRefreshResult {
	t.Helper()

	select {
	case result := <-results:
		return result
	case <-time.After(time.Second):
		t.Fatal("等待模型刷新结果超时")
		return accountapp.ModelRefreshResult{}
	}
}
