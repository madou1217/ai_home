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
)

// DeletionStore 是账号删除用例需要的最小持久化端口。
type DeletionStore interface {
	// DeleteAccount 删除账号主记录及其持久化从属数据。
	DeleteAccount(
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
	cleanups []DeletionCleanup
}

// NewDeleter 创建依赖完整的账号删除用例。
func NewDeleter(
	store DeletionStore,
	cleanups ...DeletionCleanup,
) (*Deleter, error) {
	if store == nil || len(cleanups) == 0 {
		return nil, ErrInvalidDeletionDependencies
	}
	for _, cleanup := range cleanups {
		if cleanup == nil {
			return nil, ErrInvalidDeletionDependencies
		}
	}
	return &Deleter{
		store:    store,
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
		len(deleter.cleanups) == 0 ||
		ctx == nil ||
		!accountRef.IsValid() {
		return ErrInvalidDeletionRequest
	}
	if err := ctx.Err(); err != nil {
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
