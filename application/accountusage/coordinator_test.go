package accountusage_test

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

// TestCoordinatorCoalescesAccountsAndIsolatesProviders 验证同账号唯一任务和 Provider 独立 worker。
func TestCoordinatorCoalescesAccountsAndIsolatesProviders(t *testing.T) {
	t.Parallel()

	codexRef := coordinatorAccountRef(t, 1)
	claudeRef := coordinatorAccountRef(t, 2)
	started := make(chan accountcore.AccountRef, 4)
	release := make(chan struct{})
	refresher := &coordinatorRefresher{
		execute: func(accountRef accountcore.AccountRef) error {
			started <- accountRef
			<-release
			return nil
		},
	}
	results := make(chan usageapp.RefreshResult, 4)
	coordinator := newCoordinatorSubject(
		t,
		refresher,
		time.Hour,
		func(result usageapp.RefreshResult) {
			results <- result
		},
	)
	t.Cleanup(func() {
		_ = coordinator.Close()
	})
	if err := coordinator.ScheduleUsageRefresh(
		context.Background(),
		codexRef,
		"codex",
	); err != nil {
		t.Fatalf("ScheduleUsageRefresh(codex) error = %v", err)
	}
	if err := coordinator.ScheduleUsageRefresh(
		context.Background(),
		claudeRef,
		"claude",
	); err != nil {
		t.Fatalf("ScheduleUsageRefresh(claude) error = %v", err)
	}
	first := receiveCoordinatorRef(t, started)
	second := receiveCoordinatorRef(t, started)
	if first == second ||
		(first != codexRef && second != codexRef) ||
		(first != claudeRef && second != claudeRef) {
		t.Fatalf("provider-isolated starts = (%s, %s)", first, second)
	}
	for range 100 {
		if err := coordinator.ScheduleUsageRefresh(
			context.Background(),
			codexRef,
			"codex",
		); err != nil {
			t.Fatalf("ScheduleUsageRefresh(codex rerun) error = %v", err)
		}
	}
	select {
	case unexpected := <-started:
		t.Fatalf("同账号重复进入 Provider 队列: %s", unexpected)
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	rerun := receiveCoordinatorRef(t, started)
	if rerun != codexRef {
		t.Fatalf("合并后的 rerun account = %s, want %s", rerun, codexRef)
	}
	for range 3 {
		select {
		case result := <-results:
			if result.Err != nil {
				t.Fatalf("refresh result = %#v", result)
			}
		case <-time.After(time.Second):
			t.Fatal("等待刷新结果超时")
		}
	}
	if refresher.calls.Load() != 3 {
		t.Fatalf("RefreshUsage() calls = %d, want 3", refresher.calls.Load())
	}
}

// TestCoordinatorStopsPollingUnsupportedCredential 验证 API Key unsupported 不会形成后台重试风暴。
func TestCoordinatorStopsPollingUnsupportedCredential(t *testing.T) {
	t.Parallel()

	refresher := &coordinatorRefresher{
		execute: func(accountcore.AccountRef) error {
			return usageapp.ErrUsageUnsupported
		},
	}
	results := make(chan usageapp.RefreshResult, 1)
	coordinator := newCoordinatorSubject(
		t,
		refresher,
		30*time.Millisecond,
		func(result usageapp.RefreshResult) {
			results <- result
		},
	)
	t.Cleanup(func() {
		_ = coordinator.Close()
	})
	accountRef := coordinatorAccountRef(t, 3)
	if err := coordinator.ScheduleUsageRefresh(
		context.Background(),
		accountRef,
		"codex",
	); err != nil {
		t.Fatalf("ScheduleUsageRefresh() error = %v", err)
	}
	select {
	case result := <-results:
		if result.Err != usageapp.ErrUsageUnsupported {
			t.Fatalf("result = %#v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("等待 unsupported 结果超时")
	}
	time.Sleep(80 * time.Millisecond)
	if refresher.calls.Load() != 1 {
		t.Fatalf("unsupported calls = %d, want 1", refresher.calls.Load())
	}
}

// TestCoordinatorSafelyClosesDuringConcurrentSchedules 验证关闭与高并发调度没有竞态或非法状态。
func TestCoordinatorSafelyClosesDuringConcurrentSchedules(t *testing.T) {
	t.Parallel()

	refresher := &coordinatorRefresher{
		execute: func(accountcore.AccountRef) error {
			return nil
		},
	}
	coordinator := newCoordinatorSubject(
		t,
		refresher,
		time.Hour,
		nil,
	)
	accountRef := coordinatorAccountRef(t, 4)
	start := make(chan struct{})
	errorsFound := make(chan error, 16)
	var schedulers sync.WaitGroup
	for range 16 {
		schedulers.Add(1)
		go func() {
			defer schedulers.Done()
			<-start
			for range 100 {
				err := coordinator.ScheduleUsageRefresh(
					context.Background(),
					accountRef,
					"codex",
				)
				if err != nil &&
					!errors.Is(err, usageapp.ErrCoordinatorClosed) {
					errorsFound <- err
					return
				}
			}
		}()
	}
	close(start)
	if err := coordinator.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	schedulers.Wait()
	close(errorsFound)
	for err := range errorsFound {
		t.Fatalf("concurrent ScheduleUsageRefresh() error = %v", err)
	}
	if err := coordinator.ScheduleUsageRefresh(
		context.Background(),
		accountRef,
		"codex",
	); !errors.Is(err, usageapp.ErrCoordinatorClosed) {
		t.Fatalf("ScheduleUsageRefresh(after close) error = %v", err)
	}
}

// TestCoordinatorForgetAccountCancelsOldGenerationAndAllowsReschedule 验证删除中的旧任务不会污染重导入任务。
func TestCoordinatorForgetAccountCancelsOldGenerationAndAllowsReschedule(
	t *testing.T,
) {
	t.Parallel()

	accountRef := coordinatorAccountRef(t, 5)
	firstStarted := make(chan struct{})
	firstCanceled := make(chan struct{})
	secondStarted := make(chan struct{})
	refresher := &generationAwareRefresher{
		firstStarted:  firstStarted,
		firstCanceled: firstCanceled,
		secondStarted: secondStarted,
	}
	coordinator := newCoordinatorSubject(
		t,
		refresher,
		time.Hour,
		nil,
	)
	t.Cleanup(func() {
		_ = coordinator.Close()
	})
	if err := coordinator.ScheduleUsageRefresh(
		context.Background(),
		accountRef,
		"codex",
	); err != nil {
		t.Fatalf("ScheduleUsageRefresh(first) error = %v", err)
	}
	select {
	case <-firstStarted:
	case <-time.After(time.Second):
		t.Fatal("等待旧任务启动超时")
	}

	coordinator.ForgetAccount(accountRef)
	select {
	case <-firstCanceled:
	case <-time.After(time.Second):
		t.Fatal("删除没有取消正在运行的旧任务")
	}
	if err := coordinator.ScheduleUsageRefresh(
		context.Background(),
		accountRef,
		"codex",
	); err != nil {
		t.Fatalf("ScheduleUsageRefresh(second) error = %v", err)
	}
	select {
	case <-secondStarted:
	case <-time.After(time.Second):
		t.Fatal("重导入后的新任务没有执行")
	}
	time.Sleep(20 * time.Millisecond)
	if refresher.calls.Load() != 2 {
		t.Fatalf("RefreshUsage() calls = %d, want 2", refresher.calls.Load())
	}
}

// coordinatorRefresher 记录后台调用并执行可控函数。
type coordinatorRefresher struct {
	calls   atomic.Int64
	execute func(accountcore.AccountRef) error
}

// generationAwareRefresher 让首代任务等待取消、次代任务立即完成。
type generationAwareRefresher struct {
	calls         atomic.Int64
	firstStarted  chan<- struct{}
	firstCanceled chan<- struct{}
	secondStarted chan<- struct{}
}

// RefreshUsage 按调用代次暴露取消与重新调度事实。
func (refresher *generationAwareRefresher) RefreshUsage(
	ctx context.Context,
	_ accountcore.AccountRef,
) (usageapp.ReadResult, error) {
	call := refresher.calls.Add(1)
	if call == 1 {
		close(refresher.firstStarted)
		<-ctx.Done()
		close(refresher.firstCanceled)
		return usageapp.ReadResult{}, ctx.Err()
	}
	close(refresher.secondStarted)
	return usageapp.ReadResult{}, nil
}

func (refresher *coordinatorRefresher) RefreshUsage(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (usageapp.ReadResult, error) {
	refresher.calls.Add(1)
	return usageapp.ReadResult{}, refresher.execute(accountRef)
}

// newCoordinatorSubject 创建双 Provider 单 worker 的测试协调器。
func newCoordinatorSubject(
	t *testing.T,
	refresher usageapp.UsageRefresher,
	interval time.Duration,
	observer usageapp.RefreshObserver,
) *usageapp.Coordinator {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	coordinator, err := usageapp.NewCoordinator(usageapp.CoordinatorOptions{
		Catalog:   catalog,
		Refresher: refresher,
		ProviderConcurrency: map[string]int{
			"codex":  1,
			"claude": 1,
		},
		RefreshTimeout:  time.Second,
		RefreshInterval: interval,
		StaggerWindow:   interval / 10,
		BaseBackoff:     5 * time.Millisecond,
		MaxBackoff:      50 * time.Millisecond,
		Clock:           time.Now,
		Observer:        observer,
	})
	if err != nil {
		t.Fatalf("NewCoordinator() error = %v", err)
	}
	return coordinator
}

// coordinatorAccountRef 创建按数字可区分的稳定引用。
func coordinatorAccountRef(
	t *testing.T,
	value byte,
) accountcore.AccountRef {
	t.Helper()

	digits := []byte("00000000000000000000")
	digits[len(digits)-1] = "0123456789abcdef"[value]
	accountRef, err := accountcore.ParseAccountRef("acct_" + string(digits))
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return accountRef
}

// receiveCoordinatorRef 有界等待后台任务启动。
func receiveCoordinatorRef(
	t *testing.T,
	started <-chan accountcore.AccountRef,
) accountcore.AccountRef {
	t.Helper()

	select {
	case accountRef := <-started:
		return accountRef
	case <-time.After(time.Second):
		t.Fatal("等待后台任务启动超时")
		return ""
	}
}
