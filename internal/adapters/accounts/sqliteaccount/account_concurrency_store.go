package sqliteaccount

// 本文件维护账号级并发/速率覆盖（account_concurrency_limits）。
// 本轮只存储与预览，不参与准入拦截。

import (
	"context"
	"errors"

	"github.com/madou1217/ai_home/core/concurrency"
)

// ListAccountConcurrencyLimits 返回全部账号覆盖。
func (store *Store) ListAccountConcurrencyLimits(ctx context.Context) ([]concurrency.AccountLimit, error) {
	if store == nil || store.db == nil {
		return nil, errors.New("账号数据库不可用")
	}
	rows, err := store.db.QueryContext(ctx, `SELECT account_ref, model_id, max_concurrency, rpm_limit, tpm_limit
		FROM account_concurrency_limits ORDER BY account_ref, model_id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	limits := make([]concurrency.AccountLimit, 0, 16)
	for rows.Next() {
		var limit concurrency.AccountLimit
		if err := rows.Scan(&limit.AccountRef, &limit.ModelID, &limit.MaxConcurrency, &limit.RPMLimit, &limit.TPMLimit); err != nil {
			return nil, err
		}
		limits = append(limits, limit)
	}
	return limits, rows.Err()
}

// SetAccountConcurrencyLimit 写入/覆盖一条账号（或账号+模型）限制。
func (store *Store) SetAccountConcurrencyLimit(ctx context.Context, limit concurrency.AccountLimit) error {
	if store == nil || store.db == nil {
		return errors.New("账号数据库不可用")
	}
	_, err := store.db.ExecContext(ctx, `INSERT INTO account_concurrency_limits
		(account_ref, model_id, max_concurrency, rpm_limit, tpm_limit, updated_at_ms)
		VALUES (?, ?, ?, ?, ?, strftime('%s','now')*1000)
		ON CONFLICT(account_ref, model_id) DO UPDATE SET
			max_concurrency = excluded.max_concurrency,
			rpm_limit = excluded.rpm_limit,
			tpm_limit = excluded.tpm_limit,
			updated_at_ms = excluded.updated_at_ms`,
		limit.AccountRef, limit.ModelID, limit.MaxConcurrency, limit.RPMLimit, limit.TPMLimit)
	return err
}

// DeleteAccountConcurrencyLimit 删除一条覆盖；不存在时返回 false。
func (store *Store) DeleteAccountConcurrencyLimit(ctx context.Context, accountRef, modelID string) (bool, error) {
	if store == nil || store.db == nil {
		return false, errors.New("账号数据库不可用")
	}
	result, err := store.db.ExecContext(ctx,
		`DELETE FROM account_concurrency_limits WHERE account_ref = ? AND model_id = ?`,
		accountRef, modelID)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	return affected > 0, nil
}