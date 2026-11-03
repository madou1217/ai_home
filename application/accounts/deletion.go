package accounts

import (
	"context"
	"errors"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var (
	// ErrInvalidDeletionDependencies 表示删除用例缺少持久化或派生状态清理端口。
	ErrInvalidDeletionDependencies = errors.New("账号删除依赖无效")
	// ErrInvalidDeletionRequest 表示删除上下文或稳定账号身份无效。
	ErrInvalidDeletionRequest = errors.New("账号删除请求无效")
	// ErrAccountRuntimeActive 表示精确持久会话仍在使用目标账号。
	ErrAccountRuntimeActive = errors.New("账号存在活跃运行时")
	// ErrAccountRuntimeUnverifiable 表示存在会话登记但无法可靠确认写入者已经退出。
	ErrAccountRuntimeUnverifiable = errors.New("账号运行时状态无法确认")
	// ErrAccountDeletionPreparationFailed 表示 Provider 资源或敏感投影无法安全收敛。
	ErrAccountDeletionPreparationFailed = errors.New("账号删除前资源无法安全收敛")
)

// DeletionStore 是账号删除用例需要的最小持久化端口。
type DeletionStore interface {
	// GetByRef 读取删除准备阶段需要的稳定 Provider 身份。
	GetByRef(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountcore.Account, error)
	// DeleteAccount 删除账号主记录及其持久化从属数据。
	DeleteAccount(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) error
}

// DeletionPreparation 在账号事实仍可读取时收敛 Provider 资源并清理敏感凭据投影。
//
// 实现必须幂等；任何不能证明安全完成的情况都应返回错误，使数据库删除失败关闭。
type DeletionPreparation interface {
	PrepareAccountDeletion(
		ctx context.Context,
		account accountcore.Account,
	) error
}

// DeletionGuard 在数据库写入前确认没有运行时仍持有目标账号。
type DeletionGuard interface {
	AssertAccountDeletable(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) error
}

// DeletionCleanup 遗忘删除账号派生出的非持久化状态。
//
// 实现必须幂等且不失败，避免账号事实已提交后返回伪失败。
type DeletionCleanup interface {
	ForgetAccount(accountRef accountcore.AccountRef)
}

// Deleter 编排账号持久化删除和提交后的派生状态清理。
type Deleter struct {
	store    DeletionStore
	guard    DeletionGuard
	prepare  DeletionPreparation
	cleanups []DeletionCleanup
}

// NewDeleter 创建依赖完整的账号删除用例。
func NewDeleter(
	store DeletionStore,
	guard DeletionGuard,
	preparation DeletionPreparation,
	cleanups ...DeletionCleanup,
) (*Deleter, error) {
	if store == nil || guard == nil || preparation == nil || len(cleanups) == 0 {
		return nil, ErrInvalidDeletionDependencies
	}
	for _, cleanup := range cleanups {
		if cleanup == nil {
			return nil, ErrInvalidDeletionDependencies
		}
	}
	return &Deleter{
		store:    store,
		guard:    guard,
		prepare:  preparation,
		cleanups: append([]DeletionCleanup(nil), cleanups...),
	}, nil
}

// DeleteAccount 先提交唯一持久化事实，再按组合顺序遗忘内存派生状态。
func (deleter *Deleter) DeleteAccount(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) error {
	if deleter == nil ||
		deleter.store == nil ||
		deleter.guard == nil ||
		deleter.prepare == nil ||
		len(deleter.cleanups) == 0 ||
		ctx == nil ||
		!accountRef.IsValid() {
		return ErrInvalidDeletionRequest
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := deleter.guard.AssertAccountDeletable(ctx, accountRef); err != nil {
		return err
	}
	account, err := deleter.store.GetByRef(ctx, accountRef)
	if err != nil {
		return err
	}
	if !account.IsValid() || account.Ref() != accountRef {
		return ErrInvalidDeletionRequest
	}
	if err := deleter.prepare.PrepareAccountDeletion(ctx, account); err != nil {
		return err
	}
	if err := deleter.store.DeleteAccount(ctx, accountRef); err != nil {
		return err
	}
	for _, cleanup := range deleter.cleanups {
		cleanup.ForgetAccount(accountRef)
	}
	return nil
}
