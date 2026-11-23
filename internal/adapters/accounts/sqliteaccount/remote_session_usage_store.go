package sqliteaccount

import (
	"context"
	"errors"
	"strings"

	"github.com/madou1217/ai_home/core/clientkeys"
)

// 远程执行会话维度的 token 聚合。表在首次写入时惰性创建，不改动既有
// client_key_* / usage_ledger 表结构。
const remoteSessionUsageSchema = `CREATE TABLE IF NOT EXISTS remote_session_usage (
	session_id TEXT PRIMARY KEY,
	input_tokens INTEGER NOT NULL DEFAULT 0,
	output_tokens INTEGER NOT NULL DEFAULT 0,
	cached_input_tokens INTEGER NOT NULL DEFAULT 0,
	cache_write_input_tokens INTEGER NOT NULL DEFAULT 0,
	reasoning_tokens INTEGER NOT NULL DEFAULT 0,
	total_tokens INTEGER NOT NULL DEFAULT 0,
	updated_at_ms INTEGER NOT NULL
)`

// UpsertRemoteSessionUsage 累加每个会话的 token 用量。
func (store *Store) UpsertRemoteSessionUsage(ctx context.Context, entries []clientkeys.RemoteSessionUsage) error {
	if store == nil || store.db == nil {
		return errors.New("账号数据库不可用")
	}
	if len(entries) == 0 {
		return nil
	}
	if _, err := store.db.ExecContext(ctx, remoteSessionUsageSchema); err != nil {
		return err
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, entry := range entries {
		sessionID := strings.TrimSpace(entry.SessionID)
		if sessionID == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO remote_session_usage (
	session_id, input_tokens, output_tokens, cached_input_tokens,
	cache_write_input_tokens, reasoning_tokens, total_tokens, updated_at_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(session_id) DO UPDATE SET
	input_tokens = input_tokens + excluded.input_tokens,
	output_tokens = output_tokens + excluded.output_tokens,
	cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
	cache_write_input_tokens = cache_write_input_tokens + excluded.cache_write_input_tokens,
	reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
	total_tokens = total_tokens + excluded.total_tokens,
	updated_at_ms = excluded.updated_at_ms`,
			sessionID, entry.InputTokens, entry.OutputTokens, entry.CachedInputTokens,
			entry.CacheWriteInputTokens, entry.ReasoningTokens, entry.TotalTokens, entry.UpdatedAtMS); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// QueryRemoteSessionUsage 读取一个会话的累计用量。
func (store *Store) QueryRemoteSessionUsage(ctx context.Context, sessionID string) (clientkeys.RemoteSessionUsage, bool, error) {
	if store == nil || store.db == nil {
		return clientkeys.RemoteSessionUsage{}, false, errors.New("账号数据库不可用")
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return clientkeys.RemoteSessionUsage{}, false, nil
	}
	if _, err := store.db.ExecContext(ctx, remoteSessionUsageSchema); err != nil {
		return clientkeys.RemoteSessionUsage{}, false, err
	}
	var entry clientkeys.RemoteSessionUsage
	err := store.db.QueryRowContext(ctx, `SELECT session_id, input_tokens, output_tokens, cached_input_tokens,
	cache_write_input_tokens, reasoning_tokens, total_tokens, updated_at_ms
	FROM remote_session_usage WHERE session_id = ?`, sessionID).Scan(
		&entry.SessionID, &entry.InputTokens, &entry.OutputTokens, &entry.CachedInputTokens,
		&entry.CacheWriteInputTokens, &entry.ReasoningTokens, &entry.TotalTokens, &entry.UpdatedAtMS)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no rows") {
			return clientkeys.RemoteSessionUsage{}, false, nil
		}
		return clientkeys.RemoteSessionUsage{}, false, err
	}
	return entry, true, nil
}
