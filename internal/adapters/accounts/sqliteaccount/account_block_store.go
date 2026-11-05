package sqliteaccount

import (
	"context"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// ReplaceAccountBlock 覆盖账号同一失败类型的阻塞；账号不存在时不写入。
func (store *Store) ReplaceAccountBlock(
	ctx context.Context,
	block runtimecore.AccountBlock,
) error {
	if store == nil || store.db == nil || ctx == nil || !block.IsValid() {
		return runtimecore.ErrInvalidAccountBlock
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	result, err := store.db.ExecContext(
		ctx,
		`INSERT INTO account_runtime_blocks (
			account_ref, kind, scope, reason, observed_at_ms, until_ms
		)
		SELECT ?, ?, ?, ?, ?, ?
		 WHERE EXISTS (SELECT 1 FROM accounts WHERE account_ref = ?)
		ON CONFLICT(account_ref, kind) DO UPDATE SET
			scope = excluded.scope,
			reason = excluded.reason,
			observed_at_ms = excluded.observed_at_ms,
			until_ms = excluded.until_ms`,
		block.AccountRef().String(),
		string(block.Kind()),
		string(block.Scope()),
		block.Reason(),
		block.ObservedAt().UnixMilli(),
		block.Until().UnixMilli(),
		block.AccountRef().String(),
	)
	if err != nil {
		return fmt.Errorf("写入账号运行态阻塞失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("读取账号运行态阻塞写入结果失败: %w", err)
	}
	if affected == 0 {
		return accountapp.ErrAccountNotFound
	}
	return nil
}

// DeleteAccountBlock 删除账号指定失败类型的阻塞。
func (store *Store) DeleteAccountBlock(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	kind runtimecore.FailureKind,
) error {
	if store == nil || store.db == nil || ctx == nil || !accountRef.IsValid() {
		return runtimecore.ErrInvalidAccountBlock
	}
	if _, err := store.db.ExecContext(
		ctx,
		"DELETE FROM account_runtime_blocks WHERE account_ref = ? AND kind = ?",
		accountRef.String(),
		string(kind),
	); err != nil {
		return fmt.Errorf("删除账号运行态阻塞失败: %w", err)
	}
	return nil
}

// ListAccountBlocks 返回全部账号级阻塞；冷却过期的行不在这里过滤，由消费方按 now 判定。
func (store *Store) ListAccountBlocks(
	ctx context.Context,
) ([]runtimecore.AccountBlock, error) {
	if store == nil || store.db == nil || ctx == nil {
		return nil, runtimecore.ErrInvalidAccountBlock
	}
	rows, err := store.db.QueryContext(
		ctx,
		`SELECT account_ref, kind, scope, reason, observed_at_ms, until_ms
		   FROM account_runtime_blocks
		  ORDER BY account_ref, kind`,
	)
	if err != nil {
		return nil, fmt.Errorf("查询账号运行态阻塞失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()
	blocks := make([]runtimecore.AccountBlock, 0, 16)
	for rows.Next() {
		var accountRef, kind, scope, reason string
		var observedAtMS, untilMS int64
		if err := rows.Scan(&accountRef, &kind, &scope, &reason, &observedAtMS, &untilMS); err != nil {
			return nil, fmt.Errorf("读取账号运行态阻塞失败: %w", err)
		}
		parsedRef, err := accountcore.ParseAccountRef(accountRef)
		if err != nil {
			return nil, ErrIncompatibleDatabase
		}
		block, err := runtimecore.NewAccountBlock(runtimecore.AccountBlockInput{
			AccountRef: parsedRef,
			Kind:       runtimecore.FailureKind(kind),
			Scope:      runtimecore.BlockScope(scope),
			Reason:     reason,
			ObservedAt: timeFromUnixMilli(observedAtMS),
			Until:      timeFromUnixMilli(untilMS),
		})
		if err != nil {
			return nil, ErrIncompatibleDatabase
		}
		blocks = append(blocks, block)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历账号运行态阻塞失败: %w", err)
	}
	return blocks, nil
}
