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

// accountOverviewSelectSQL 集中定义账号管理查询允许读取的公开标量。
//
// 账号管理查询禁止选择 credential_json 或 profile_json。
const accountOverviewSelectSQL = `
	SELECT a.account_ref, a.provider_id, a.cli_account_id, a.enabled,
	       a.created_at_ms, a.updated_at_ms,
	       c.account_ref IS NOT NULL,
	       COALESCE(c.auth_kind, ''), COALESCE(c.auth_mode, ''),
	       p.account_ref IS NOT NULL,
	       COALESCE(p.display_name, ''), COALESCE(p.email, ''),
	       COALESCE(p.subscription_kind, ''), COALESCE(p.subscription_raw, ''),
	       COALESCE(p.updated_at_ms, 0)
	FROM accounts AS a
	LEFT JOIN account_credentials AS c ON c.account_ref = a.account_ref
	LEFT JOIN account_profiles AS p ON p.account_ref = a.account_ref`

// accountOverviewSQL 是账号管理列表及查询计划验证的 keyset SQL 合同。
const accountOverviewSQL = accountOverviewSelectSQL + `
	WHERE a.account_ref > ?
	ORDER BY a.account_ref
	LIMIT ?`

// accountOverviewByRefSQL 是账号管理详情使用的主键点查 SQL 合同。
const accountOverviewByRefSQL = accountOverviewSelectSQL + `
	WHERE a.account_ref = ?
	LIMIT 1`

// accountOverviewByAliasSQL 使用账号表唯一索引点查 Provider 内数字别名。
const accountOverviewByAliasSQL = accountOverviewSelectSQL + `
	WHERE a.provider_id = ? AND a.cli_account_id = ?
	LIMIT 1`

var _ accountapp.AccountOverviewStore = (*Store)(nil)

// ListAccountOverviews 使用 keyset pagination 返回无敏感数据的账号管理投影。
func (store *Store) ListAccountOverviews(
	ctx context.Context,
	query accountapp.OverviewQuery,
) ([]accountapp.AccountOverview, error) {
	if !query.IsValid() {
		return nil, accountapp.ErrInvalidOverview
	}
	rows, err := store.db.QueryContext(
		ctx,
		accountOverviewSQL,
		query.AfterRef().String(),
		query.Limit(),
	)
	if err != nil {
		return nil, fmt.Errorf("查询账号管理投影失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()

	overviews := make([]accountapp.AccountOverview, 0, query.Limit())
	for rows.Next() {
		overview, err := store.scanAccountOverview(rows)
		if err != nil {
			return nil, err
		}
		overviews = append(overviews, overview)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历账号管理投影失败: %w", err)
	}
	return overviews, nil
}

// GetAccountOverview 按稳定账号身份读取无敏感数据的账号管理投影。
func (store *Store) GetAccountOverview(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.AccountOverview, error) {
	if !accountRef.IsValid() {
		return accountapp.AccountOverview{}, accountcore.ErrInvalidAccountRef
	}
	return store.scanAccountOverview(store.db.QueryRowContext(
		ctx,
		accountOverviewByRefSQL,
		accountRef.String(),
	))
}

// GetAccountOverviewByCLIAccountID 按 Provider 内数字别名点查无敏感投影。
func (store *Store) GetAccountOverviewByCLIAccountID(
	ctx context.Context,
	providerID string,
	cliAccountID accountcore.CLIAccountID,
) (accountapp.AccountOverview, error) {
	canonicalProviderID, found := store.catalog.CanonicalID(providerID)
	if !found || canonicalProviderID != providerID || !cliAccountID.IsValid() {
		return accountapp.AccountOverview{}, accountapp.ErrInvalidOverview
	}
	return store.scanAccountOverview(store.db.QueryRowContext(
		ctx,
		accountOverviewByAliasSQL,
		canonicalProviderID,
		cliAccountID.Int64(),
	))
}

// scanAccountOverview 校验账号、凭据类型和公开资料标量。
func (store *Store) scanAccountOverview(row rowScanner) (accountapp.AccountOverview, error) {
	var record accountRecord
	var input accountapp.AccountOverviewInput
	var profileUpdatedAtMS int64
	if err := row.Scan(
		&record.accountRef,
		&record.providerID,
		&record.cliAccountID,
		&record.enabled,
		&record.createdAtMS,
		&record.updatedAtMS,
		&input.HasCredential,
		&input.AuthKind,
		&input.AuthMode,
		&input.HasProfile,
		&input.DisplayName,
		&input.Email,
		&input.SubscriptionKind,
		&input.SubscriptionRaw,
		&profileUpdatedAtMS,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return accountapp.AccountOverview{}, accountapp.ErrAccountNotFound
		}
		return accountapp.AccountOverview{}, fmt.Errorf("读取账号管理投影失败: %w", err)
	}
	account, err := store.restoreAccount(record)
	if err != nil {
		return accountapp.AccountOverview{}, err
	}
	input.Account = account
	if input.HasProfile {
		input.ProfileUpdatedAt = time.UnixMilli(profileUpdatedAtMS).UTC()
	}
	overview, err := accountapp.NewAccountOverview(input)
	if err != nil {
		return accountapp.AccountOverview{}, ErrIncompatibleDatabase
	}
	return overview, nil
}
