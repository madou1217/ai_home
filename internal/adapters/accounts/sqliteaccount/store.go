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

const maxLifecycleUpdateAttempts = 4

// routingCandidatesSQL 是账号征召热路径及其查询计划验证的单一 SQL 合同。
const routingCandidatesSQL = `
	SELECT account_ref, cli_account_id
	FROM accounts
	WHERE provider_id = ?
	  AND enabled = 1
	  AND account_ref > ?
	ORDER BY account_ref
	LIMIT ?`

var _ accountapp.Store = (*Store)(nil)

// Create 创建一个不含凭据的基础账号，适用于尚未完成认证的账号生命周期。
func (store *Store) Create(ctx context.Context, account accountcore.Account) error {
	if !store.acceptsAccount(account) {
		return accountcore.ErrInvalidAccount
	}
	const statement = `
		INSERT INTO accounts (
			account_ref, provider_id, cli_account_id, enabled,
			created_at_ms, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, ?)`
	_, err := store.db.ExecContext(ctx, statement, accountRowArguments(account)...)
	return mapAccountWriteError(err)
}

// GetByRef 按稳定账号身份读取基础账号快照。
func (store *Store) GetByRef(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountcore.Account, error) {
	if !accountRef.IsValid() {
		return accountcore.Account{}, accountcore.ErrInvalidAccountRef
	}
	const query = `
		SELECT account_ref, provider_id, cli_account_id, enabled,
		       created_at_ms, updated_at_ms
		FROM accounts
		WHERE account_ref = ?
		LIMIT 1`
	return store.scanAccount(store.db.QueryRowContext(ctx, query, accountRef.String()))
}

// GetByCLIAccountID 按 Provider 内 CLI 数字别名读取基础账号快照。
func (store *Store) GetByCLIAccountID(
	ctx context.Context,
	providerID string,
	cliAccountID accountcore.CLIAccountID,
) (accountcore.Account, error) {
	canonicalProviderID, found := store.catalog.CanonicalID(providerID)
	if !found || !cliAccountID.IsValid() {
		return accountcore.Account{}, accountcore.ErrInvalidAccount
	}
	const query = `
		SELECT account_ref, provider_id, cli_account_id, enabled,
		       created_at_ms, updated_at_ms
		FROM accounts
		WHERE provider_id = ? AND cli_account_id = ?
		LIMIT 1`
	return store.scanAccount(store.db.QueryRowContext(
		ctx,
		query,
		canonicalProviderID,
		cliAccountID.Int64(),
	))
}

// SetEnabled 使用 compare-and-swap 原子更新用户启停状态。
func (store *Store) SetEnabled(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	enabled bool,
	changedAt time.Time,
) (accountcore.Account, error) {
	for range maxLifecycleUpdateAttempts {
		current, err := store.GetByRef(ctx, accountRef)
		if err != nil {
			return accountcore.Account{}, err
		}
		updated, err := current.WithEnabled(enabled, changedAt)
		if err != nil || updated == current {
			return updated, err
		}
		saved, err := store.compareAndSwapAccount(ctx, current, updated)
		if err != nil {
			return accountcore.Account{}, err
		}
		if saved {
			return updated, nil
		}
	}
	return accountcore.Account{}, accountapp.ErrAccountConflict
}

// ListRoutingCandidates 使用 covering index 返回紧凑账号征召投影。
func (store *Store) ListRoutingCandidates(
	ctx context.Context,
	query accountapp.RoutingQuery,
) ([]accountapp.RoutingAccount, error) {
	rows, err := store.db.QueryContext(
		ctx,
		routingCandidatesSQL,
		query.ProviderID(),
		query.AfterRef().String(),
		query.Limit(),
	)
	if err != nil {
		return nil, fmt.Errorf("查询账号征召投影失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()

	candidates := make([]accountapp.RoutingAccount, 0, query.Limit())
	for rows.Next() {
		candidate, err := store.scanRoutingAccount(rows, query.ProviderID())
		if err != nil {
			return nil, err
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历账号征召投影失败: %w", err)
	}
	return candidates, nil
}

// acceptsAccount 校验账号快照和当前 Provider 注册表。
func (store *Store) acceptsAccount(account accountcore.Account) bool {
	return store != nil &&
		store.db != nil &&
		store.catalog != nil &&
		account.IsValid() &&
		store.catalog.Contains(account.ProviderID())
}

// accountRowArguments 返回基础账号插入参数。
func accountRowArguments(account accountcore.Account) []any {
	return []any{
		account.Ref().String(),
		account.ProviderID(),
		account.CLIAccountID().Int64(),
		account.Enabled(),
		account.CreatedAt().UnixMilli(),
		account.UpdatedAt().UnixMilli(),
	}
}

// scanAccount 校验数据库行并恢复领域账号快照。
func (store *Store) scanAccount(row rowScanner) (accountcore.Account, error) {
	var record accountRecord
	if err := row.Scan(
		&record.accountRef,
		&record.providerID,
		&record.cliAccountID,
		&record.enabled,
		&record.createdAtMS,
		&record.updatedAtMS,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return accountcore.Account{}, accountapp.ErrAccountNotFound
		}
		return accountcore.Account{}, fmt.Errorf("读取账号记录失败: %w", err)
	}
	return store.restoreAccount(record)
}

// restoreAccount 校验已扫描的基础账号字段并恢复领域快照。
func (store *Store) restoreAccount(record accountRecord) (accountcore.Account, error) {
	accountRef, err := accountcore.ParseAccountRef(record.accountRef)
	if err != nil {
		return accountcore.Account{}, ErrIncompatibleDatabase
	}
	alias, err := accountcore.NewCLIAccountID(record.cliAccountID)
	if err != nil {
		return accountcore.Account{}, ErrIncompatibleDatabase
	}
	account, err := accountcore.RestoreAccount(store.catalog, accountcore.RestoreAccountInput{
		Ref:          accountRef,
		ProviderID:   record.providerID,
		CLIAccountID: alias,
		Enabled:      record.enabled,
		CreatedAt:    time.UnixMilli(record.createdAtMS).UTC(),
		UpdatedAt:    time.UnixMilli(record.updatedAtMS).UTC(),
	})
	if err != nil {
		return accountcore.Account{}, fmt.Errorf("%w: account snapshot", ErrIncompatibleDatabase)
	}
	return account, nil
}

// scanRoutingAccount 校验紧凑征召查询返回的数据库行。
func (store *Store) scanRoutingAccount(
	row rowScanner,
	providerID string,
) (accountapp.RoutingAccount, error) {
	var accountRefText string
	var cliAccountID int64
	if err := row.Scan(&accountRefText, &cliAccountID); err != nil {
		return accountapp.RoutingAccount{}, fmt.Errorf("读取账号征召投影失败: %w", err)
	}
	accountRef, refErr := accountcore.ParseAccountRef(accountRefText)
	alias, aliasErr := accountcore.NewCLIAccountID(cliAccountID)
	if refErr != nil || aliasErr != nil {
		return accountapp.RoutingAccount{}, ErrIncompatibleDatabase
	}
	account, err := accountapp.NewRoutingAccount(store.catalog, accountapp.RoutingAccountInput{
		Ref:          accountRef,
		ProviderID:   providerID,
		CLIAccountID: alias,
	})
	if err != nil {
		return accountapp.RoutingAccount{}, ErrIncompatibleDatabase
	}
	return account, nil
}

// compareAndSwapAccount 只在账号版本未变化时写入新生命周期。
func (store *Store) compareAndSwapAccount(
	ctx context.Context,
	current accountcore.Account,
	updated accountcore.Account,
) (bool, error) {
	const statement = `
		UPDATE accounts
		SET enabled = ?, updated_at_ms = ?
		WHERE account_ref = ? AND updated_at_ms = ?`
	result, err := store.db.ExecContext(
		ctx,
		statement,
		updated.Enabled(),
		updated.UpdatedAt().UnixMilli(),
		updated.Ref().String(),
		current.UpdatedAt().UnixMilli(),
	)
	if err != nil {
		return false, fmt.Errorf("更新账号启停状态失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("读取账号更新结果失败: %w", err)
	}
	return affected == 1, nil
}

// mapAccountWriteError 把 SQLite 约束错误映射为稳定应用错误。
func mapAccountWriteError(err error) error {
	if err == nil {
		return nil
	}
	if isConstraintError(err) {
		return accountapp.ErrAccountConflict
	}
	return fmt.Errorf("写入账号记录失败: %w", err)
}

// rowScanner 统一 sql.Row 与 sql.Rows 的字段扫描能力。
type rowScanner interface {
	Scan(dest ...any) error
}

// accountRecord 是 SQLite 基础账号行的内部扫描结构。
type accountRecord struct {
	accountRef   string
	providerID   string
	cliAccountID int64
	enabled      bool
	createdAtMS  int64
	updatedAtMS  int64
}
