package sqliteaccount

// 本文件维护客户端 Key 的请求/尝试统计（分钟桶 + 小时桶）。
//
// 只增不改既有 usage_ledger；token 数值来自同一个 usageledger.Record 事件，
// 因此与账号维度账本保持一致。分钟桶保留 7 天，小时桶长期保留。

import (
	"context"
	"errors"
	"strings"

	"github.com/madou1217/ai_home/core/clientkeys"
)

// ClientKeyRequestBucket / ClientKeyAttemptBucket / ClientKeyStatsQuery 与
// core/clientkeys 共用同一批值对象，避免 adapter 与 application 各存一份。
type ClientKeyRequestBucket = clientkeys.RequestBucket
type ClientKeyAttemptBucket = clientkeys.AttemptBucket
type ClientKeyStatsQuery = clientkeys.StatsQuery

// GranularityMinute / GranularityHour 复用领域常量。
const (
	GranularityMinute = clientkeys.GranularityMinute
	GranularityHour   = clientkeys.GranularityHour
)

// UpsertClientKeyStats 在一个写事务里累加分钟桶与小时桶。
func (store *Store) UpsertClientKeyStats(
	ctx context.Context,
	requests []ClientKeyRequestBucket,
	attempts []ClientKeyAttemptBucket,
) error {
	if store == nil || store.db == nil {
		return errors.New("账号数据库不可用")
	}
	if len(requests) == 0 && len(attempts) == 0 {
		return nil
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	requestSQL := func(table, bucketColumn string) string {
		return `INSERT INTO ` + table + ` (` + bucketColumn + `, key_id, surface, requests, aborted_requests)
			VALUES (?, ?, ?, ?, ?)
			ON CONFLICT(` + bucketColumn + `, key_id, surface) DO UPDATE SET
				requests = requests + excluded.requests,
				aborted_requests = aborted_requests + excluded.aborted_requests`
	}
	var requestTargets = []struct {
		table  string
		column string
	}{
		{table: "client_key_request_minute", column: "minute_ms"},
		{table: "client_key_request_hour", column: "hour_ms"},
	}
	for _, target := range requestTargets {
		for _, bucket := range requests {
			if bucket.BucketMS <= 0 || strings.TrimSpace(bucket.KeyID) == "" {
				continue
			}
			bucketValue := bucket.BucketMS
			if target.column == "hour_ms" {
				bucketValue = hourStart(bucket.BucketMS)
			}
			if _, err := tx.ExecContext(ctx, requestSQL(target.table, target.column),
				bucketValue, bucket.KeyID, bucket.Surface, bucket.Requests, bucket.Aborted); err != nil {
				return err
			}
		}
	}

	attemptSQL := func(table, bucketColumn string) string {
		return `INSERT INTO ` + table + ` (` + bucketColumn + `, key_id, provider_id, model_id, account_ref,
			attempts, successes, failures, aborted, input_tokens, output_tokens,
			cached_input_tokens, cache_write_input_tokens, reasoning_tokens, total_tokens)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(` + bucketColumn + `, key_id, provider_id, model_id, account_ref) DO UPDATE SET
				attempts = attempts + excluded.attempts,
				successes = successes + excluded.successes,
				failures = failures + excluded.failures,
				aborted = aborted + excluded.aborted,
				input_tokens = input_tokens + excluded.input_tokens,
				output_tokens = output_tokens + excluded.output_tokens,
				cached_input_tokens = cached_input_tokens + excluded.cached_input_tokens,
				cache_write_input_tokens = cache_write_input_tokens + excluded.cache_write_input_tokens,
				reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
				total_tokens = total_tokens + excluded.total_tokens`
	}
	var attemptTargets = []struct {
		table  string
		column string
	}{
		{table: "client_key_attempt_minute", column: "minute_ms"},
		{table: "client_key_attempt_hour", column: "hour_ms"},
	}
	for _, target := range attemptTargets {
		for _, bucket := range attempts {
			if bucket.BucketMS <= 0 || strings.TrimSpace(bucket.KeyID) == "" {
				continue
			}
			bucketValue := bucket.BucketMS
			if target.column == "hour_ms" {
				bucketValue = hourStart(bucket.BucketMS)
			}
			if _, err := tx.ExecContext(ctx, attemptSQL(target.table, target.column),
				bucketValue, bucket.KeyID, bucket.ProviderID, bucket.ModelID, bucket.AccountRef,
				bucket.Attempts, bucket.Successes, bucket.Failures, bucket.Aborted,
				bucket.InputTokens, bucket.OutputTokens, bucket.CachedInputTokens,
				bucket.CacheWriteInputTokens, bucket.ReasoningTokens, bucket.TotalTokens); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

// QueryClientKeyAttempts 读取尝试桶（未做维度聚合，由应用层汇总）。
func (store *Store) QueryClientKeyAttempts(ctx context.Context, query ClientKeyStatsQuery) ([]ClientKeyAttemptBucket, error) {
	if store == nil || store.db == nil {
		return nil, errors.New("账号数据库不可用")
	}
	table, bucketColumn := statsTable(query.Granularity, true)
	if table == "" {
		return nil, errors.New("统计粒度无效")
	}
	sqlText := `SELECT ` + bucketColumn + `, key_id, provider_id, model_id, account_ref,
		attempts, successes, failures, aborted, input_tokens, output_tokens,
		cached_input_tokens, cache_write_input_tokens, reasoning_tokens, total_tokens
		FROM ` + table + ` WHERE ` + bucketColumn + ` >= ? AND ` + bucketColumn + ` < ?`
	args := []any{query.FromMS, query.ToMS}
	if value := strings.TrimSpace(query.KeyID); value != "" {
		sqlText += ` AND key_id = ?`
		args = append(args, value)
	}
	if value := strings.TrimSpace(query.ProviderID); value != "" {
		sqlText += ` AND provider_id = ?`
		args = append(args, value)
	}
	if value := strings.TrimSpace(query.ModelID); value != "" {
		sqlText += ` AND model_id = ?`
		args = append(args, value)
	}
	if value := strings.TrimSpace(query.AccountRef); value != "" {
		sqlText += ` AND account_ref = ?`
		args = append(args, value)
	}
	sqlText += ` ORDER BY ` + bucketColumn + ` ASC`
	limit := query.Limit
	if limit <= 0 || limit > 20000 {
		limit = 20000
	}
	sqlText += ` LIMIT ?`
	args = append(args, limit)

	rows, err := store.db.QueryContext(ctx, sqlText, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	buckets := make([]ClientKeyAttemptBucket, 0, 256)
	for rows.Next() {
		var bucket ClientKeyAttemptBucket
		if err := rows.Scan(
			&bucket.BucketMS, &bucket.KeyID, &bucket.ProviderID, &bucket.ModelID,
			&bucket.AccountRef, &bucket.Attempts, &bucket.Successes, &bucket.Failures,
			&bucket.Aborted, &bucket.InputTokens, &bucket.OutputTokens,
			&bucket.CachedInputTokens, &bucket.CacheWriteInputTokens,
			&bucket.ReasoningTokens, &bucket.TotalTokens,
		); err != nil {
			return nil, err
		}
		buckets = append(buckets, bucket)
	}
	return buckets, rows.Err()
}

// QueryClientKeyRequests 读取请求桶（未做维度聚合）。
func (store *Store) QueryClientKeyRequests(ctx context.Context, query ClientKeyStatsQuery) ([]ClientKeyRequestBucket, error) {
	if store == nil || store.db == nil {
		return nil, errors.New("账号数据库不可用")
	}
	table, bucketColumn := statsTable(query.Granularity, false)
	if table == "" {
		return nil, errors.New("统计粒度无效")
	}
	sqlText := `SELECT ` + bucketColumn + `, key_id, surface, requests, aborted_requests
		FROM ` + table + ` WHERE ` + bucketColumn + ` >= ? AND ` + bucketColumn + ` < ?`
	args := []any{query.FromMS, query.ToMS}
	if value := strings.TrimSpace(query.KeyID); value != "" {
		sqlText += ` AND key_id = ?`
		args = append(args, value)
	}
	sqlText += ` ORDER BY ` + bucketColumn + ` ASC LIMIT ?`
	limit := query.Limit
	if limit <= 0 || limit > 20000 {
		limit = 20000
	}
	args = append(args, limit)

	rows, err := store.db.QueryContext(ctx, sqlText, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	buckets := make([]ClientKeyRequestBucket, 0, 256)
	for rows.Next() {
		var bucket ClientKeyRequestBucket
		if err := rows.Scan(&bucket.BucketMS, &bucket.KeyID, &bucket.Surface, &bucket.Requests, &bucket.Aborted); err != nil {
			return nil, err
		}
		buckets = append(buckets, bucket)
	}
	return buckets, rows.Err()
}

// PruneClientKeyMinuteStats 删除早于 cutoff 的分钟桶。
func (store *Store) PruneClientKeyMinuteStats(ctx context.Context, cutoffMS int64) error {
	if store == nil || store.db == nil || cutoffMS <= 0 {
		return nil
	}
	if _, err := store.db.ExecContext(ctx, `DELETE FROM client_key_request_minute WHERE minute_ms < ?`, cutoffMS); err != nil {
		return err
	}
	_, err := store.db.ExecContext(ctx, `DELETE FROM client_key_attempt_minute WHERE minute_ms < ?`, cutoffMS)
	return err
}

func statsTable(granularity string, attempts bool) (string, string) {
	switch strings.ToLower(strings.TrimSpace(granularity)) {
	case GranularityHour:
		if attempts {
			return "client_key_attempt_hour", "hour_ms"
		}
		return "client_key_request_hour", "hour_ms"
	case "", GranularityMinute:
		if attempts {
			return "client_key_attempt_minute", "minute_ms"
		}
		return "client_key_request_minute", "minute_ms"
	default:
		return "", ""
	}
}

func hourStart(value int64) int64 {
	const hourMS = int64(3_600_000)
	return value - value%hourMS
}
