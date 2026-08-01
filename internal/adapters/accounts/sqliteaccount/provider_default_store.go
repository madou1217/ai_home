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

var _ accountapp.ProviderDefaultStore = (*Store)(nil)

// providerDefaultQuery 同时校验默认关系仍指向同 Provider、已启用且有凭据的账号。
const providerDefaultQuery = `
	SELECT d.provider_id, d.account_ref, d.updated_at_ms,
	       a.provider_id, a.enabled,
	       CASE WHEN c.account_ref IS NULL THEN 0 ELSE 1 END
	FROM account_defaults AS d
	JOIN accounts AS a ON a.account_ref = d.account_ref
	LEFT JOIN account_credentials AS c ON c.account_ref = a.account_ref
	WHERE d.provider_id = ?
	LIMIT 1`

// providerDefaultTargetQuery 读取设置默认关系所需的账号归属、启停和凭据状态。
const providerDefaultTargetQuery = `
	SELECT a.provider_id, a.enabled,
	       CASE WHEN c.account_ref IS NULL THEN 0 ELSE 1 END
	FROM accounts AS a
	LEFT JOIN account_credentials AS c ON c.account_ref = a.account_ref
	WHERE a.account_ref = ?
	LIMIT 1`

// GetProviderDefault 点查指定 Provider 当前默认启动账号，不读取凭据正文。
func (store *Store) GetProviderDefault(
	ctx context.Context,
	providerID string,
) (accountcore.ProviderDefault, error) {
	if err := store.validateProviderDefaultRequest(ctx, providerID); err != nil {
		return accountcore.ProviderDefault{}, err
	}
	return store.scanProviderDefault(store.db.QueryRowContext(
		ctx,
		providerDefaultQuery,
		providerID,
	))
}

// SetProviderDefault 在立即事务中校验目标账号并原子替换 Provider 唯一默认关系。
func (store *Store) SetProviderDefault(
	ctx context.Context,
	providerDefault accountcore.ProviderDefault,
) (result accountcore.ProviderDefault, resultErr error) {
	if store == nil ||
		store.db == nil ||
		ctx == nil ||
		!providerDefault.IsValid() {
		return accountcore.ProviderDefault{}, accountapp.ErrInvalidProviderDefault
	}
	if err := store.validateProviderDefaultRequest(
		ctx,
		providerDefault.ProviderID(),
	); err != nil {
		return accountcore.ProviderDefault{}, err
	}

	connection, err := store.db.Conn(ctx)
	if err != nil {
		return accountcore.ProviderDefault{}, fmt.Errorf("获取默认账号写入连接失败: %w", err)
	}
	defer func() {
		_ = connection.Close()
	}()
	if _, err := connection.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		if isBusyError(err) {
			return accountcore.ProviderDefault{}, accountapp.ErrProviderDefaultConflict
		}
		return accountcore.ProviderDefault{}, fmt.Errorf("开始默认账号写入事务失败: %w", err)
	}
	defer func() {
		if resultErr != nil {
			_, _ = connection.ExecContext(context.WithoutCancel(ctx), "ROLLBACK")
		}
	}()

	if err := store.validateProviderDefaultTarget(
		ctx,
		connection,
		providerDefault,
	); err != nil {
		return accountcore.ProviderDefault{}, err
	}
	current, err := store.scanProviderDefault(connection.QueryRowContext(
		ctx,
		providerDefaultQuery,
		providerDefault.ProviderID(),
	))
	if err == nil && current.AccountRef() == providerDefault.AccountRef() {
		if err := commitProviderDefault(ctx, connection); err != nil {
			return accountcore.ProviderDefault{}, err
		}
		return current, nil
	}
	if err != nil && !errors.Is(err, accountapp.ErrProviderDefaultNotFound) {
		return accountcore.ProviderDefault{}, err
	}
	if err == nil && providerDefault.UpdatedAt().Before(current.UpdatedAt()) {
		return accountcore.ProviderDefault{}, accountapp.ErrProviderDefaultConflict
	}

	const statement = `
		INSERT INTO account_defaults (provider_id, account_ref, updated_at_ms)
		VALUES (?, ?, ?)
		ON CONFLICT(provider_id) DO UPDATE SET
			account_ref = excluded.account_ref,
			updated_at_ms = excluded.updated_at_ms`
	if _, err := connection.ExecContext(
		ctx,
		statement,
		providerDefault.ProviderID(),
		providerDefault.AccountRef().String(),
		providerDefault.UpdatedAt().UnixMilli(),
	); err != nil {
		if isBusyError(err) || isConstraintError(err) {
			return accountcore.ProviderDefault{}, accountapp.ErrProviderDefaultConflict
		}
		return accountcore.ProviderDefault{}, fmt.Errorf("写入默认账号关系失败: %w", err)
	}
	if err := commitProviderDefault(ctx, connection); err != nil {
		return accountcore.ProviderDefault{}, err
	}
	return providerDefault, nil
}

// ClearProviderDefault 幂等删除指定 Provider 的默认启动账号关系。
func (store *Store) ClearProviderDefault(
	ctx context.Context,
	providerID string,
) error {
	if err := store.validateProviderDefaultRequest(ctx, providerID); err != nil {
		return err
	}
	_, err := store.db.ExecContext(
		ctx,
		"DELETE FROM account_defaults WHERE provider_id = ?",
		providerID,
	)
	if isBusyError(err) {
		return accountapp.ErrProviderDefaultConflict
	}
	if err != nil {
		return fmt.Errorf("清除默认账号关系失败: %w", err)
	}
	return nil
}

// validateProviderDefaultTarget 在写事务内拒绝跨 Provider、停用或未配置凭据的账号。
func (store *Store) validateProviderDefaultTarget(
	ctx context.Context,
	connection *sql.Conn,
	providerDefault accountcore.ProviderDefault,
) error {
	var providerID string
	var enabled, hasCredential int
	err := connection.QueryRowContext(
		ctx,
		providerDefaultTargetQuery,
		providerDefault.AccountRef().String(),
	).Scan(&providerID, &enabled, &hasCredential)
	if errors.Is(err, sql.ErrNoRows) {
		return accountapp.ErrAccountNotFound
	}
	if err != nil {
		return fmt.Errorf("读取默认账号目标失败: %w", err)
	}
	if providerID != providerDefault.ProviderID() {
		return accountapp.ErrProviderDefaultMismatch
	}
	if enabled != 1 {
		return accountapp.ErrProviderDefaultDisabled
	}
	if hasCredential != 1 {
		return accountapp.ErrProviderDefaultUnconfigured
	}
	return nil
}

// scanProviderDefault 恢复并校验持久化默认关系及其目标账号不变量。
func (store *Store) scanProviderDefault(
	row rowScanner,
) (accountcore.ProviderDefault, error) {
	var providerID, accountRefText, accountProviderID string
	var updatedAtMS int64
	var enabled, hasCredential int
	if err := row.Scan(
		&providerID,
		&accountRefText,
		&updatedAtMS,
		&accountProviderID,
		&enabled,
		&hasCredential,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return accountcore.ProviderDefault{}, accountapp.ErrProviderDefaultNotFound
		}
		return accountcore.ProviderDefault{}, fmt.Errorf("读取默认账号关系失败: %w", err)
	}
	accountRef, err := accountcore.ParseAccountRef(accountRefText)
	if err != nil ||
		providerID != accountProviderID ||
		enabled != 1 ||
		hasCredential != 1 {
		return accountcore.ProviderDefault{}, ErrIncompatibleDatabase
	}
	providerDefault, err := accountcore.RestoreProviderDefault(
		providerID,
		accountRef,
		time.UnixMilli(updatedAtMS).UTC(),
	)
	if err != nil {
		return accountcore.ProviderDefault{}, ErrIncompatibleDatabase
	}
	return providerDefault, nil
}

// validateProviderDefaultRequest 校验上下文和 Catalog 中的规范 Provider ID。
func (store *Store) validateProviderDefaultRequest(
	ctx context.Context,
	providerID string,
) error {
	if store == nil || store.db == nil || store.catalog == nil || ctx == nil {
		return accountapp.ErrInvalidProviderDefault
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	canonicalProviderID, found := store.catalog.CanonicalID(providerID)
	if !found || canonicalProviderID != providerID {
		return accountapp.ErrInvalidProviderDefault
	}
	return nil
}

// commitProviderDefault 提交默认关系事务并统一冲突语义。
func commitProviderDefault(ctx context.Context, connection *sql.Conn) error {
	if _, err := connection.ExecContext(ctx, "COMMIT"); err != nil {
		if isBusyError(err) || isConstraintError(err) {
			return accountapp.ErrProviderDefaultConflict
		}
		return fmt.Errorf("提交默认账号关系失败: %w", err)
	}
	return nil
}
