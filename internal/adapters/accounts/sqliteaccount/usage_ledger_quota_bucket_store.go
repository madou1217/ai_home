package sqliteaccount

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/core/usageledger"
)

// dayMillis 是 UTC 日粒度汇总表的时间片长度。
const dayMillis int64 = 24 * 60 * 60 * 1000

// QueryUsageQuotaBuckets 按额度档位聚合 token 用量事实。
//
// 整日落在时间窗内的部分读 usage_ledger_daily（由插入触发器维护），
// 不足一日的首尾两段仍查明细账本；两段相加的结果与直接聚合 usage_ledger
// 完全一致，但不再随时间线性变慢（90 天窗口 10.6 万行 → 汇总表几十行）。
func (store *Store) QueryUsageQuotaBuckets(
	ctx context.Context,
	query usageledger.Query,
) ([]usageledger.QuotaBucketStats, error) {
	if store == nil || store.db == nil || ctx == nil || query.Validate() != nil {
		return nil, usageledger.ErrInvalidQuery
	}

	fromMS := query.From.UTC().UnixMilli()
	toMS := query.To.UTC().UnixMilli()
	if fromMS > toMS {
		return []usageledger.QuotaBucketStats{}, nil
	}

	// 整日区间 [firstFullDay, lastFullDayEnd)：首日不齐就从次日零时算起，
	// 尾日不齐就只汇总到当日零时之前。
	firstFullDay, lastFullDayEnd := fullDayWindow(fromMS, toMS)

	merged := make(map[quotaBucketKey]*usageledger.QuotaBucketStats, 8)
	addStats := func(rows []usageledger.QuotaBucketStats) {
		for _, row := range rows {
			key := quotaBucketKey{provider: row.Provider, bucket: row.QuotaBucket}
			target := merged[key]
			if target == nil {
				copied := row
				merged[key] = &copied
				continue
			}
			target.Calls += row.Calls
			target.InputTokens += row.InputTokens
			target.OutputTokens += row.OutputTokens
			target.CacheReadInputTokens += row.CacheReadInputTokens
			target.CacheWriteInputTokens += row.CacheWriteInputTokens
			target.ReasoningOutputTokens += row.ReasoningOutputTokens
			target.TotalTokens += row.TotalTokens
		}
	}

	if firstFullDay >= lastFullDayEnd {
		// 窗口不足一整天（或完全落在同一天内）：直接查明细。
		rows, err := store.aggregateLedgerBuckets(ctx, query, fromMS, toMS)
		if err != nil {
			return nil, err
		}
		addStats(rows)
	} else {
		if fromMS < firstFullDay {
			rows, err := store.aggregateLedgerBuckets(ctx, query, fromMS, firstFullDay-1)
			if err != nil {
				return nil, err
			}
			addStats(rows)
		}
		if lastFullDayEnd <= toMS {
			rows, err := store.aggregateLedgerBuckets(ctx, query, lastFullDayEnd, toMS)
			if err != nil {
				return nil, err
			}
			addStats(rows)
		}
		rows, err := store.aggregateDailyBuckets(ctx, query, firstFullDay, lastFullDayEnd)
		if err != nil {
			return nil, err
		}
		addStats(rows)
	}

	result := make([]usageledger.QuotaBucketStats, 0, len(merged))
	for _, row := range merged {
		result = append(result, *row)
	}
	// 与直接聚合账本时的 ORDER BY total_tokens DESC, provider, bucket 一致。
	sort.Slice(result, func(left, right int) bool {
		if result[left].TotalTokens != result[right].TotalTokens {
			return result[left].TotalTokens > result[right].TotalTokens
		}
		if result[left].Provider != result[right].Provider {
			return result[left].Provider < result[right].Provider
		}
		return result[left].QuotaBucket < result[right].QuotaBucket
	})
	return result, nil
}

type quotaBucketKey struct {
	provider string
	bucket   string
}

// usageRangeFilter 生成明细表与汇总表共用的过滤条件：时间列名与上界语义
// 由调用方给出（明细按毫秒闭区间，汇总按日半开区间）。
func usageRangeFilter(query usageledger.Query, timeColumn string, upperInclusive bool) (string, []any) {
	upper := " < ?"
	if upperInclusive {
		upper = " <= ?"
	}
	where := timeColumn + " >= ? AND " + timeColumn + upper
	args := make([]any, 0, 5)
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
	return where, args
}

// aggregateLedgerBuckets 聚合一段毫秒级时间窗内的明细账本。
func (store *Store) aggregateLedgerBuckets(
	ctx context.Context,
	query usageledger.Query,
	fromMS, toMS int64,
) ([]usageledger.QuotaBucketStats, error) {
	where, filterArgs := usageRangeFilter(query, "occurred_at_ms", true)
	args := append([]any{fromMS, toMS}, filterArgs...)
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
		GROUP BY provider_id, quota_bucket`, args...)
	if err != nil {
		return nil, fmt.Errorf("查询额度档位用量失败: %w", err)
	}
	defer rows.Close()
	return scanQuotaBucketStats(rows)
}

// aggregateDailyBuckets 聚合整日汇总表；上界是半开区间。
func (store *Store) aggregateDailyBuckets(
	ctx context.Context,
	query usageledger.Query,
	fromMS, toEndMS int64,
) ([]usageledger.QuotaBucketStats, error) {
	where, filterArgs := usageRangeFilter(query, "day_ms", false)
	args := append([]any{fromMS, toEndMS}, filterArgs...)
	rows, err := store.db.QueryContext(ctx, `
		SELECT provider_id, quota_bucket,
		       COALESCE(SUM(calls), 0),
		       COALESCE(SUM(input_tokens), 0),
		       COALESCE(SUM(output_tokens), 0),
		       COALESCE(SUM(cached_input_tokens), 0),
		       COALESCE(SUM(cache_write_input_tokens), 0),
		       COALESCE(SUM(reasoning_tokens), 0),
		       COALESCE(SUM(total_tokens), 0)
		FROM usage_ledger_daily WHERE `+where+`
		GROUP BY provider_id, quota_bucket`, args...)
	if err != nil {
		return nil, fmt.Errorf("查询额度档位日汇总失败: %w", err)
	}
	defer rows.Close()
	return scanQuotaBucketStats(rows)
}

func scanQuotaBucketStats(rows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
}) ([]usageledger.QuotaBucketStats, error) {
	result := make([]usageledger.QuotaBucketStats, 0, 8)
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
