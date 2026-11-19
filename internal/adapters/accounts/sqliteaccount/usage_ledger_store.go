package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/usageledger"
)

// AppendUsageRecord durably appends one successful inference fact.
// The account FK makes stale or unknown runtime identities fail closed.
func (store *Store) AppendUsageRecord(ctx context.Context, record usageledger.Record) error {
	return store.appendUsageRecord(ctx, record, nil)
}

// AppendUsageRecordWithProjection commits a new fact and its read projection
// together. The projection must only use the supplied transaction; it must not
// start another writer or commit it. Existing facts are never backfilled here.
func (store *Store) AppendUsageRecordWithProjection(
	ctx context.Context,
	record usageledger.Record,
	project func(context.Context, *sql.Tx, int64) error,
) error {
	if project == nil {
		return usageledger.ErrInvalidRecord
	}
	return store.appendUsageRecord(ctx, record, project)
}

func (store *Store) appendUsageRecord(
	ctx context.Context,
	record usageledger.Record,
	project func(context.Context, *sql.Tx, int64) error,
) error {
	if store == nil || store.db == nil || ctx == nil || !record.IsValid() {
		return usageledger.ErrInvalidRecord
	}
	store.routingWrites.Lock()
	defer store.routingWrites.Unlock()
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("usage_ledger_begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	usage := record.Usage()
	result, err := tx.ExecContext(ctx, `
		INSERT INTO usage_ledger (
			account_ref, provider_id, model_id, session_id, occurred_at_ms,
			input_tokens, output_tokens, cached_input_tokens,
			cache_write_input_tokens, reasoning_tokens, total_tokens, quota_bucket
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		record.AccountRef().String(), record.Provider(), record.Model(), record.SessionID(),
		record.OccurredAt().UnixMilli(), usage.InputTokens(), usage.OutputTokens(),
		usage.CachedInputTokens(), usage.CacheWriteInputTokens(), usage.ReasoningTokens(),
		usage.TotalTokens(), record.Bucket(),
	)
	if err != nil {
		return fmt.Errorf("写入 token 用量事实失败: %w", err)
	}
	if project != nil {
		id, err := result.LastInsertId()
		if err != nil || id <= 0 {
			return errors.New("usage_ledger_identity_invalid")
		}
		// This identifies a committed ledger fact, not an upstream attempt.
		// A repeated append is a new fact; do not guess identity from tokens/time.
		if _, err := tx.ExecContext(ctx, `UPDATE usage_ledger SET source_key = ? WHERE usage_id = ?`,
			fmt.Sprintf("go-ledger:v1:%d", id), id); err != nil {
			return fmt.Errorf("usage_ledger_identity_write: %w", err)
		}
		if err := project(ctx, tx, id); err != nil {
			return fmt.Errorf("usage_ledger_projection: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("usage_ledger_commit: %w", err)
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
	// AccountRef 与 provider/model 一样是 Query 上的既有过滤条件：
	// 额度统计页按账号看，没这一步就会把别的账号的用量也算进来。
	if accountRef := query.AccountRef.String(); accountRef != "" {
		where += " AND account_ref = ?"
		args = append(args, accountRef)
	}
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
	// 账号过滤同样下推到 SQL：usage_ledger 已有 (account_ref, occurred_at_ms)
	// 复合索引，账号行刷新时不能把整库历史都读进内存再逐条丢。
	if accountRef := query.AccountRef.String(); accountRef != "" {
		where += " AND account_ref = ?"
		args = append(args, accountRef)
	}
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
		       cache_write_input_tokens, reasoning_tokens, quota_bucket
		FROM usage_ledger WHERE `+where+` ORDER BY occurred_at_ms, usage_id`, args...)
	if err != nil {
		return nil, fmt.Errorf("查询 token 用量事实失败: %w", err)
	}
	defer rows.Close()
	records := make([]usageledger.Record, 0)
	for rows.Next() {
		var accountRef, provider, model, sessionID, bucket string
		var occurredAtMS int64
		var input, output, cached, cacheWrite, reasoning uint64
		if err := rows.Scan(&accountRef, &provider, &model, &sessionID, &occurredAtMS, &input, &output, &cached, &cacheWrite, &reasoning, &bucket); err != nil {
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
			OccurredAt: time.UnixMilli(occurredAtMS).UTC(), Usage: usage, Bucket: bucket,
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

// ImportUsageEvents 批量导入 Node 的历史 token 事实。
//
// 用 INSERT OR IGNORE 而不是 UPSERT：唯一键是 source_key，其它约束（账号外键、token
// 不变量）失败时同样应当跳过——历史数据里可能有已删除账号的行，一条坏行不能让整批
// 导入失败。返回值 imported 是真正写入的行数，skipped 包含重复与不合法行。
func (store *Store) ImportUsageEvents(
	ctx context.Context,
	events []usageledger.ImportEvent,
) (imported int, skipped int, err error) {
	if store == nil || store.db == nil || ctx == nil {
		return 0, 0, usageledger.ErrInvalidRecord
	}
	store.routingWrites.Lock()
	defer store.routingWrites.Unlock()
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, fmt.Errorf("开启用量导入事务失败: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	statement, err := tx.PrepareContext(ctx, `
		INSERT OR IGNORE INTO usage_ledger (
			account_ref, provider_id, model_id, session_id, occurred_at_ms,
			input_tokens, output_tokens, cached_input_tokens,
			cache_write_input_tokens, reasoning_tokens, total_tokens, source_key
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return 0, 0, fmt.Errorf("准备用量导入语句失败: %w", err)
	}
	defer func() { _ = statement.Close() }()
	for _, event := range events {
		if !event.IsValid() {
			skipped++
			continue
		}
		result, execErr := statement.ExecContext(
			ctx,
			event.AccountRef.String(),
			strings.ToLower(strings.TrimSpace(event.Provider)),
			strings.TrimSpace(event.Model),
			strings.TrimSpace(event.SessionID),
			event.OccurredAt.UTC().UnixMilli(),
			event.InputTokens,
			event.OutputTokens,
			event.CachedInputTokens,
			event.CacheWriteInputTokens,
			event.ReasoningTokens,
			event.TotalTokens,
			strings.TrimSpace(event.SourceKey),
		)
		if execErr != nil {
			skipped++
			continue
		}
		affected, affErr := result.RowsAffected()
		if affErr != nil || affected == 0 {
			skipped++
			continue
		}
		imported++
	}
	if err = tx.Commit(); err != nil {
		return 0, 0, fmt.Errorf("提交用量导入事务失败: %w", err)
	}
	return imported, skipped, nil
}

// QueryUsageBuckets 按 UTC 日/周聚合账本事实（图表用）。
//
// 与档位聚合同一套拆分：整日读 usage_ledger_daily，首尾不足一日读明细，
// 因此任意毫秒级窗口的桶值与直接扫账本一致，但不再随时间线性变慢
// （90 天窗口从 ~200ms 降到 ~1ms）。
func (store *Store) QueryUsageBuckets(
	ctx context.Context,
	query usageledger.Query,
	granularity string,
) ([]usageledger.BucketStats, error) {
	normalized := usageledger.NormalizeBucketGranularity(granularity)
	if normalized == "" || store == nil || store.db == nil || ctx == nil || query.Validate() != nil {
		return nil, usageledger.ErrInvalidQuery
	}
	fromMS := query.From.UTC().UnixMilli()
	toMS := query.To.UTC().UnixMilli()
	if fromMS > toMS {
		return []usageledger.BucketStats{}, nil
	}

	days := make(map[int64]dayTokenTotals, 32)
	merge := func(rows map[int64]dayTokenTotals) {
		for day, totals := range rows {
			current := days[day]
			current.tokens += totals.tokens
			current.calls += totals.calls
			days[day] = current
		}
	}

	firstFullDay, lastFullDayEnd := fullDayWindow(fromMS, toMS)
	if firstFullDay >= lastFullDayEnd {
		rows, err := store.aggregateLedgerDays(ctx, query, fromMS, toMS)
		if err != nil {
			return nil, err
		}
		merge(rows)
	} else {
		if fromMS < firstFullDay {
			rows, err := store.aggregateLedgerDays(ctx, query, fromMS, firstFullDay-1)
			if err != nil {
				return nil, err
			}
			merge(rows)
		}
		if lastFullDayEnd <= toMS {
			rows, err := store.aggregateLedgerDays(ctx, query, lastFullDayEnd, toMS)
			if err != nil {
				return nil, err
			}
			merge(rows)
		}
		rows, err := store.aggregateRollupDays(ctx, query, firstFullDay, lastFullDayEnd)
		if err != nil {
			return nil, err
		}
		merge(rows)
	}

	width := dayMillis
	if normalized == usageledger.BucketGranularityWeek {
		width = 7 * dayMillis
	}
	buckets := make(map[int64]*usageledger.BucketStats, len(days))
	for day, totals := range days {
		start := day
		if normalized == usageledger.BucketGranularityWeek {
			offset := int64((int(time.UnixMilli(day).UTC().Weekday()) + 6) % 7)
			start = day - offset*dayMillis
		}
		bucket := buckets[start]
		if bucket == nil {
			bucket = &usageledger.BucketStats{StartMS: start, EndMS: start + width}
			buckets[start] = bucket
		}
		bucket.Tokens += totals.tokens
		bucket.RequestCount += totals.calls
	}
	result := make([]usageledger.BucketStats, 0, len(buckets))
	for _, bucket := range buckets {
		result = append(result, *bucket)
	}
	sort.Slice(result, func(left, right int) bool { return result[left].StartMS < result[right].StartMS })
	return result, nil
}

// dayTokenTotals 是一天的 token 与请求次数。
type dayTokenTotals struct {
	tokens uint64
	calls  uint64
}

// fullDayWindow 返回窗口内完整 UTC 日的 [start, endExclusive)。
// start >= endExclusive 表示窗口不足一整天。
func fullDayWindow(fromMS, toMS int64) (int64, int64) {
	first := fromMS
	if remainder := fromMS % dayMillis; remainder != 0 {
		first = fromMS - remainder + dayMillis
	}
	lastEnd := toMS + 1
	if remainder := lastEnd % dayMillis; remainder != 0 {
		lastEnd -= remainder
	}
	return first, lastEnd
}

// aggregateLedgerDays 从明细账本按 UTC 日聚合一段毫秒窗口。
func (store *Store) aggregateLedgerDays(
	ctx context.Context,
	query usageledger.Query,
	fromMS, toMS int64,
) (map[int64]dayTokenTotals, error) {
	where, filterArgs := usageRangeFilter(query, "occurred_at_ms", true)
	args := append([]any{fromMS, toMS}, filterArgs...)
	rows, err := store.db.QueryContext(ctx, `
		SELECT occurred_at_ms / 86400000 * 86400000 AS day_ms,
		       COALESCE(SUM(total_tokens), 0), COUNT(*)
		FROM usage_ledger WHERE `+where+`
		GROUP BY day_ms`, args...)
	if err != nil {
		return nil, fmt.Errorf("查询用量日桶失败: %w", err)
	}
	defer rows.Close()
	return scanDayTotals(rows)
}

// aggregateRollupDays 从日汇总表聚合完整日窗口（半开区间）。
func (store *Store) aggregateRollupDays(
	ctx context.Context,
	query usageledger.Query,
	fromMS, toEndMS int64,
) (map[int64]dayTokenTotals, error) {
	where, filterArgs := usageRangeFilter(query, "day_ms", false)
	args := append([]any{fromMS, toEndMS}, filterArgs...)
	rows, err := store.db.QueryContext(ctx, `
		SELECT day_ms, COALESCE(SUM(total_tokens), 0), COALESCE(SUM(calls), 0)
		FROM usage_ledger_daily WHERE `+where+`
		GROUP BY day_ms`, args...)
	if err != nil {
		return nil, fmt.Errorf("查询用量日汇总失败: %w", err)
	}
	defer rows.Close()
	return scanDayTotals(rows)
}

func scanDayTotals(rows interface {
	Next() bool
	Scan(dest ...any) error
	Err() error
}) (map[int64]dayTokenTotals, error) {
	result := make(map[int64]dayTokenTotals, 32)
	for rows.Next() {
		var day int64
		var tokens, calls uint64
		if err := rows.Scan(&day, &tokens, &calls); err != nil {
			return nil, fmt.Errorf("读取用量日桶失败: %w", err)
		}
		result[day] = dayTokenTotals{tokens: tokens, calls: calls}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历用量日桶失败: %w", err)
	}
	return result, nil
}
