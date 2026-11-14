package accountrecovery

import (
	"context"
	"errors"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// ModelManagement 在模型写事务成功后恢复当前有效模型的运行资格。
type ModelManagement struct {
	next    ModelManagementService
	runtime Runtime
}

// NewModelManagement 创建不参与目录发现或数据库事务的恢复 Decorator。
func NewModelManagement(
	next ModelManagementService,
	runtime Runtime,
) (*ModelManagement, error) {
	if next == nil || runtime == nil {
		return nil, ErrInvalidDependencies
	}
	return &ModelManagement{
		next:    next,
		runtime: runtime,
	}, nil
}

// ListAccountModels 直接返回当前模型快照，不产生恢复副作用。
func (decorator *ModelManagement) ListAccountModels(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) ([]accountapp.AccountModel, error) {
	if err := decorator.validateRequest(ctx, accountRef); err != nil {
		return nil, err
	}
	return decorator.next.ListAccountModels(ctx, accountRef)
}

// RefreshAccountModels 保留兼容列表端口；刷新身份由显式快照端口承载。
func (decorator *ModelManagement) RefreshAccountModels(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) ([]accountapp.AccountModel, error) {
	snapshot, err := decorator.RefreshAccountModelSnapshot(ctx, accountRef)
	return snapshot.Models, err
}

// RefreshAccountModelSnapshot 在完整目录事务成功后恢复实际账号的有效模型。
// 错误结果仍携带已经提交的 re-key 身份，供协调器继续同一重试预算，而不是重试旧 ref。
func (decorator *ModelManagement) RefreshAccountModelSnapshot(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.AccountModelRefreshSnapshot, error) {
	result := accountapp.AccountModelRefreshSnapshot{AccountRef: accountRef}
	if err := decorator.validateRequest(ctx, accountRef); err != nil {
		return result, err
	}
	if refresher, ok := decorator.next.(accountapp.AccountModelSnapshotRefresher); ok {
		// 只有显式事务结果可以声明 re-key；不从第一条模型猜测身份。
		snapshot, err := refresher.RefreshAccountModelSnapshot(ctx, accountRef)
		if err != nil {
			// 失败不要求完整成功快照；保留取消/原始错误，只采纳有效的已提交身份。
			if snapshot.AccountRef.IsValid() {
				result.AccountRef = snapshot.AccountRef
			}
			return result, err
		}
		if !snapshot.AccountRef.IsValid() {
			return result, ErrInvalidResult
		}
		result = snapshot
	} else {
		models, err := decorator.next.RefreshAccountModels(ctx, accountRef)
		if err != nil {
			return result, err
		}
		// 旧端口没有 re-key 证明，下面仍严格校验模型属于入参账号。
		result.Models = models
	}
	if err := decorator.recoverEffectiveModels(ctx, result.AccountRef, result.Models); err != nil {
		return accountapp.AccountModelRefreshSnapshot{AccountRef: result.AccountRef}, err
	}
	return result, nil
}

// SetManualModelPolicy 在人工策略事务成功后恢复其中的有效模型。
func (decorator *ModelManagement) SetManualModelPolicy(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	modelID string,
	policy accountapp.ModelManualPolicy,
) ([]accountapp.AccountModel, error) {
	if err := decorator.validateRequest(ctx, accountRef); err != nil {
		return nil, err
	}
	models, err := decorator.next.SetManualModelPolicy(
		ctx,
		accountRef,
		modelID,
		policy,
	)
	if err != nil {
		return nil, err
	}
	if err := decorator.recoverEffectiveModels(
		ctx,
		accountRef,
		models,
	); err != nil {
		return nil, err
	}
	return models, nil
}

// recoverEffectiveModels 校验完整快照并批量恢复实际进入路由索引的模型。
func (decorator *ModelManagement) recoverEffectiveModels(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	models []accountapp.AccountModel,
) error {
	for _, model := range models {
		if model.AccountRef() != accountRef {
			return ErrInvalidResult
		}
	}
	modelIDs, err := accountapp.EffectiveModelIDs(models)
	if err != nil {
		return ErrInvalidResult
	}
	if len(modelIDs) == 0 {
		return nil
	}
	if err := decorator.runtime.ClearModelBlocks(
		context.WithoutCancel(ctx),
		accountRef,
		modelIDs,
		runtimecore.RecoveryModelCatalog,
	); err != nil {
		return errors.Join(ErrRuntimeRecovery, err)
	}
	return nil
}

// validateRequest 在调用下游用例前拒绝无效身份。
func (decorator *ModelManagement) validateRequest(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) error {
	if decorator == nil ||
		decorator.next == nil ||
		decorator.runtime == nil ||
		ctx == nil ||
		!accountRef.IsValid() {
		return ErrInvalidRequest
	}
	return nil
}
