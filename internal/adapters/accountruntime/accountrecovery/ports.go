// Package accountrecovery 在账号写事务成功后同步恢复进程内运行态。
//
// 该适配层不参与数据库事务，也不读取凭据内容；它只把应用用例的成功结果
// 转换为低敏账号或模型恢复事件。
package accountrecovery

import (
	"context"
	"errors"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var (
	// ErrInvalidDependencies 表示 Decorator 缺少下游用例或运行态恢复端口。
	ErrInvalidDependencies = errors.New("账号运行态恢复依赖无效")
	// ErrInvalidRequest 表示上下文或账号身份无效。
	ErrInvalidRequest = errors.New("账号运行态恢复请求无效")
	// ErrInvalidResult 表示下游成功结果违反账号或模型快照合同。
	ErrInvalidResult = errors.New("账号运行态恢复结果无效")
	// ErrRuntimeRecovery 表示持久化成功后的进程内恢复没有完成。
	ErrRuntimeRecovery = errors.New("账号运行态恢复失败")
)

// Runtime 提供事务后恢复所需的两个最小批量端口。
type Runtime interface {
	// ClearAccountBlock 精确清除账号级恢复位。
	ClearAccountBlock(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		trigger runtimecore.RecoveryTrigger,
	) error
	// ClearModelBlocks 在一次批次中清除多个账号模型恢复位。
	ClearModelBlocks(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		modelIDs []runtimecore.ModelID,
		trigger runtimecore.RecoveryTrigger,
	) error
}

// ReauthenticationService 是已有账号重登用例的最小端口。
type ReauthenticationService interface {
	// ValidateTarget 在 OAuth 开始前复核目标账号和 Provider。
	ValidateTarget(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		providerID string,
	) error
	// Reauthenticate 原子替换同一账号的凭据、资料和模型目录。
	Reauthenticate(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		credential accountapp.Credential,
		profile accountapp.PublicProfile,
	) (accountcore.Account, error)
}

// ModelManagementService 是账号模型查询和写入的最小端口。
type ModelManagementService interface {
	// ListAccountModels 返回当前完整账号模型快照。
	ListAccountModels(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) ([]accountapp.AccountModel, error)
	// RefreshAccountModels 全量替换远端发现部分并返回完整快照。
	RefreshAccountModels(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) ([]accountapp.AccountModel, error)
	// SetManualModelPolicy 原子更新人工覆盖并返回完整快照。
	SetManualModelPolicy(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		modelID string,
		policy accountapp.ModelManualPolicy,
	) ([]accountapp.AccountModel, error)
}
