package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// ReplaceAccountState 在一个事务里覆盖运行态文档并重算它的账号级阻塞物化。
//
// block 为 nil 表示当前文档没有可物化的阻塞：同一事务会清掉该账号此前的行，
// 保证 account_runtime_blocks 与文档不会各自漂移。
func (store *Store) ReplaceAccountState(
	ctx context.Context,
	state runtimecore.AccountState,
	block *runtimecore.AccountBlock,
) error {
	if store == nil || store.db == nil || ctx == nil || !state.IsValid() {
		return runtimecore.ErrInvalidAccountState
	}
	if block != nil && (!block.IsValid() || block.AccountRef() != state.AccountRef()) {
		return runtimecore.ErrInvalidAccountBlock
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开始账号运行态事务失败: %w", err)
	}
	defer func() {
		_ = transaction.Rollback()
	}()
	result, err := transaction.ExecContext(
		ctx,
		`INSERT INTO account_runtime_states (account_ref, state_json, updated_at_ms)
		 SELECT ?, ?, ?
		  WHERE EXISTS (SELECT 1 FROM accounts WHERE account_ref = ?)
		 ON CONFLICT(account_ref) DO UPDATE SET
		 	state_json = excluded.state_json,
		 	updated_at_ms = excluded.updated_at_ms`,
		state.AccountRef().String(),
		string(state.Document()),
		state.UpdatedAt().UnixMilli(),
		state.AccountRef().String(),
	)
	if err != nil {
		return fmt.Errorf("写入账号运行态文档失败: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("读取账号运行态文档写入结果失败: %w", err)
	}
	if affected == 0 {
		return accountapp.ErrAccountNotFound
	}
	if _, err := transaction.ExecContext(
		ctx,
		`DELETE FROM account_runtime_blocks WHERE account_ref = ?`,
		state.AccountRef().String(),
	); err != nil {
		return fmt.Errorf("清理账号运行态阻塞失败: %w", err)
	}
	if block != nil {
		if _, err := transaction.ExecContext(
			ctx,
			`INSERT INTO account_runtime_blocks (
				account_ref, kind, scope, reason, observed_at_ms, until_ms
			) VALUES (?, ?, ?, ?, ?, ?)`,
			block.AccountRef().String(),
			string(block.Kind()),
			string(block.Scope()),
			block.Reason(),
			block.ObservedAt().UnixMilli(),
			block.Until().UnixMilli(),
		); err != nil {
			return fmt.Errorf("写入账号运行态阻塞失败: %w", err)
		}
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("提交账号运行态事务失败: %w", err)
	}
	return nil
}

// DeleteAccountState 在一个事务里删除运行态文档与它的阻塞物化；不存在时视为成功。
func (store *Store) DeleteAccountState(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) error {
	if store == nil || store.db == nil || ctx == nil || !accountRef.IsValid() {
		return runtimecore.ErrInvalidAccountState
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开始账号运行态事务失败: %w", err)
	}
	defer func() {
		_ = transaction.Rollback()
	}()
	if _, err := transaction.ExecContext(
		ctx,
		`DELETE FROM account_runtime_states WHERE account_ref = ?`,
		accountRef.String(),
	); err != nil {
		return fmt.Errorf("删除账号运行态文档失败: %w", err)
	}
	if _, err := transaction.ExecContext(
		ctx,
		`DELETE FROM account_runtime_blocks WHERE account_ref = ?`,
		accountRef.String(),
	); err != nil {
		return fmt.Errorf("删除账号运行态阻塞失败: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("提交账号运行态事务失败: %w", err)
	}
	return nil
}

// ListAccountStates 返回全部账号运行态文档，按账号引用稳定排序。
func (store *Store) ListAccountStates(
	ctx context.Context,
) ([]runtimecore.AccountState, error) {
	if store == nil || store.db == nil || ctx == nil {
		return nil, runtimecore.ErrInvalidAccountState
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	rows, err := store.db.QueryContext(
		ctx,
		`SELECT account_ref, state_json, updated_at_ms
		   FROM account_runtime_states
		  ORDER BY account_ref`,
	)
	if err != nil {
		return nil, fmt.Errorf("查询账号运行态文档失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()
	states := make([]runtimecore.AccountState, 0, 16)
	for rows.Next() {
		var accountRef, document string
		var updatedAtMS int64
		if err := rows.Scan(&accountRef, &document, &updatedAtMS); err != nil {
			return nil, fmt.Errorf("读取账号运行态文档失败: %w", err)
		}
		parsedRef, err := accountcore.ParseAccountRef(accountRef)
		if err != nil {
			return nil, ErrIncompatibleDatabase
		}
		state, err := runtimecore.NewAccountState(runtimecore.AccountStateInput{
			AccountRef: parsedRef,
			Document:   []byte(document),
			UpdatedAt:  timeFromUnixMilli(updatedAtMS),
		})
		if err != nil {
			return nil, ErrIncompatibleDatabase
		}
		states = append(states, state)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历账号运行态文档失败: %w", err)
	}
	return states, nil
}

// GetAccountState 读取单个账号的运行态文档；不存在时返回账号不存在。
func (store *Store) GetAccountState(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (runtimecore.AccountState, error) {
	if store == nil || store.db == nil || ctx == nil || !accountRef.IsValid() {
		return runtimecore.AccountState{}, runtimecore.ErrInvalidAccountState
	}
	if err := ctx.Err(); err != nil {
		return runtimecore.AccountState{}, err
	}
	var document string
	var updatedAtMS int64
	err := store.db.QueryRowContext(
		ctx,
		`SELECT state_json, updated_at_ms
		   FROM account_runtime_states
		  WHERE account_ref = ?`,
		accountRef.String(),
	).Scan(&document, &updatedAtMS)
	if errors.Is(err, sql.ErrNoRows) {
		return runtimecore.AccountState{}, accountapp.ErrAccountNotFound
	}
	if err != nil {
		return runtimecore.AccountState{}, fmt.Errorf("读取账号运行态文档失败: %w", err)
	}
	state, err := runtimecore.NewAccountState(runtimecore.AccountStateInput{
		AccountRef: accountRef,
		Document:   []byte(document),
		UpdatedAt:  timeFromUnixMilli(updatedAtMS),
	})
	if err != nil {
		return runtimecore.AccountState{}, ErrIncompatibleDatabase
	}
	return state, nil
}
