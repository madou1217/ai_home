package sqliteaccount

import (
	"context"
	"fmt"

	"github.com/madou1217/ai_home/application/accountoutcomes"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// addAccountOutcomeSQL 累加一个计数；账号已删除时静默丢弃（不违反外键）。
const addAccountOutcomeSQL = `
	INSERT INTO account_outcomes (account_ref, granularity, bucket_start_ms, outcome, count)
	SELECT ?, ?, ?, ?, ?
	WHERE EXISTS (SELECT 1 FROM accounts WHERE account_ref = ?)
	ON CONFLICT (account_ref, granularity, bucket_start_ms, outcome)
	DO UPDATE SET count = count + excluded.count`

var _ accountoutcomes.Store = (*Store)(nil)

// AddAccountOutcomes 在单个事务内累加一批时间桶计数。
func (store *Store) AddAccountOutcomes(ctx context.Context, deltas []accountoutcomes.Delta) error {
	if store == nil || store.db == nil {
		return ErrIncompatibleDatabase
	}
	if len(deltas) == 0 {
		return nil
	}
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开始账号结果写入事务失败: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	statement, err := transaction.PrepareContext(ctx, addAccountOutcomeSQL)
	if err != nil {
		return fmt.Errorf("准备账号结果写入失败: %w", err)
	}
	defer func() { _ = statement.Close() }()
	for _, delta := range deltas {
		if !delta.AccountRef.IsValid() || !delta.Granularity.IsValid() || delta.Count <= 0 {
			continue
		}
		if _, err := statement.ExecContext(
			ctx,
			delta.AccountRef.String(),
			string(delta.Granularity),
			delta.BucketStartMS,
			delta.Outcome,
			delta.Count,
			delta.AccountRef.String(),
		); err != nil {
			return fmt.Errorf("写入账号结果失败: %w", err)
		}
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("提交账号结果写入失败: %w", err)
	}
	return nil
}

// ListAccountOutcomes 返回指定粒度自 fromMS 起的全部计数行。
func (store *Store) ListAccountOutcomes(
	ctx context.Context,
	granularity accountoutcomes.Granularity,
	fromMS int64,
) ([]accountoutcomes.Bucket, error) {
	if store == nil || store.db == nil || !granularity.IsValid() {
		return nil, accountoutcomes.ErrInvalidQuery
	}
	rows, err := store.db.QueryContext(ctx, `
		SELECT account_ref, bucket_start_ms, outcome, count
		FROM account_outcomes
		WHERE granularity = ? AND bucket_start_ms >= ?
		ORDER BY account_ref, bucket_start_ms, outcome`,
		string(granularity),
		fromMS,
	)
	if err != nil {
		return nil, fmt.Errorf("查询账号结果失败: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var buckets []accountoutcomes.Bucket
	for rows.Next() {
		var refText, outcome string
		var bucket accountoutcomes.Bucket
		if err := rows.Scan(&refText, &bucket.BucketStartMS, &outcome, &bucket.Count); err != nil {
			return nil, fmt.Errorf("读取账号结果失败: %w", err)
		}
		ref, err := accountcore.ParseAccountRef(refText)
		if err != nil {
			return nil, ErrIncompatibleDatabase
		}
		bucket.AccountRef = ref
		bucket.Outcome = outcome
		buckets = append(buckets, bucket)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历账号结果失败: %w", err)
	}
	return buckets, nil
}

// PruneAccountOutcomes 删除指定粒度早于 beforeMS 的桶。
func (store *Store) PruneAccountOutcomes(
	ctx context.Context,
	granularity accountoutcomes.Granularity,
	beforeMS int64,
) error {
	if store == nil || store.db == nil || !granularity.IsValid() {
		return accountoutcomes.ErrInvalidQuery
	}
	if _, err := store.db.ExecContext(ctx,
		`DELETE FROM account_outcomes WHERE granularity = ? AND bucket_start_ms < ?`,
		string(granularity),
		beforeMS,
	); err != nil {
		return fmt.Errorf("清理账号结果失败: %w", err)
	}
	return nil
}
