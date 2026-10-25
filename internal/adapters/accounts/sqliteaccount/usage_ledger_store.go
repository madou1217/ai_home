package sqliteaccount

import (
	"context"
	"fmt"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
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

func (store *Store) QueryUsageModels(ctx context.Context, query usageledger.Query) ([]usageledger.ModelStats, error) {
	records, err := store.readUsageRecords(ctx, query)
	if err != nil {
		return nil, err
	}
	return usageledger.AggregateModels(records, query), nil
}

func (store *Store) QueryUsageSessions(ctx context.Context, query usageledger.Query) ([]usageledger.SessionStats, error) {
	records, err := store.readUsageRecords(ctx, query)
	if err != nil {
		return nil, err
	}
	return usageledger.AggregateSessions(records, query), nil
}

func (store *Store) readUsageRecords(ctx context.Context, query usageledger.Query) ([]usageledger.Record, error) {
	if store == nil || store.db == nil || ctx == nil || query.Validate() != nil {
		return nil, usageledger.ErrInvalidQuery
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
	rows, err := store.db.QueryContext(ctx, `
		SELECT account_ref, provider_id, model_id, session_id, occurred_at_ms,
		       input_tokens, output_tokens, cached_input_tokens,
		       cache_write_input_tokens, reasoning_tokens
		FROM usage_ledger WHERE `+where+` ORDER BY occurred_at_ms, usage_id`, args...)
	if err != nil {
		return nil, fmt.Errorf("查询 token 用量事实失败: %w", err)
	}
	defer rows.Close()
	records := make([]usageledger.Record, 0)
	for rows.Next() {
		var accountRef, provider, model, sessionID string
		var occurredAtMS int64
		var input, output, cached, cacheWrite, reasoning uint64
		if err := rows.Scan(&accountRef, &provider, &model, &sessionID, &occurredAtMS, &input, &output, &cached, &cacheWrite, &reasoning); err != nil {
			return nil, fmt.Errorf("读取 token 用量事实失败: %w", err)
		}
		parsedRef, err := accountcore.ParseAccountRef(accountRef)
		if err != nil {
			return nil, fmt.Errorf("读取 token 用量账号失败: %w", err)
		}
		usage, err := inference.NewUsage(inference.UsageInput{
			InputTokens: input, OutputTokens: output, CachedInputTokens: cached,
			CacheWriteInputTokens: cacheWrite, ReasoningTokens: reasoning,
		})
		if err != nil {
			return nil, fmt.Errorf("读取 token 用量计数失败: %w", err)
		}
		record, err := usageledger.NewRecord(usageledger.RecordInput{
			AccountRef: parsedRef, Provider: provider, Model: model, SessionID: sessionID,
			OccurredAt: time.UnixMilli(occurredAtMS).UTC(), Usage: usage,
		})
		if err != nil {
			return nil, fmt.Errorf("读取 token 用量事实无效: %w", err)
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历 token 用量事实失败: %w", err)
	}
	return records, nil
}

func normalizeUsageFilter(value string) string {
	return value
}

var _ interface {
	AppendUsageRecord(context.Context, usageledger.Record) error
	QueryUsageStats(context.Context, usageledger.Query) (usageledger.Stats, error)
	QueryUsageModels(context.Context, usageledger.Query) ([]usageledger.ModelStats, error)
	QueryUsageSessions(context.Context, usageledger.Query) ([]usageledger.SessionStats, error)
} = (*Store)(nil)
