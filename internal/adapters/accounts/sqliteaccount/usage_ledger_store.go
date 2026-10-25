package sqliteaccount

import (
	"context"
	"fmt"

	"github.com/madou1217/ai_home/core/usageledger"
)

// AppendUsageRecord durably appends one successful inference fact.
// The account FK makes stale or unknown runtime identities fail closed.
func (store *Store) AppendUsageRecord(ctx context.Context, record usageledger.Record) error {
	if store == nil || store.db == nil || ctx == nil || !record.IsValid() {
		return usageledger.ErrInvalidRecord
	}
	store.routingWrites.Lock()
	defer store.routingWrites.Unlock()
	usage := record.Usage()
	_, err := store.db.ExecContext(ctx, `
		INSERT INTO usage_ledger (
			account_ref, provider_id, model_id, session_id, occurred_at_ms,
			input_tokens, output_tokens, cached_input_tokens,
			cache_write_input_tokens, reasoning_tokens, total_tokens
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		record.AccountRef().String(), record.Provider(), record.Model(), record.SessionID(),
		record.OccurredAt().UnixMilli(), usage.InputTokens(), usage.OutputTokens(),
		usage.CachedInputTokens(), usage.CacheWriteInputTokens(), usage.ReasoningTokens(),
		usage.TotalTokens(),
	)
	if err != nil {
		if isConstraintError(err) {
			return fmt.Errorf("写入 token 用量事实失败: %w", err)
		}
		return fmt.Errorf("写入 token 用量事实失败: %w", err)
	}
	return nil
}

// QueryUsageStats reads only durable Go ledger facts and applies an explicit time window.
func (store *Store) QueryUsageStats(ctx context.Context, query usageledger.Query) (usageledger.Stats, error) {
	if store == nil || store.db == nil || ctx == nil {
		return usageledger.Stats{}, usageledger.ErrInvalidQuery
	}
	if err := query.Validate(); err != nil {
		return usageledger.Stats{}, err
	}
	where := "occurred_at_ms >= ? AND occurred_at_ms <= ?"
	args := []any{query.From.UnixMilli(), query.To.UnixMilli()}
	if provider := normalizeUsageFilter(query.Provider); provider != "" {
		where += " AND provider_id = ?"
		args = append(args, provider)
	}
	if model := normalizeUsageFilter(query.Model); model != "" {
		where += " AND model_id = ?"
		args = append(args, model)
	}
	row := store.db.QueryRowContext(ctx, `
		SELECT COUNT(*),
		       COUNT(DISTINCT CASE WHEN session_id <> '' THEN provider_id || char(0) || session_id END),
		       COALESCE(SUM(input_tokens), 0),
		       COALESCE(SUM(output_tokens), 0),
		       COALESCE(SUM(cached_input_tokens), 0),
		       COALESCE(SUM(cache_write_input_tokens), 0),
		       COALESCE(SUM(reasoning_tokens), 0),
		       COALESCE(SUM(total_tokens), 0)
		FROM usage_ledger WHERE `+where, args...)
	var stats usageledger.Stats
	if err := row.Scan(
		&stats.TotalCalls, &stats.TotalSessions, &stats.InputTokens,
		&stats.OutputTokens, &stats.CacheReadInputTokens,
		&stats.CacheWriteInputTokens, &stats.ReasoningOutputTokens,
		&stats.TotalTokens,
	); err != nil {
		return usageledger.Stats{}, fmt.Errorf("查询 token 用量统计失败: %w", err)
	}
	return stats, nil
}

func normalizeUsageFilter(value string) string {
	return value
}

var _ interface {
	AppendUsageRecord(context.Context, usageledger.Record) error
	QueryUsageStats(context.Context, usageledger.Query) (usageledger.Stats, error)
} = (*Store)(nil)
