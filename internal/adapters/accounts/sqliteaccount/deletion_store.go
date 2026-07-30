package sqliteaccount

import (
	"context"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var _ accountapp.DeletionStore = (*Store)(nil)

// DeleteAccount 删除账号主记录，并依靠外键级联清理凭据、资料、模型和额度。
func (store *Store) DeleteAccount(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) error {
	if store == nil ||
		store.db == nil ||
		store.routes == nil ||
		ctx == nil ||
		!accountRef.IsValid() {
		return accountapp.ErrInvalidDeletionRequest
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	store.routingWrites.Lock()
	defer store.routingWrites.Unlock()
	result, err := store.db.ExecContext(
		ctx,
		"DELETE FROM accounts WHERE account_ref = ?",
		accountRef.String(),
	)
	if err != nil {
		return fmt.Errorf("删除账号记录失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("读取账号删除结果失败: %w", err)
	}
	switch affected {
	case 0:
		return accountapp.ErrAccountNotFound
	case 1:
		store.routes.deleteAccount(accountRef)
		return nil
	default:
		return ErrIncompatibleDatabase
	}
}
