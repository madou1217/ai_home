// Package accountruntime 提供进程内稀疏账号运行态索引。
//
// 该应用服务只保存出现过失败的账号与模型元组；健康账号不占用 map 条目，
// 也不会加载账号凭据、公开资料或 usage 数据。
package accountruntime

import (
	"context"
	"errors"
	"sync"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var (
	// ErrInvalidDependencies 表示运行态索引缺少时钟。
	ErrInvalidDependencies = errors.New("账号运行态索引依赖无效")
	// ErrInvalidRequest 表示上下文或账号模型键无效。
	ErrInvalidRequest = errors.New("账号运行态索引请求无效")
)

// Clock 返回当前业务时间。
type Clock func() time.Time

// Registry 是按账号与模型元组加锁更新的稀疏运行态索引。
type Registry struct {
	mu     sync.RWMutex
	clock  Clock
	states map[runtimecore.ModelRoute]runtimecore.ModelState
}

// NewRegistry 创建不预载账号池的运行态索引。
func NewRegistry(clock Clock) (*Registry, error) {
	if clock == nil {
		return nil, ErrInvalidDependencies
	}
	return &Registry{
		clock:  clock,
		states: make(map[runtimecore.ModelRoute]runtimecore.ModelState),
	}, nil
}

// RecordFailure 原子记录一个低敏失败，并返回调用方需要执行的状态动作。
func (registry *Registry) RecordFailure(
	ctx context.Context,
	route runtimecore.ModelRoute,
	kind runtimecore.FailureKind,
	retryAfter time.Duration,
) (runtimecore.Transition, error) {
	if err := registry.validateRequest(ctx, route); err != nil {
		return runtimecore.Transition{}, err
	}
	failure, err := runtimecore.NewFailure(
		kind,
		registry.clock(),
		retryAfter,
	)
	if err != nil {
		return runtimecore.Transition{}, err
	}

	registry.mu.Lock()
	defer registry.mu.Unlock()
	next, transition, err := registry.states[route].Apply(failure)
	if err != nil {
		return runtimecore.Transition{}, err
	}
	registry.replaceState(route, next)
	return transition, nil
}

// RecordSuccess 只用不早于最后失败的成功清除当前账号模型元组。
func (registry *Registry) RecordSuccess(
	ctx context.Context,
	route runtimecore.ModelRoute,
	happenedAt time.Time,
) error {
	if err := registry.validateRequest(ctx, route); err != nil {
		return err
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	next, err := registry.states[route].Succeed(happenedAt)
	if err != nil {
		return err
	}
	registry.replaceState(route, next)
	return nil
}

// CheckEligibility 返回当前元组资格，并在读取路径主动回收过期状态。
func (registry *Registry) CheckEligibility(
	ctx context.Context,
	route runtimecore.ModelRoute,
) (runtimecore.Eligibility, error) {
	if err := registry.validateRequest(ctx, route); err != nil {
		return runtimecore.Eligibility{}, err
	}
	now := registry.clock()

	registry.mu.RLock()
	_, found := registry.states[route]
	registry.mu.RUnlock()
	if !found {
		_, eligibility, err := (runtimecore.ModelState{}).Evaluate(now)
		return eligibility, err
	}

	registry.mu.Lock()
	defer registry.mu.Unlock()
	next, eligibility, err := registry.states[route].Evaluate(now)
	if err != nil {
		return runtimecore.Eligibility{}, err
	}
	registry.replaceState(route, next)
	return eligibility, nil
}

// Len 返回当前仍需保存的失败元组数量。
func (registry *Registry) Len() int {
	if registry == nil {
		return 0
	}
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	return len(registry.states)
}

// ForgetAccount 删除一个账号全部模型的稀疏 cooldown 状态。
func (registry *Registry) ForgetAccount(
	accountRef accountcore.AccountRef,
) {
	if registry == nil || registry.states == nil || !accountRef.IsValid() {
		return
	}
	registry.mu.Lock()
	defer registry.mu.Unlock()
	for route := range registry.states {
		if route.AccountRef() == accountRef {
			delete(registry.states, route)
		}
	}
}

// validateRequest 在加锁和访问时钟前拒绝无效输入。
func (registry *Registry) validateRequest(
	ctx context.Context,
	route runtimecore.ModelRoute,
) error {
	if registry == nil ||
		registry.clock == nil ||
		registry.states == nil ||
		ctx == nil ||
		!route.IsValid() {
		return ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return nil
}

// replaceState 保持索引稀疏，零状态立即删除。
func (registry *Registry) replaceState(
	route runtimecore.ModelRoute,
	state runtimecore.ModelState,
) {
	if state.IsZero() {
		delete(registry.states, route)
		return
	}
	registry.states[route] = state
}
