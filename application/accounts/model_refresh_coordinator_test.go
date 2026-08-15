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
	if !coordinator.SupportsModelRefresh("codex") ||
		!coordinator.SupportsModelRefresh("claude") ||
		coordinator.SupportsModelRefresh("grok") ||
		coordinator.SupportsModelRefresh("unknown") {
		t.Fatal("Provider 模型刷新能力与已装配 worker 不一致")
	}
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
	if codexRetry.accountRef != codexFailureRef ||
		codexRetry.startedAt.Sub(firstStart.startedAt) < baseBackoff-10*time.Millisecond {
		t.Fatalf(
			"Codex retry=%#v first=%#v backoff=%s",
			codexRetry,
			firstStart,
			codexRetry.startedAt.Sub(firstStart.startedAt),
		)
	}
}

// TestModelRefreshCoordinatorFreshWorkBypassesRetryBackoff 验证同 Provider
// 新账号首次刷新不会被失败账号的退避窗口阻塞。
func TestModelRefreshCoordinatorFreshWorkBypassesRetryBackoff(t *testing.T) {
	t.Parallel()

	fixedNow := time.Unix(1_800_000_000, 0)
	failureRef := testRefreshAccountRef(t, 14)
	freshRef := testRefreshAccountRef(t, 15)
	started := make(chan refreshInvocation, 3)
	results := make(chan accountapp.ModelRefreshResult, 3)
	var calls int
	var callsMu sync.Mutex
	refresher := &refreshCoordinatorStub{
		execute: func(
			_ context.Context,
			accountRef accountcore.AccountRef,
		) error {
			started <- refreshInvocation{
				accountRef: accountRef,
				startedAt:  time.Now(),
			}
			callsMu.Lock()
			defer callsMu.Unlock()
			calls++
			if accountRef == failureRef && calls == 1 {
				return errors.New("synthetic first refresh failure")
			}
			return nil
		},
	}
	coordinator, err := accountapp.NewModelRefreshCoordinator(
		accountapp.ModelRefreshCoordinatorOptions{
			Catalog:             testCatalog(t),
			Refresher:           refresher,
			ProviderConcurrency: map[string]int{"codex": 1},
			RefreshTimeout:      time.Second,
			BaseBackoff:         time.Hour,
			MaxBackoff:          time.Hour,
			Clock: func() time.Time {
				return fixedNow
			},
			Random: bytes.NewReader(make([]byte, 32)),
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
	if err := coordinator.ScheduleModelRefresh(
		context.Background(),
		failureRef,
		"codex",
	); err != nil {
		t.Fatalf("ScheduleModelRefresh(failure) error = %v", err)
	}
	first := receiveRefreshInvocation(t, started)
	firstResult := receiveRefreshResult(t, results)
	if first.accountRef != failureRef || firstResult.Err == nil {
		t.Fatalf("first=%#v result=%#v", first, firstResult)
	}

	if err := coordinator.ScheduleModelRefresh(
		context.Background(),
		freshRef,
		"codex",
	); err != nil {
		t.Fatalf("ScheduleModelRefresh(fresh) error = %v", err)
	}
	select {
	case next := <-started:
		if next.accountRef != freshRef {
			t.Fatalf("next accountRef = %s, want %s", next.accountRef, freshRef)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("新账号首次刷新被同 Provider 退避阻塞")
	}
}

// TestModelRefreshCoordinatorPreservesFreshFIFOAtTenThousandAccounts 验证
// 万账号批量入队后仍按首次调度顺序执行。
func TestModelRefreshCoordinatorPreservesFreshFIFOAtTenThousandAccounts(
	t *testing.T,
) {
	const accountCount = 10_000

	started := make(chan accountcore.AccountRef, accountCount)
	releaseFirst := make(chan struct{})
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	firstRef := testRefreshAccountRef(t, 1_000)
	refresher := &refreshCoordinatorStub{
		execute: func(
			ctx context.Context,
			accountRef accountcore.AccountRef,
		) error {
			started <- accountRef
			if accountRef != firstRef {
				return nil
			}
			select {
			case <-releaseFirst:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		},
	}
	coordinator := newTestRefreshCoordinator(
		t,
		refresher,
		map[string]int{"codex": 1},
		time.Millisecond,
		nil,
	)
	t.Cleanup(func() {
		_ = coordinator.Close()
	})

	accountRefs := make([]accountcore.AccountRef, accountCount)
	for index := range accountRefs {
		accountRefs[index] = testRefreshAccountRef(t, 1_000+index)
	}
	if err := coordinator.ScheduleModelRefresh(
		context.Background(),
		accountRefs[0],
		"codex",
	); err != nil {
		t.Fatalf("ScheduleModelRefresh(first) error = %v", err)
	}
	if actual := receiveRefreshAccountRef(
		t,
		started,
		deadline.C,
	); actual != accountRefs[0] {
		t.Fatalf("first accountRef = %s, want %s", actual, accountRefs[0])
	}
	for index := 1; index < accountCount; index++ {
		if err := coordinator.ScheduleModelRefresh(
			context.Background(),
			accountRefs[index],
			"codex",
		); err != nil {
			t.Fatalf("ScheduleModelRefresh(%d) error = %v", index, err)
		}
	}
	close(releaseFirst)
	for index := 1; index < accountCount; index++ {
		actual := receiveRefreshAccountRef(t, started, deadline.C)
		if actual != accountRefs[index] {
			t.Fatalf(
				"refresh order[%d] = %s, want %s",
				index,
				actual,
				accountRefs[index],
			)
		}
	}
}

// receiveRefreshAccountRef 在有界时间内等待高数量顺序测试的单个账号。
func receiveRefreshAccountRef(
	t *testing.T,
	started <-chan accountcore.AccountRef,
	deadline <-chan time.Time,
) accountcore.AccountRef {
	t.Helper()

	select {
	case accountRef := <-started:
		return accountRef
	case <-deadline:
		t.Fatal("等待高数量模型刷新启动超时")
		return accountcore.AccountRef("")
	}
}

// TestModelRefreshCoordinatorRetriesFailedAccountAfterBackoff 验证瞬时存储或上游失败
// 不会丢掉账号首次模型物化；同一代次必须在退避后自动重试直至成功。
func TestModelRefreshCoordinatorRetriesFailedAccountAfterBackoff(t *testing.T) {
	t.Parallel()

	accountRef := testRefreshAccountRef(t, 13)
	started := make(chan refreshInvocation, 2)
	results := make(chan accountapp.ModelRefreshResult, 2)
	var calls int
	var callsMu sync.Mutex
	refresher := &refreshCoordinatorStub{
		execute: func(
			_ context.Context,
			actualRef accountcore.AccountRef,
		) error {
			started <- refreshInvocation{
				accountRef: actualRef,
				startedAt:  time.Now(),
			}
			callsMu.Lock()
			defer callsMu.Unlock()
			calls++
			if calls == 1 {
				return errors.New("synthetic transient model refresh failure")
			}
			return nil
		},
	}
	baseBackoff := 40 * time.Millisecond
	coordinator := newTestRefreshCoordinator(
		t,
		refresher,
		map[string]int{"claude": 1},
		baseBackoff,
		func(result accountapp.ModelRefreshResult) {
			results <- result
		},
	)
	t.Cleanup(func() {
		_ = coordinator.Close()
	})
	if err := coordinator.ScheduleModelRefresh(
		context.Background(),
		accountRef,
		"claude",
	); err != nil {
		t.Fatalf("ScheduleModelRefresh() error = %v", err)
	}

	first := receiveRefreshInvocation(t, started)
	firstResult := receiveRefreshResult(t, results)
	if first.accountRef != accountRef || firstResult.Err == nil {
		t.Fatalf("first=%#v result=%#v", first, firstResult)
	}
	second := receiveRefreshInvocation(t, started)
	secondResult := receiveRefreshResult(t, results)
	if second.accountRef != accountRef ||
		second.startedAt.Sub(first.startedAt) < baseBackoff-10*time.Millisecond ||
		secondResult.AccountRef != accountRef ||
		secondResult.Err != nil {
		t.Fatalf(
			"second=%#v delay=%s result=%#v",
			second,
			second.startedAt.Sub(first.startedAt),
			secondResult,
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

// TestModelRefreshCoordinatorForgetAccountIsolatesOldGeneration 验证删除或凭据切换后，
// 旧任务只能结束自己的代次，不能阻塞、清理或观测新任务。
func TestModelRefreshCoordinatorForgetAccountIsolatesOldGeneration(
	t *testing.T,
) {
	accountRef := testRefreshAccountRef(t, 30)
	firstStarted := make(chan struct{})
	firstCanceled := make(chan struct{})
	releaseFirst := make(chan struct{})
	var releaseFirstOnce sync.Once
	secondStarted := make(chan struct{})
	releaseSecond := make(chan struct{})
	var releaseSecondOnce sync.Once
	var calls int
	var callsMu sync.Mutex
	refresher := &refreshCoordinatorStub{
		execute: func(
			ctx context.Context,
			_ accountcore.AccountRef,
		) error {
			callsMu.Lock()
			calls++
			call := calls
			callsMu.Unlock()
			switch call {
			case 1:
				close(firstStarted)
				<-ctx.Done()
				close(firstCanceled)
				<-releaseFirst
				return ctx.Err()
			case 2:
				close(secondStarted)
				<-releaseSecond
				return nil
			default:
				return errors.New("旧任务清除了新任务的合并标记")
			}
		},
	}
	results := make(chan accountapp.ModelRefreshResult, 3)
	coordinator := newTestRefreshCoordinator(
		t,
		refresher,
		map[string]int{"codex": 2},
		10*time.Millisecond,
		func(result accountapp.ModelRefreshResult) {
			results <- result
		},
	)
	t.Cleanup(func() {
		releaseSecondOnce.Do(func() { close(releaseSecond) })
		releaseFirstOnce.Do(func() { close(releaseFirst) })
		_ = coordinator.Close()
	})
	if err := coordinator.ScheduleModelRefresh(
		context.Background(),
		accountRef,
		"codex",
	); err != nil {
		t.Fatalf("ScheduleModelRefresh(first) error = %v", err)
	}
	select {
	case <-firstStarted:
	case <-time.After(time.Second):
		t.Fatal("等待旧模型刷新启动超时")
	}

	coordinator.ForgetAccount(accountRef)
	select {
	case <-firstCanceled:
	case <-time.After(time.Second):
		t.Fatal("ForgetAccount() 没有取消旧模型刷新")
	}
	if err := coordinator.ScheduleModelRefresh(
		context.Background(),
		accountRef,
		"codex",
	); err != nil {
		t.Fatalf("ScheduleModelRefresh(second) error = %v", err)
	}
	select {
	case <-secondStarted:
	case <-time.After(time.Second):
		t.Fatal("新代次模型刷新被旧任务占用阻塞")
	}

	releaseFirstOnce.Do(func() { close(releaseFirst) })
	select {
	case result := <-results:
		t.Fatalf("旧代次产生了观察结果: %#v", result)
	case <-time.After(20 * time.Millisecond):
	}
	if err := coordinator.ScheduleModelRefresh(
		context.Background(),
		accountRef,
		"codex",
	); err != nil {
		t.Fatalf("ScheduleModelRefresh(coalesced second) error = %v", err)
	}
	releaseSecondOnce.Do(func() { close(releaseSecond) })
	result := receiveRefreshResult(t, results)
	if result.AccountRef != accountRef || result.Err != nil {
		t.Fatalf("new generation result = %#v", result)
	}
	time.Sleep(20 * time.Millisecond)
	callsMu.Lock()
	defer callsMu.Unlock()
	if calls != 2 {
		t.Fatalf("RefreshAccountModels() calls = %d, want 2", calls)
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
