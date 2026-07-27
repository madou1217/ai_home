package sqliteaccount

import (
	"context"
	"fmt"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// accountOverviewSQL 是账号管理列表及查询计划验证的单一 SQL 合同。
//
// 该查询只读取凭据类型和公开资料标量，禁止选择 credential_json 或 profile_json。
const accountOverviewSQL = `
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
	LEFT JOIN account_profiles AS p ON p.account_ref = a.account_ref
	WHERE a.account_ref > ?
	ORDER BY a.account_ref
	LIMIT ?`

var _ accountapp.AccountOverviewStore = (*Store)(nil)

// ListAccountOverviews 使用 keyset pagination 返回无敏感数据的账号管理投影。
func (store *Store) ListAccountOverviews(
	ctx context.Context,
	query accountapp.OverviewQuery,
) ([]accountapp.AccountOverview, error) {
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
