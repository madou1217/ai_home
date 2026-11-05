// Package inmemory 提供单进程内线程安全的账号运行态分发器。
//
// 健康账号不预分配状态；硬阻塞使用紧凑位集合，模型 cooldown 复用应用层
// 稀疏 Registry。上游失败观察到的硬阻塞带复核时刻（见 failureBlock），真相源
// 推导出的阻塞（额度快照投影）不随时间失效。该实现不读取凭据、不访问数据库，
// 也不保存 Provider 原文。
package inmemory

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/accountrouting"
	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

var (
	// ErrInvalidDependencies 表示运行态缺少有效时钟或 cooldown Registry。
	ErrInvalidDependencies = errors.New("内存账号运行态依赖无效")
	// ErrInvalidRequest 表示上下文、账号、模型或失败结果无效。
	ErrInvalidRequest = errors.New("内存账号运行态请求无效")
	// ErrInvalidRecovery 表示恢复事件不能用于目标阻塞作用域。
	ErrInvalidRecovery = errors.New("内存账号运行态恢复事件无效")
)

// Runtime 同时实现征召资格读取和推理终态记录两个应用端口。
type Runtime struct {
	mu        sync.RWMutex
	clock     runtimeapp.Clock
	cooldowns *runtimeapp.Registry
	// accountBlocks / modelBlocks 只保存真相源推导出的阻塞（额度快照投影），不会随时间失效。
	accountBlocks map[accountcore.AccountRef]blockSet
	modelBlocks   map[runtimecore.ModelRoute]blockSet
	// accountFailures / modelFailures 保存上游失败观察到的硬阻塞，到复核时刻失效。
	accountFailures map[accountcore.AccountRef]failureBlock
	modelFailures   map[runtimecore.ModelRoute]failureBlock
	// persistedFailures 保存由持久化账号运行态（Node 观察后推来的 auth_invalid 等）
	// 推导出的阻塞。它们与上游失败同构：到文档里的 until 失效，下一次请求重新验证。
	// 单独一张表是为了整份替换某个账号的状态时，不会误清 Go 自己观察到的失败。
	persistedFailures map[accountcore.AccountRef]failureBlock
	// remaining 保存账号由最新额度快照推导出的剩余额度基点；无额度信息的账号不占条目。
	remaining map[accountcore.AccountRef]uint16
}

var (
	_ accountrouting.RuntimeEligibilitySource = (*Runtime)(nil)
	_ accountrouting.AccountWeightSource      = (*Runtime)(nil)
	_ inferencegateway.AttemptRecorder        = (*Runtime)(nil)
)

// New 创建不预载账号池、也不持久化 cooldown 的纯内存运行态分发器。
func New(clock runtimeapp.Clock) (*Runtime, error) {
	return NewWithStore(nil, clock, nil, nil)
}

// NewWithStore 创建预载持久化 cooldown 的运行态分发器。
//
// store 为 nil 时退化为纯内存实现（测试与不需要跨重启保留 cooldown 的宿主）。
// onPersistError 是持久化失败的观测出口，可为 nil；失败不会让请求失败。
func NewWithStore(
	ctx context.Context,
	clock runtimeapp.Clock,
	store runtimeapp.StateStore,
	onPersistError func(error),
) (*Runtime, error) {
	var options []runtimeapp.RegistryOption
	if onPersistError != nil {
		options = append(options, runtimeapp.WithPersistErrorObserver(onPersistError))
	}
	var (
		cooldowns *runtimeapp.Registry
		err       error
	)
	if store == nil {
		cooldowns, err = runtimeapp.NewRegistry(clock, options...)
	} else {
		if ctx == nil {
			return nil, errors.Join(ErrInvalidDependencies, runtimeapp.ErrInvalidRequest)
		}
		cooldowns, err = runtimeapp.NewRegistryWithStore(ctx, clock, store, options...)
	}
	if err != nil {
		return nil, errors.Join(ErrInvalidDependencies, err)
	}
	return &Runtime{
		clock:             clock,
		cooldowns:         cooldowns,
		accountBlocks:     make(map[accountcore.AccountRef]blockSet),
		modelBlocks:       make(map[runtimecore.ModelRoute]blockSet),
		accountFailures:   make(map[accountcore.AccountRef]failureBlock),
		modelFailures:     make(map[runtimecore.ModelRoute]failureBlock),
		persistedFailures: make(map[accountcore.AccountRef]failureBlock),
		remaining:         make(map[accountcore.AccountRef]uint16),
	}, nil
}

// PersistError 返回最近一次 cooldown 持久化失败；成功后自动清零。
func (runtime *Runtime) PersistError() error {
	if runtime == nil {
		return nil
	}
	return runtime.cooldowns.PersistError()
}

// CheckEligibility 先合并账号级和模型级硬阻塞，再读取模型 cooldown。
//
// 失败观察到的阻塞到了复核时刻即不再生效：本次请求就是对它的复核。
func (runtime *Runtime) CheckEligibility(
	ctx context.Context,
	route runtimecore.ModelRoute,
) (runtimecore.Eligibility, error) {
	if err := runtime.validateRouteRequest(ctx, route); err != nil {
		return runtimecore.Eligibility{}, err
	}

	now := runtime.clock()
	runtime.mu.RLock()
	blocks := runtime.accountBlocks[route.AccountRef()] |
		runtime.modelBlocks[route] |
		runtime.accountFailures[route.AccountRef()].activeAt(now) |
		runtime.persistedFailures[route.AccountRef()].activeAt(now) |
		runtime.modelFailures[route].activeAt(now)
	runtime.mu.RUnlock()
	if eligibility, blocked := blocks.eligibility(); blocked {
		return eligibility, nil
	}
	return runtime.cooldowns.CheckEligibility(ctx, route)
}

// RecordSuccess 清除当前账号模型的 streak 和 cooldown，并收起已到复核时刻的失败观察。
//
// 仍生效的失败观察不受影响：一次早已在途的请求晚到的成功，不能推翻更新的拒绝。
// 真相源推导出的阻塞只能由对应的外部真相源更新接口解除。
func (runtime *Runtime) RecordSuccess(
	ctx context.Context,
	route runtimecore.ModelRoute,
	success inferencegateway.AttemptSuccess,
) error {
	if err := runtime.validateRouteRequest(ctx, route); err != nil ||
		!success.IsValid() {
		if err != nil {
			return err
		}
		return ErrInvalidRequest
	}
	if err := runtime.cooldowns.RecordSuccess(ctx, route, success.HappenedAt()); err != nil {
		return err
	}
	runtime.forgetDueFailures(route, runtime.clock())
	return nil
}

// RecordFailure 根据领域动作把失败分发到硬阻塞或模型 cooldown。
func (runtime *Runtime) RecordFailure(
	ctx context.Context,
	route runtimecore.ModelRoute,
	failure inferencegateway.AttemptFailure,
) error {
	if err := runtime.validateRouteRequest(ctx, route); err != nil {
		return err
	}
	if !failure.IsValid() {
		return ErrInvalidRequest
	}

	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	transition, err := runtime.cooldowns.RecordFailure(
		ctx,
		route,
		failure.RuntimeKind(),
		failure.RetryAfter(),
	)
	if err != nil {
		return err
	}
	switch transition.Action() {
	case runtimecore.ActionNoStateChange,
		runtimecore.ActionModelCooldown:
		return nil
	case runtimecore.ActionCredentialBlock,
		runtimecore.ActionQuotaBlock,
		runtimecore.ActionPolicyBlock:
		return runtime.recordBlock(
			route,
			failure.RuntimeKind(),
			failure.BlockDirective(),
		)
	default:
		return ErrInvalidRequest
	}
}

// ApplyAccountState 把持久化的账号运行态文档投影为内存征召阻塞。
//
// 这些状态由 Node 侧观察后推给 Go（auth_invalid / cooldown / ...）。它们不是 Go 自己
// 观测到的失败，但必须参与征召：否则「用户启用 + 凭据失效」的账号会被 Go 继续调度。
// 整份替换该账号的持久化阻塞（而不是按位合并）：文档本身就是当前唯一真相。
func (runtime *Runtime) ApplyAccountState(
	ctx context.Context,
	state runtimecore.AccountState,
) error {
	if runtime == nil || ctx == nil || !state.IsValid() {
		return ErrInvalidRequest
	}
	accountRef := state.AccountRef()
	block, hasBlock := state.DeriveBlock()
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if !hasBlock || block.Scope() != runtimecore.BlockScopeAccount {
		delete(runtime.persistedFailures, accountRef)
		return nil
	}
	directive, err := runtimecore.NewBlockDirective(block.Kind(), block.Scope())
	if err != nil {
		delete(runtime.persistedFailures, accountRef)
		return nil
	}
	definition, ok := definitionForRecovery(directive.RecoveryTrigger())
	if !ok {
		delete(runtime.persistedFailures, accountRef)
		return nil
	}
	runtime.persistedFailures[accountRef] = failureBlock{}.observe(
		definition.block,
		runtime.clock(),
		block.Until(),
	)
	return nil
}

// ClearAccountState 删除持久化运行态对应的内存阻塞（账号文档被删除时）。
func (runtime *Runtime) ClearAccountState(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) error {
	if runtime == nil || ctx == nil || !accountRef.IsValid() {
		return ErrInvalidRequest
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	delete(runtime.persistedFailures, accountRef)
	return nil
}

// ClearAccountBlock 在账号真相源更新成功后精确清除对应阻塞位。
func (runtime *Runtime) ClearAccountBlock(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	trigger runtimecore.RecoveryTrigger,
) error {
	block, err := runtime.accountRecoveryBlock(
		ctx,
		accountRef,
		trigger,
	)
	if err != nil {
		return err
	}

	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	next := runtime.accountBlocks[accountRef].clear(block)
	runtime.replaceAccountBlocks(accountRef, next)
	runtime.replaceAccountFailure(accountRef, runtime.accountFailures[accountRef].clear(block))
	return nil
}

// ClearModelBlock 在模型真相源更新成功后精确清除对应阻塞位。
func (runtime *Runtime) ClearModelBlock(
	ctx context.Context,
	route runtimecore.ModelRoute,
	trigger runtimecore.RecoveryTrigger,
) error {
	return runtime.ClearModelBlocks(
		ctx,
		route.AccountRef(),
		[]runtimecore.ModelID{route.ModelID()},
		trigger,
	)
}

// ClearModelBlocks 在一次写锁内精确清除已确认模型集合的对应阻塞位。
//
// modelIDs 必须严格升序且去重，避免恢复热批次重复扫描同一键。
func (runtime *Runtime) ClearModelBlocks(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	modelIDs []runtimecore.ModelID,
	trigger runtimecore.RecoveryTrigger,
) error {
	block, err := runtime.validateModelRecoveryBatch(
		ctx,
		accountRef,
		modelIDs,
		trigger,
	)
	if err != nil {
		return err
	}

	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	for _, modelID := range modelIDs {
		route, _ := runtimecore.NewModelRoute(
			accountRef,
			modelID.String(),
		)
		next := runtime.modelBlocks[route].clear(block)
		runtime.replaceModelBlocks(route, next)
		runtime.replaceModelFailure(route, runtime.modelFailures[route].clear(block))
	}
	return nil
}

// ReplaceUsageProjection 原子替换一个账号由最新额度快照拥有的全部运行态事实。
//
// 该操作只修改 blockUsageSnapshot 与剩余额度权重，不会清除凭据、账单、策略或
// cooldown 状态。
func (runtime *Runtime) ReplaceUsageProjection(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	accountBlocked bool,
	modelIDs []runtimecore.ModelID,
	remaining usagecore.Remaining,
) error {
	if err := runtime.validateUsageProjection(
		ctx,
		accountRef,
		modelIDs,
	); err != nil {
		return err
	}

	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	accountBlocks := runtime.accountBlocks[accountRef].clear(blockUsageSnapshot)
	if accountBlocked {
		accountBlocks = accountBlocks.add(blockUsageSnapshot)
	}
	runtime.replaceAccountBlocks(accountRef, accountBlocks)
	// 新快照是额度的真相：它取代之前失败观察到的额度阻塞（快照仍显示耗尽时上面已重新加回）。
	runtime.replaceAccountFailure(
		accountRef,
		runtime.accountFailures[accountRef].clear(blockUsageSnapshot),
	)
	for route, failure := range runtime.modelFailures {
		if route.AccountRef() == accountRef {
			runtime.replaceModelFailure(route, failure.clear(blockUsageSnapshot))
		}
	}
	// 剩余额度与阻塞位同源：同一次快照刷新必须同时替换，避免两者互相矛盾。
	if remaining.Known {
		runtime.remaining[accountRef] = remaining.BasisPoints
	} else {
		delete(runtime.remaining, accountRef)
	}

	for route, blocks := range runtime.modelBlocks {
		if route.AccountRef() != accountRef {
			continue
		}
		runtime.replaceModelBlocks(route, blocks.clear(blockUsageSnapshot))
	}
	for _, modelID := range modelIDs {
		route, _ := runtimecore.NewModelRoute(accountRef, modelID.String())
		blocks := runtime.modelBlocks[route].add(blockUsageSnapshot)
		runtime.replaceModelBlocks(route, blocks)
	}
	return nil
}

// AccountRemaining 返回账号由最新额度快照推导出的剩余额度。
//
// 无额度信息（未采集、账号不存在或快照没有可用比例）时返回未知值，调用方必须按
// 「没有权重信息」处理，不能当成额度为零。
func (runtime *Runtime) AccountRemaining(
	accountRef accountcore.AccountRef,
) usagecore.Remaining {
	if runtime == nil || runtime.remaining == nil || !accountRef.IsValid() {
		return usagecore.UnknownRemaining()
	}
	runtime.mu.RLock()
	defer runtime.mu.RUnlock()
	basisPoints, found := runtime.remaining[accountRef]
	if !found {
		return usagecore.UnknownRemaining()
	}
	return usagecore.Remaining{Known: true, BasisPoints: basisPoints}
}

// ForgetAccount 原子清理账号级阻塞、模型级阻塞、剩余额度和全部模型 cooldown。
func (runtime *Runtime) ForgetAccount(
	accountRef accountcore.AccountRef,
) {
	if runtime == nil ||
		runtime.cooldowns == nil ||
		runtime.accountBlocks == nil ||
		runtime.modelBlocks == nil ||
		!accountRef.IsValid() {
		return
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	delete(runtime.accountBlocks, accountRef)
	delete(runtime.accountFailures, accountRef)
	delete(runtime.remaining, accountRef)
	for route := range runtime.modelBlocks {
		if route.AccountRef() == accountRef {
			delete(runtime.modelBlocks, route)
		}
	}
	for route := range runtime.modelFailures {
		if route.AccountRef() == accountRef {
			delete(runtime.modelFailures, route)
		}
	}
	runtime.cooldowns.ForgetAccount(accountRef)
}

// recordBlock 校验 Provider 指令后，以复核时刻保存最小作用域的失败观察。
//
// 硬阻塞失败不携带恢复提示（NewAttemptFailure 只允许 cooldown 带 Retry-After），复核时刻
// 统一取 BlockRecheckInterval。
func (runtime *Runtime) recordBlock(
	route runtimecore.ModelRoute,
	kind runtimecore.FailureKind,
	directive runtimecore.BlockDirective,
) error {
	if !directive.IsValidFor(kind) {
		return ErrInvalidRequest
	}
	definition, valid := definitionForRecovery(
		directive.RecoveryTrigger(),
	)
	if !valid {
		return ErrInvalidRequest
	}
	now := runtime.clock()
	recheckAt := now.Add(runtimecore.BlockRecheckInterval)
	switch directive.Scope() {
	case runtimecore.BlockScopeAccount:
		if !definition.supports(recoveryScopeAccount) {
			return ErrInvalidRequest
		}
		accountRef := route.AccountRef()
		runtime.accountFailures[accountRef] =
			runtime.accountFailures[accountRef].observe(definition.block, now, recheckAt)
	case runtimecore.BlockScopeAccountModel:
		if !definition.supports(recoveryScopeModel) {
			return ErrInvalidRequest
		}
		runtime.modelFailures[route] =
			runtime.modelFailures[route].observe(definition.block, now, recheckAt)
	default:
		return ErrInvalidRequest
	}
	return nil
}

// forgetDueFailures 在成功后收起该账号与该模型已到复核时刻的失败观察，保持索引稀疏。
func (runtime *Runtime) forgetDueFailures(
	route runtimecore.ModelRoute,
	now time.Time,
) {
	accountRef := route.AccountRef()
	runtime.mu.RLock()
	accountFailure, hasAccount := runtime.accountFailures[accountRef]
	modelFailure, hasModel := runtime.modelFailures[route]
	runtime.mu.RUnlock()
	dueAccount := hasAccount && accountFailure.activeAt(now) == 0
	dueModel := hasModel && modelFailure.activeAt(now) == 0
	if !dueAccount && !dueModel {
		return
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if current, found := runtime.accountFailures[accountRef]; found && current.activeAt(now) == 0 {
		delete(runtime.accountFailures, accountRef)
	}
	if current, found := runtime.modelFailures[route]; found && current.activeAt(now) == 0 {
		delete(runtime.modelFailures, route)
	}
}

// validateRouteRequest 在访问任何状态前拒绝无效输入。
func (runtime *Runtime) validateRouteRequest(
	ctx context.Context,
	route runtimecore.ModelRoute,
) error {
	if runtime == nil ||
		runtime.cooldowns == nil ||
		runtime.accountBlocks == nil ||
		runtime.modelBlocks == nil ||
		ctx == nil ||
		!route.IsValid() {
		return ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return nil
}

// accountRecoveryBlock 校验账号级恢复请求并返回对应阻塞位。
func (runtime *Runtime) accountRecoveryBlock(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	trigger runtimecore.RecoveryTrigger,
) (blockSet, error) {
	if runtime == nil ||
		runtime.cooldowns == nil ||
		runtime.accountBlocks == nil ||
		runtime.modelBlocks == nil ||
		ctx == nil ||
		!accountRef.IsValid() {
		return 0, ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	definition, valid := definitionForRecovery(trigger)
	if !valid || !definition.supports(recoveryScopeAccount) {
		return 0, ErrInvalidRecovery
	}
	return definition.block, nil
}

// validateModelRecoveryBatch 校验批量模型恢复请求并返回对应阻塞位。
func (runtime *Runtime) validateModelRecoveryBatch(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	modelIDs []runtimecore.ModelID,
	trigger runtimecore.RecoveryTrigger,
) (blockSet, error) {
	if runtime == nil ||
		runtime.cooldowns == nil ||
		runtime.accountBlocks == nil ||
		runtime.modelBlocks == nil ||
		ctx == nil ||
		!accountRef.IsValid() ||
		len(modelIDs) == 0 {
		return 0, ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	definition, valid := definitionForRecovery(trigger)
	if !valid || !definition.supports(recoveryScopeModel) {
		return 0, ErrInvalidRecovery
	}
	var previous runtimecore.ModelID
	for index, modelID := range modelIDs {
		if !modelID.IsValid() ||
			index > 0 && modelID.String() <= previous.String() {
			return 0, ErrInvalidRequest
		}
		previous = modelID
	}
	return definition.block, nil
}

// validateUsageProjection 校验完整模型阻塞集合严格排序且去重。
func (runtime *Runtime) validateUsageProjection(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	modelIDs []runtimecore.ModelID,
) error {
	if runtime == nil ||
		runtime.cooldowns == nil ||
		runtime.accountBlocks == nil ||
		runtime.modelBlocks == nil ||
		ctx == nil ||
		!accountRef.IsValid() {
		return ErrInvalidRequest
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	var previous runtimecore.ModelID
	for index, modelID := range modelIDs {
		if !modelID.IsValid() ||
			index > 0 && modelID.String() <= previous.String() {
			return ErrInvalidRequest
		}
		previous = modelID
	}
	return nil
}

// replaceAccountBlocks 保持账号级硬阻塞索引稀疏。
func (runtime *Runtime) replaceAccountBlocks(
	accountRef accountcore.AccountRef,
	blocks blockSet,
) {
	if blocks == 0 {
		delete(runtime.accountBlocks, accountRef)
		return
	}
	runtime.accountBlocks[accountRef] = blocks
}

// replaceModelBlocks 保持账号模型级硬阻塞索引稀疏。
func (runtime *Runtime) replaceModelBlocks(
	route runtimecore.ModelRoute,
	blocks blockSet,
) {
	if blocks == 0 {
		delete(runtime.modelBlocks, route)
		return
	}
	runtime.modelBlocks[route] = blocks
}

// replaceAccountFailure 保持账号级失败观察索引稀疏。
func (runtime *Runtime) replaceAccountFailure(
	accountRef accountcore.AccountRef,
	failure failureBlock,
) {
	if failure.set == 0 {
		delete(runtime.accountFailures, accountRef)
		return
	}
	runtime.accountFailures[accountRef] = failure
}

// replaceModelFailure 保持账号模型级失败观察索引稀疏。
func (runtime *Runtime) replaceModelFailure(
	route runtimecore.ModelRoute,
	failure failureBlock,
) {
	if failure.set == 0 {
		delete(runtime.modelFailures, route)
		return
	}
	runtime.modelFailures[route] = failure
}
