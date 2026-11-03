package aihserver

import (
	"context"
	"log"
	"sync"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// quotaFailureRefreshDebounce 是同一账号「额度失败 → 立即刷新额度」的最短间隔：
	// 一阵并发失败只排一次刷新（与 Node 的 QUOTA_FAILURE_REFRESH_DEBOUNCE_MS 同值）。
	quotaFailureRefreshDebounce = 30 * time.Second
	// quotaFailureRefreshTimeout 只覆盖账号读取与排队，不覆盖刷新本身（由协调器执行）。
	quotaFailureRefreshTimeout = 5 * time.Second
)

// usageRefreshScheduler 是额度协调器的立即刷新入口。
type usageRefreshScheduler func(context.Context, accountcore.AccountRef, string) error

// quotaFailureRefresh 把「上游说额度用完了」转成一次立即的额度刷新（与 Node 的
// account-usage-gate refreshAfterQuotaFailure 同构）。
//
// 失败观察到的额度阻塞到复核时刻（BlockRecheckInterval）就失效，而额度快照才是真相：
// 刷新后快照仍显示耗尽时，快照投影的阻塞会一直挡住该账号，直到后续快照显示恢复，
// 不会每到复核时刻就拿真实请求去试。没有额度采集策略的 Provider 由协调器拒绝排队，
// 这里静默忽略，它们只靠复核时刻重新验证。
type quotaFailureRefresh struct {
	accounts usageLedgerAccountReader
	clock    func() time.Time
	errorLog *log.Logger

	mu       sync.Mutex
	schedule usageRefreshScheduler
	last     map[accountcore.AccountRef]time.Time
}

func newQuotaFailureRefresh(
	accounts usageLedgerAccountReader,
	clock func() time.Time,
	errorLog *log.Logger,
) *quotaFailureRefresh {
	return &quotaFailureRefresh{
		accounts: accounts,
		clock:    clock,
		errorLog: errorLog,
		last:     make(map[accountcore.AccountRef]time.Time),
	}
}

// bind 在额度子系统装配完成后接上刷新入口：运行态装饰器先于额度子系统创建。
func (refresh *quotaFailureRefresh) bind(schedule usageRefreshScheduler) {
	if refresh == nil {
		return
	}
	refresh.mu.Lock()
	refresh.schedule = schedule
	refresh.mu.Unlock()
}

// observe 在额度耗尽类失败后为该账号排一次刷新；去抖、异步，不影响本次请求。
func (refresh *quotaFailureRefresh) observe(
	accountRef accountcore.AccountRef,
	kind runtimecore.FailureKind,
) {
	if refresh == nil ||
		kind != runtimecore.FailureQuotaExhausted ||
		!accountRef.IsValid() ||
		refresh.accounts == nil {
		return
	}
	now := refresh.clock()
	refresh.mu.Lock()
	schedule := refresh.schedule
	if schedule == nil {
		refresh.mu.Unlock()
		return
	}
	if previous, found := refresh.last[accountRef]; found &&
		now.Sub(previous) < quotaFailureRefreshDebounce {
		refresh.mu.Unlock()
		return
	}
	refresh.last[accountRef] = now
	refresh.mu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), quotaFailureRefreshTimeout)
		defer cancel()
		account, err := refresh.accounts.GetByRef(ctx, accountRef)
		if err != nil {
			return
		}
		// 协调器拒绝没有额度采集策略的 Provider（ErrInvalidSchedule）：那是预期，不记录。
		_ = schedule(ctx, accountRef, account.ProviderID())
	}()
}
