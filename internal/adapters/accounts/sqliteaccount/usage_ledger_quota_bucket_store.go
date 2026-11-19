package sqliteaccount

import (
	"context"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/core/usageledger"
)

// QueryUsageQuotaBuckets 按额度档位聚合 token 用量事实。
//
// 聚合下推到 SQL：账本会随时间线性增长，读全部行再在 Go 里分组会让 30/90 天窗口
// 超过页面接口的 100ms 预算。
func (store *Store) QueryUsageQuotaBuckets(
	ctx context.Context,
	query usageledger.Query,
) ([]usageledger.QuotaBucketStats, error) {
	if store == nil || store.db == nil || ctx == nil || query.Validate() != nil {
		return nil, usageledger.ErrInvalidQuery
	}
	where := "occurred_at_ms >= ? AND occurred_at_ms <= ?"
	args := []any{query.From.UnixMilli(), query.To.UnixMilli()}
	if accountRef := query.AccountRef.String(); accountRef != "" {
		where += " AND account_ref = ?"
		args = append(args, accountRef)
	}
	if provider := strings.TrimSpace(strings.ToLower(query.Provider)); provider != "" {
		where += " AND provider_id = ?"
		args = append(args, provider)
	}
	if model := strings.TrimSpace(query.Model); model != "" {
		where += " AND model_id = ?"
		args = append(args, model)
	}
	rows, err := store.db.QueryContext(ctx, `
		SELECT provider_id, quota_bucket,
		       COUNT(*),
		       COALESCE(SUM(input_tokens), 0),
		       COALESCE(SUM(output_tokens), 0),
		       COALESCE(SUM(cached_input_tokens), 0),
		       COALESCE(SUM(cache_write_input_tokens), 0),
		       COALESCE(SUM(reasoning_tokens), 0),
		       COALESCE(SUM(total_tokens), 0)
		FROM usage_ledger WHERE `+where+`
		GROUP BY provider_id, quota_bucket
		ORDER BY 8 DESC, provider_id, quota_bucket`, args...)
	if err != nil {
		return nil, fmt.Errorf("查询额度档位用量失败: %w", err)
	}
	defer rows.Close()
	result := make([]usageledger.QuotaBucketStats, 0)
	for rows.Next() {
		var item usageledger.QuotaBucketStats
		if err := rows.Scan(
			&item.Provider, &item.QuotaBucket, &item.Calls,
			&item.InputTokens, &item.OutputTokens, &item.CacheReadInputTokens,
			&item.CacheWriteInputTokens, &item.ReasoningOutputTokens, &item.TotalTokens,
		); err != nil {
			return nil, fmt.Errorf("读取额度档位用量失败: %w", err)
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历额度档位用量失败: %w", err)
	}
	return result, nil
}
