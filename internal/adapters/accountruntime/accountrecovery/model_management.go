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

// RefreshAccountModels 在完整目录事务成功后恢复其中的有效模型。
func (decorator *ModelManagement) RefreshAccountModels(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) ([]accountapp.AccountModel, error) {
	if err := decorator.validateRequest(ctx, accountRef); err != nil {
		return nil, err
	}
	models, err := decorator.next.RefreshAccountModels(ctx, accountRef)
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
