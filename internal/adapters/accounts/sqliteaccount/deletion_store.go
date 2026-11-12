package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

var _ accountapp.DeletionStore = (*Store)(nil)

// DeleteAccount 在同一事务中写删除墓碑，再删除账号主记录（外键级联清理从属数据）。
//
// 墓碑必须在删除前写：Node 的旧实现放在 app_kv，Go 自有库用 account_tombstones；
// 没有它，宿主扫描/导入会把用户已删的账号重新登记回来。
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
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开始删除账号事务失败: %w", err)
	}
	defer func() {
		_ = transaction.Rollback()
	}()

	var providerID string
	var authKind, authMode, payload sql.NullString
	err = transaction.QueryRowContext(
		ctx,
		`SELECT a.provider_id, c.auth_kind, c.auth_mode, c.credential_json
		   FROM accounts a
		   LEFT JOIN account_credentials c ON c.account_ref = a.account_ref
		  WHERE a.account_ref = ?
		  LIMIT 1`,
		accountRef.String(),
	).Scan(&providerID, &authKind, &authMode, &payload)
	if errors.Is(err, sql.ErrNoRows) {
		return accountapp.ErrAccountNotFound
	}
	if err != nil {
		return fmt.Errorf("读取待删除账号失败: %w", err)
	}

	var credential any
	if authKind.Valid && payload.Valid {
		decoded, decodeErr := store.credentials.Decode(
			providerID,
			authKind.String,
			authMode.String,
			[]byte(payload.String),
		)
		if decodeErr == nil {
			credential = decoded
		}
	}
	if err := writeDeleteTombstones(
		ctx,
		transaction,
		accountRef.String(),
		providerID,
		credential,
		time.Now().UnixMilli(),
	); err != nil {
		return err
	}

	result, err := transaction.ExecContext(
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
	default:
		return ErrIncompatibleDatabase
	}
	// 显式删除凭据，不只依赖外键级联：级联要求连接上 foreign_keys=ON，
	// 而凭据是敏感数据，任何 PRAGMA 配置异常都不应该让它在删号后留下来。
	if _, err := transaction.ExecContext(
		ctx,
		"DELETE FROM account_credentials WHERE account_ref = ?",
		accountRef.String(),
	); err != nil {
		return fmt.Errorf("删除账号凭据失败: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("提交删除账号事务失败: %w", err)
	}
	store.routes.deleteAccount(accountRef)
	return nil
}
