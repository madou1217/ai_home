package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/usageledger"
)

// readScannedAccountUsageRecords 读取「按账号归属」的本地会话扫描用量。
//
// 为什么账号卡片还要多读一份：Native Direct 会话（aih claude <账号>）不经过网关，
// usage_ledger 没有它的行，只有 model_usage_records 的 session_jsonl 行；扫描器用
// provider hook 记录的会话→账号归属把这些行补上 account_ref 后，账号卡片才能看到
// 真实用量。网关会话的扫描行没有归属（账本已记账），不会重复计入。
func (store *Store) readScannedAccountUsageRecords(
	ctx context.Context,
	query usageledger.Query,
) ([]usageledger.Record, error) {
	if store == nil || store.db == nil || ctx == nil || !query.AccountRef.IsValid() {
		return nil, usageledger.ErrInvalidQuery
	}
	if err := query.Validate(); err != nil {
		return nil, err
	}
	// 旧库/精简测试库可能还没有扫描表；没有它就等于没有本地扫描用量，不是错误。
	var hasTable int
	if err := store.db.QueryRowContext(ctx, `
		SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'model_usage_records'`).Scan(&hasTable); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("检查本地扫描用量表失败: %w", err)
	}
	where := `account_ref = ?
		AND source_kind IN ('session_jsonl', 'session_json')
		AND timestamp_ms >= ? AND timestamp_ms <= ?`
	args := []any{query.AccountRef.String(), query.From.UnixMilli(), query.To.UnixMilli()}
	if provider := normalizeUsageFilter(query.Provider); provider != "" {
		where += " AND provider = ?"
		args = append(args, provider)
	}
	if model := normalizeUsageFilter(query.Model); model != "" {
		where += " AND model = ?"
		args = append(args, model)
	}
	rows, err := store.db.QueryContext(ctx, `
		SELECT provider, model, session_id, timestamp_ms,
		       input_tokens, output_tokens, cache_read_input_tokens,
		       cache_creation_input_tokens, reasoning_output_tokens
		FROM model_usage_records WHERE `+where+`
		ORDER BY timestamp_ms, id`, args...)
	if err != nil {
		return nil, fmt.Errorf("查询本地扫描账号用量失败: %w", err)
	}
	defer rows.Close()

	records := make([]usageledger.Record, 0)
	for rows.Next() {
		var provider, model, sessionID string
		var timestampMS int64
		var input, output, cached, cacheWrite, reasoning uint64
		if err := rows.Scan(&provider, &model, &sessionID, &timestampMS, &input, &output, &cached, &cacheWrite, &reasoning); err != nil {
			return nil, fmt.Errorf("读取本地扫描账号用量失败: %w", err)
		}
		provider = strings.ToLower(strings.TrimSpace(provider))
		model = strings.TrimSpace(model)
		if provider == "" || model == "" || timestampMS <= 0 {
			continue
		}
		// model_usage_records.input_tokens 是非缓存输入；账本的 input_tokens 是整段
		// 输入（含缓存读写，见 usage_ledger 的 CHECK total = input + output）。
		usage, err := inference.NewUsage(inference.UsageInput{
			InputTokens:           input + cached + cacheWrite,
			OutputTokens:          output,
			CachedInputTokens:     cached,
			CacheWriteInputTokens: cacheWrite,
			ReasoningTokens:       reasoning,
		})
		if err != nil || !usage.IsValid() || usage.TotalTokens() == 0 {
			continue
		}
		record, err := usageledger.NewRecord(usageledger.RecordInput{
			AccountRef: query.AccountRef,
			Provider:   provider,
			Model:      model,
			SessionID:  sessionID,
			OccurredAt: time.UnixMilli(timestampMS).UTC(),
			Usage:      usage,
		})
		if err != nil {
			continue
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历本地扫描账号用量失败: %w", err)
	}
	return records, nil
}
