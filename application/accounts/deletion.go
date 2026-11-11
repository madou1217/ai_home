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
	// ErrAccountHostCleanupFailed 表示宿主清理通道不可用或拒绝执行。
	// 与 ErrAccountRuntimeActive 区分：这不是「有会话在跑」，而是「没问到/问不了」。
	ErrAccountHostCleanupFailed = errors.New("账号宿主清理失败")
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

// DeletionHostCleanup 在账号删除事务前后调用只有宿主进程具备的清理能力。
//
// 为什么需要它：Go 的删除事务只掌握 aih.db 与账号投影；tmux 持久会话、账号
// socket、桌面进程这些宿主资源只有 Node 有完整语义（matrix §5.3 的明确缺口）。
// Go 把它们收敛成一个可调用契约，而不是在 Go 里再写一套宿主枚举。
//
// 两段的语义必须分开：
//   - BeforeDelete 在提交前跑，失败即中止删除（账号事实还在，可原样重试）；
//   - AfterDelete 在提交后跑，实现必须幂等且不得重建账号；它的错误只用于诊断，
//     不能覆盖已经提交的删除事实。
type DeletionHostCleanup interface {
	BeforeDelete(ctx context.Context, account accountcore.Account) error
	AfterDelete(ctx context.Context, account accountcore.Account) error
}

// Deleter 编排账号持久化删除和提交后的派生状态清理。
type Deleter struct {
	store       DeletionStore
	guard       DeletionGuard
	prepare     DeletionPreparation
	hostCleanup DeletionHostCleanup
	cleanups    []DeletionCleanup
}

// NewDeleter 创建不装配宿主清理的账号删除用例。
func NewDeleter(
	store DeletionStore,
	guard DeletionGuard,
	preparation DeletionPreparation,
	cleanups ...DeletionCleanup,
) (*Deleter, error) {
	return NewDeleterWithHostCleanup(store, guard, preparation, nil, cleanups...)
}

// NewDeleterWithHostCleanup 在 NewDeleter 之上装配宿主清理通道。
//
// hostCleanup 允许为 nil：没有 Node 宿主的独立部署（或者测试）确实没有 tmux
// 与桌面资源可清，此时删除语义与 NewDeleter 完全一致。
func NewDeleterWithHostCleanup(
	store DeletionStore,
	guard DeletionGuard,
	preparation DeletionPreparation,
	hostCleanup DeletionHostCleanup,
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
		store:       store,
		guard:       guard,
		prepare:     preparation,
		hostCleanup: hostCleanup,
		cleanups:    append([]DeletionCleanup(nil), cleanups...),
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
	// 宿主写入者必须先停下：此刻账号事实还在，失败可以原样重试；
	// 反过来先删库再发现停不下进程，就只剩下攥着已删凭据的孤儿了。
	if deleter.hostCleanup != nil {
		if err := deleter.hostCleanup.BeforeDelete(ctx, account); err != nil {
			return err
		}
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
	if deleter.hostCleanup != nil {
		// 账号事实已经提交：这里的失败只能是「宿主残留没清干净」，不能返回错误
		// 让调用方以为删除失败（重试只会得到 404，还会把已删账号当成待处理对象）。
		// 用 WithoutCancel 保住清理机会：客户端断连不该让残留留在机器上。
		_ = deleter.hostCleanup.AfterDelete(context.WithoutCancel(ctx), account)
	}
	return nil
}
