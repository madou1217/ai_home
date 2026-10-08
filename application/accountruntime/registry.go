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

// PersistedModelState 是一个需要跨进程保留的账号模型元组状态。
type PersistedModelState struct {
	Route runtimecore.ModelRoute
	State runtimecore.ModelStateSnapshot
}

// StateStore 持久化模型 cooldown，使进程重启后不会立刻重试刚被限流的模型。
//
// 该端口只承载 cooldown 与连续失败计数；硬阻塞由各自的真相源（凭据、额度快照）
// 重新推导，不经过这里。
type StateStore interface {
	// LoadModelStates 返回存储中全部元组状态。
	LoadModelStates(ctx context.Context) ([]PersistedModelState, error)
	// SaveModelState 原子写入或覆盖一个元组状态。
	SaveModelState(ctx context.Context, entry PersistedModelState) error
	// DeleteModelState 删除一个不再需要保留的元组状态。
	DeleteModelState(ctx context.Context, route runtimecore.ModelRoute) error
}

// Registry 是按账号与模型元组加锁更新的稀疏运行态索引。
type Registry struct {
	mu     sync.RWMutex
	clock  Clock
	store  StateStore
	states map[runtimecore.ModelRoute]runtimecore.ModelState
	// persistErr 保存最近一次持久化失败，供运行态健康检查读取。
	//
	// 写失败不返回给调用方：cooldown 在本进程内已经生效，让一次存储抖动把正常请求
	// 判为失败，代价远大于重启后多试一次。失败必须可观测，不能静默。
	persistErr error
	// onPersistError 是持久化失败的观测出口，在释放索引锁之后调用。
	onPersistError func(error)
}

// RegistryOption 调整运行态索引的可选依赖。
type RegistryOption func(*Registry)

// WithPersistErrorObserver 注册持久化失败观测出口；回调必须非阻塞。
func WithPersistErrorObserver(observer func(error)) RegistryOption {
	return func(registry *Registry) {
		registry.onPersistError = observer
	}
}

// NewRegistry 创建不预载账号池、也不持久化的运行态索引。
func NewRegistry(clock Clock, options ...RegistryOption) (*Registry, error) {
	if clock == nil {
		return nil, ErrInvalidDependencies
	}
	registry := &Registry{
		clock:  clock,
		states: make(map[runtimecore.ModelRoute]runtimecore.ModelState),
	}
	for _, option := range options {
		if option != nil {
			option(registry)
		}
	}
	return registry, nil
}

// NewRegistryWithStore 创建预载持久化 cooldown 的运行态索引。
//
// 预载时立即丢弃已过期或状态损坏的行：过期行不再影响路由，状态损坏行属于存储噪声，
// 两者都不应该阻止进程启动。账号或模型身份本身无法解析的行视为存储损坏，直接失败。
func NewRegistryWithStore(
	ctx context.Context,
	clock Clock,
	store StateStore,
	options ...RegistryOption,
) (*Registry, error) {
	if store == nil {
		return nil, ErrInvalidDependencies
	}
	if ctx == nil {
		return nil, ErrInvalidRequest
	}
	registry, err := NewRegistry(clock, options...)
	if err != nil {
		return nil, err
	}
	entries, err := store.LoadModelStates(ctx)
	if err != nil {
		return nil, errors.Join(ErrInvalidDependencies, err)
	}
	registry.store = store
	now := clock()
	var loadErr error
	for _, entry := range entries {
		state, restoreErr := runtimecore.RestoreModelState(entry.State)
		if restoreErr == nil {
			var pruned runtimecore.ModelState
			pruned, _, restoreErr = state.Evaluate(now)
			if restoreErr == nil && !pruned.IsZero() {
				registry.states[entry.Route] = pruned
				continue
			}
		}
		if deleteErr := store.DeleteModelState(ctx, entry.Route); deleteErr != nil {
			loadErr = deleteErr
		}
	}
	registry.mu.Lock()
	registry.persistErr = loadErr
	registry.mu.Unlock()
	return registry, nil
}

// PersistError 返回最近一次持久化失败；成功后自动清零。
func (registry *Registry) PersistError() error {
	if registry == nil {
		return nil
	}
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	return registry.persistErr
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
	next, transition, applyErr := registry.states[route].Apply(failure)
	if applyErr != nil {
		registry.mu.Unlock()
		return runtimecore.Transition{}, applyErr
	}
	registry.replaceState(route, next)
	persistErr := registry.persistState(ctx, route, next)
	registry.mu.Unlock()
	registry.reportPersistError(persistErr)
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
	next, succeedErr := registry.states[route].Succeed(happenedAt)
	if succeedErr != nil {
		registry.mu.Unlock()
		return succeedErr
	}
	registry.replaceState(route, next)
	persistErr := registry.persistState(ctx, route, next)
	registry.mu.Unlock()
	registry.reportPersistError(persistErr)
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

// ModelCooldown 是一个仍生效的账号模型 cooldown 的只读视图。
type ModelCooldown struct {
	Route runtimecore.ModelRoute
	Kind  runtimecore.FailureKind
	Until time.Time
}

// ActiveCooldowns 返回当前时钟下仍生效的全部 cooldown（供账号页展示）；不回收过期状态。
func (registry *Registry) ActiveCooldowns() []ModelCooldown {
	if registry == nil || registry.clock == nil {
		return nil
	}
	now := registry.clock()
	registry.mu.RLock()
	defer registry.mu.RUnlock()
	cooldowns := make([]ModelCooldown, 0, len(registry.states))
	for route, state := range registry.states {
		if kind, until, active := state.ActiveCooldown(now); active {
			cooldowns = append(cooldowns, ModelCooldown{Route: route, Kind: kind, Until: until})
		}
	}
	return cooldowns
}

// ForgetAccount 删除一个账号全部模型的稀疏 cooldown 状态。
func (registry *Registry) ForgetAccount(
	accountRef accountcore.AccountRef,
) {
	if registry == nil || registry.states == nil || !accountRef.IsValid() {
		return
	}
	registry.mu.Lock()
	var forgotten []runtimecore.ModelRoute
	for route := range registry.states {
		if route.AccountRef() == accountRef {
			delete(registry.states, route)
			forgotten = append(forgotten, route)
		}
	}
	var persistErr error
	// 账号行被删除时外键级联已经清理；这里覆盖账号仍在但运行态必须重置的情况。
	if registry.store != nil {
		for _, route := range forgotten {
			if deleteErr := registry.store.DeleteModelState(
				context.Background(),
				route,
			); deleteErr != nil {
				persistErr = deleteErr
			}
		}
	}
	registry.persistErr = persistErr
	registry.mu.Unlock()
	registry.reportPersistError(persistErr)
}

// persistState 在索引锁内把一次状态变更写入存储，并返回本次写入的错误。
//
// 锁内写保证同一元组的写入顺序与内存状态变更顺序一致，避免旧状态覆盖新状态。
func (registry *Registry) persistState(
	ctx context.Context,
	route runtimecore.ModelRoute,
	state runtimecore.ModelState,
) error {
	if registry.store == nil {
		return nil
	}
	var err error
	if state.IsZero() {
		err = registry.store.DeleteModelState(ctx, route)
	} else {
		err = registry.store.SaveModelState(ctx, PersistedModelState{
			Route: route,
			State: state.Snapshot(),
		})
	}
	registry.persistErr = err
	return err
}

// reportPersistError 在释放索引锁之后把持久化失败交给观测出口。
func (registry *Registry) reportPersistError(err error) {
	if err == nil || registry == nil || registry.onPersistError == nil {
		return
	}
	registry.onPersistError(err)
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
