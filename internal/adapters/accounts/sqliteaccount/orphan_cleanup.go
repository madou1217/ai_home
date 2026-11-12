package sqliteaccount

import (
	"context"
	"fmt"
)

// DeleteOrphanCredentials 删除没有账号主记录的凭据行，返回删除行数。
//
// account_credentials 的级联删除依赖连接上的 foreign_keys=ON；历史库、外部工具
// 或异常中断都可能留下没有 accounts 行的凭据。删除账号本身由级联负责，这里作为
// 启动自愈兜底，避免孤儿凭据长期滞留（凭据是敏感数据，不应留在库里）。
func (store *Store) DeleteOrphanCredentials(ctx context.Context) (int64, error) {
	if store == nil || store.db == nil || ctx == nil {
		return 0, ErrInvalidOpenOptions
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	result, err := store.db.ExecContext(
		ctx,
		`DELETE FROM account_credentials
		  WHERE NOT EXISTS (
		    SELECT 1 FROM accounts WHERE accounts.account_ref = account_credentials.account_ref
		  )`,
	)
	if err != nil {
		return 0, fmt.Errorf("清理孤儿凭据失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("读取孤儿凭据清理结果失败: %w", err)
	}
	return affected, nil
}
