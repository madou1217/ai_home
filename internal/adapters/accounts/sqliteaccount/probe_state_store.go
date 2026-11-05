package sqliteaccount

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// ProbeState 是账号最近一次额度探针的结果。
type ProbeState struct {
	Status      string
	Error       string
	CheckedAtMS int64
}

// UpsertProbeState 写入一条探针结果；未知账号静默忽略。
//
// 为什么静默：探针由 Node 异步推送，账号可能在这期间被删除；
// 用外键失败报错会让一次删除引发一串无关的推送失败。
func (store *Store) UpsertProbeState(
	ctx context.Context,
	accountRef string,
	state ProbeState,
) error {
	if store == nil || store.db == nil || ctx == nil || strings.TrimSpace(accountRef) == "" {
		return nil
	}
	const statement = `
		INSERT INTO account_probe_state (
			account_ref, status, error, checked_at_ms, updated_at_ms
		) VALUES (?, ?, ?, ?, ?)
		ON CONFLICT (account_ref) DO UPDATE SET
			status = excluded.status,
			error = excluded.error,
			checked_at_ms = excluded.checked_at_ms,
			updated_at_ms = excluded.updated_at_ms`
	if _, err := store.db.ExecContext(
		ctx,
		statement,
		accountRef,
		state.Status,
		state.Error,
		state.CheckedAtMS,
		time.Now().UTC().UnixMilli(),
	); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "foreign key") {
			return nil
		}
		return fmt.Errorf("写入探针状态失败: %w", err)
	}
	return nil
}

// LoadProbeStates 返回全部探针状态，按账号索引。
func (store *Store) LoadProbeStates(ctx context.Context) (map[string]ProbeState, error) {
	if store == nil || store.db == nil || ctx == nil {
		return map[string]ProbeState{}, nil
	}
	rows, err := store.db.QueryContext(
		ctx,
		"SELECT account_ref, status, error, checked_at_ms FROM account_probe_state",
	)
	if err != nil {
		if isMissingTable(err) {
			return map[string]ProbeState{}, nil
		}
		return nil, fmt.Errorf("读取探针状态失败: %w", err)
	}
	defer func() { _ = rows.Close() }()
	states := make(map[string]ProbeState, 64)
	for rows.Next() {
		var (
			ref   string
			state ProbeState
		)
		if err := rows.Scan(&ref, &state.Status, &state.Error, &state.CheckedAtMS); err != nil {
			return nil, fmt.Errorf("读取探针状态行失败: %w", err)
		}
		states[ref] = state
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历探针状态失败: %w", err)
	}
	return states, nil
}
