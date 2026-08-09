package aihaccount

import (
	"context"
	"errors"
	"fmt"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var (
	// ErrInvalidAccountModelsRequest 表示账号模型操作缺少有效上下文或目标。
	ErrInvalidAccountModelsRequest = errors.New("AIH 账号模型读取请求无效")
	// ErrInvalidAccountModelsSnapshot 表示持久化端口返回了损坏或错位的模型关系。
	ErrInvalidAccountModelsSnapshot = errors.New("AIH 账号模型快照无效")
	// ErrInvalidAccountModelPolicyCommand 表示人工模型策略命令字段无效。
	ErrInvalidAccountModelPolicyCommand = errors.New("AIH 人工模型策略命令无效")
)

// AccountModelView 是 CLI 允许展示的单条无敏感模型关系。
type AccountModelView struct {
	ModelID           string
	UpstreamAvailable bool
	ManualPolicy      string
	Effective         bool
	UpdatedAt         time.Time
}

// AccountModelsResult 是一个稳定账号身份及其完整物化模型快照。
type AccountModelsResult struct {
	AccountRef string
	Models     []AccountModelView
}

// AccountModelPolicyCommand 是一个账号、模型和人工策略的规范写命令。
type AccountModelPolicyCommand struct {
	Target       AccountTarget
	ModelID      string
	ManualPolicy string
}

// ParseAccountModelPolicyCommand 在打开数据库前校验人工策略命令全部字段。
func ParseAccountModelPolicyCommand(
	targetValue string,
	modelValue string,
	policyValue string,
) (AccountModelPolicyCommand, error) {
	target, targetErr := ParseAccountTarget(targetValue)
	modelID, modelErr := runtimecore.NewModelID(modelValue)
	policy, policyErr := accountapp.ParseModelManualPolicy(policyValue)
	if targetErr != nil || modelErr != nil || policyErr != nil {
		return AccountModelPolicyCommand{}, ErrInvalidAccountModelPolicyCommand
	}
	return AccountModelPolicyCommand{
		Target:       target,
		ModelID:      modelID.String(),
		ManualPolicy: policy.String(),
	}, nil
}

// isValid 复核命令没有绕过构造函数或在传递中被改写。
func (command AccountModelPolicyCommand) isValid() bool {
	if !command.Target.isValid() {
		return false
	}
	modelID, modelErr := runtimecore.NewModelID(command.ModelID)
	policy, policyErr := accountapp.ParseModelManualPolicy(command.ManualPolicy)
	return modelErr == nil &&
		policyErr == nil &&
		modelID.String() == command.ModelID &&
		policy.String() == command.ManualPolicy
}

// ListAccountModels 按稳定身份或 Provider 数字别名读取本地物化模型。
func (app *App) ListAccountModels(
	ctx context.Context,
	target AccountTarget,
) (AccountModelsResult, error) {
	if app == nil {
		return AccountModelsResult{}, ErrInvalidAccountModelsRequest
	}
	return app.runAccountModelsOperation(
		ctx,
		target,
		app.accounts.ListAccountModels,
	)
}

// RefreshAccountModels 使用当前账号凭据刷新完整目录并返回新物化快照。
func (app *App) RefreshAccountModels(
	ctx context.Context,
	target AccountTarget,
) (AccountModelsResult, error) {
	if app == nil {
		return AccountModelsResult{}, ErrInvalidAccountModelsRequest
	}
	return app.runAccountModelsOperation(
		ctx,
		target,
		app.models.RefreshAccountModels,
	)
}

// SetAccountModelPolicy 原子设置一个模型的人工策略并返回完整新快照。
func (app *App) SetAccountModelPolicy(
	ctx context.Context,
	command AccountModelPolicyCommand,
) (AccountModelsResult, error) {
	if app == nil || !command.isValid() {
		return AccountModelsResult{}, ErrInvalidAccountModelPolicyCommand
	}
	policy, err := accountapp.ParseModelManualPolicy(command.ManualPolicy)
	if err != nil {
		return AccountModelsResult{}, ErrInvalidAccountModelPolicyCommand
	}
	return app.runAccountModelsOperation(
		ctx,
		command.Target,
		func(
			operationCtx context.Context,
			accountRef accountcore.AccountRef,
		) ([]accountapp.AccountModel, error) {
			return app.models.SetManualModelPolicy(
				operationCtx,
				accountRef,
				command.ModelID,
				policy,
			)
		},
	)
}

// accountModelsOperation 是查询与刷新共享的账号模型最小操作签名。
type accountModelsOperation func(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) ([]accountapp.AccountModel, error)

// runAccountModelsOperation 统一解析身份、校验快照和构造公开结果。
func (app *App) runAccountModelsOperation(
	ctx context.Context,
	target AccountTarget,
	operation accountModelsOperation,
) (AccountModelsResult, error) {
	if app == nil || ctx == nil || !target.isValid() {
		return AccountModelsResult{}, ErrInvalidAccountModelsRequest
	}
	if operation == nil {
		return AccountModelsResult{}, ErrInvalidAccountModelsRequest
	}
	if err := ctx.Err(); err != nil {
		return AccountModelsResult{}, err
	}
	accountRef, err := app.resolveAccountTarget(ctx, target)
	if errors.Is(err, ErrInvalidShowRequest) {
		return AccountModelsResult{}, ErrInvalidAccountModelsRequest
	}
	if err != nil {
		return AccountModelsResult{}, fmt.Errorf("解析账号模型目标失败: %w", err)
	}
	models, err := operation(ctx, accountRef)
	if err != nil {
		return AccountModelsResult{}, fmt.Errorf("执行账号模型操作失败: %w", err)
	}
	views, err := newAccountModelViews(accountRef.String(), models)
	if err != nil {
		return AccountModelsResult{}, err
	}
	return AccountModelsResult{
		AccountRef: accountRef.String(),
		Models:     views,
	}, nil
}

// newAccountModelViews 校验身份和稳定排序后构造 CLI 公开投影。
func newAccountModelViews(
	accountRef string,
	models []accountapp.AccountModel,
) ([]AccountModelView, error) {
	views := make([]AccountModelView, 0, len(models))
	previousModelID := ""
	for _, model := range models {
		modelID := model.ModelID().String()
		if !model.IsValid() ||
			model.AccountRef().String() != accountRef ||
			previousModelID != "" && modelID <= previousModelID {
			return nil, ErrInvalidAccountModelsSnapshot
		}
		views = append(views, AccountModelView{
			ModelID:           modelID,
			UpstreamAvailable: model.UpstreamAvailable(),
			ManualPolicy:      model.ManualPolicy().String(),
			Effective:         model.Effective(),
			UpdatedAt:         model.UpdatedAt(),
		})
		previousModelID = modelID
	}
	return views, nil
}
