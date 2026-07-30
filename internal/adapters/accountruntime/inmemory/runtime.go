// Package inmemory 提供单进程内线程安全的账号运行态分发器。
//
// 健康账号不预分配状态；硬阻塞使用紧凑位集合，模型 cooldown 复用应用层
// 稀疏 Registry。该实现不读取凭据、不访问数据库，也不保存 Provider 原文。
package inmemory

import (
	"context"
	"errors"
	"sync"

	"github.com/madou1217/ai_home/application/accountrouting"
	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
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
	mu            sync.RWMutex
	cooldowns     *runtimeapp.Registry
	accountBlocks map[accountcore.AccountRef]blockSet
	modelBlocks   map[runtimecore.ModelRoute]blockSet
}

var (
	_ accountrouting.RuntimeEligibilitySource = (*Runtime)(nil)
	_ inferencegateway.AttemptRecorder        = (*Runtime)(nil)
)

// New 创建不预载账号池的纯内存运行态分发器。
func New(clock runtimeapp.Clock) (*Runtime, error) {
	cooldowns, err := runtimeapp.NewRegistry(clock)
	if err != nil {
		return nil, errors.Join(ErrInvalidDependencies, err)
	}
	return &Runtime{
		cooldowns:     cooldowns,
		accountBlocks: make(map[accountcore.AccountRef]blockSet),
		modelBlocks:   make(map[runtimecore.ModelRoute]blockSet),
	}, nil
}

// CheckEligibility 先合并账号级和模型级硬阻塞，再读取模型 cooldown。
func (runtime *Runtime) CheckEligibility(
	ctx context.Context,
	route runtimecore.ModelRoute,
) (runtimecore.Eligibility, error) {
	if err := runtime.validateRouteRequest(ctx, route); err != nil {
		return runtimecore.Eligibility{}, err
	}

	runtime.mu.RLock()
	blocks := runtime.accountBlocks[route.AccountRef()] |
		runtime.modelBlocks[route]
	runtime.mu.RUnlock()
	if eligibility, blocked := blocks.eligibility(); blocked {
		return eligibility, nil
	}
	return runtime.cooldowns.CheckEligibility(ctx, route)
}

// RecordSuccess 只清除当前账号模型的 streak 和 cooldown。
//
// 硬阻塞只能由对应的外部真相源更新接口解除。
func (runtime *Runtime) RecordSuccess(
	ctx context.Context,
	route runtimecore.ModelRoute,
) error {
	if err := runtime.validateRouteRequest(ctx, route); err != nil {
		return err
	}
	return runtime.cooldowns.RecordSuccess(ctx, route)
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
	}
	return nil
}

// ReplaceUsageProjection 原子替换一个账号由最新额度快照拥有的全部阻塞位。
//
// 该操作只修改 blockUsageSnapshot，不会清除凭据、账单、策略或 cooldown 状态。
func (runtime *Runtime) ReplaceUsageProjection(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	accountBlocked bool,
	modelIDs []runtimecore.ModelID,
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

// recordBlock 校验 Provider 指令后保存最小作用域的恢复位。
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
	switch directive.Scope() {
	case runtimecore.BlockScopeAccount:
		if !definition.supports(recoveryScopeAccount) {
			return ErrInvalidRequest
		}
		accountRef := route.AccountRef()
		runtime.accountBlocks[accountRef] =
			runtime.accountBlocks[accountRef].add(definition.block)
	case runtimecore.BlockScopeAccountModel:
		if !definition.supports(recoveryScopeModel) {
			return ErrInvalidRequest
		}
		runtime.modelBlocks[route] =
			runtime.modelBlocks[route].add(definition.block)
	default:
		return ErrInvalidRequest
	}
	return nil
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
