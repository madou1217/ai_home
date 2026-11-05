package sqliteaccount

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

const (
	// QuotaWindowSampleBucketMS 是采样写入的时间桶：同一桶内只保留第一条。
	QuotaWindowSampleBucketMS = int64(5 * 60 * 1000)
	// QuotaWindowSampleRetentionMS 是采样保留期：90 天查询范围再留一个月余量。
	QuotaWindowSampleRetentionMS = int64(120 * 24 * 60 * 60 * 1000)
	// quotaWindowPruneIntervalMS 限制清理频率，避免每次快照写入都扫全表。
	quotaWindowPruneIntervalMS = int64(6 * 60 * 60 * 1000)
)

// insertQuotaWindowSamples 把一次额度快照里的窗口条目追加到采样表。
//
// 与 Node 侧同口径：窗口由 reset 值标识，采样只记录事实（含幻影），
// 幻影在重建阶段剔除；5 分钟桶 + 唯一约束保证重复推送幂等。
func (store *Store) insertQuotaWindowSamples(
	ctx context.Context,
	transaction *sql.Tx,
	snapshot usagecore.Snapshot,
) error {
	capturedAtMS := snapshot.CapturedAt().UnixMilli()
	if capturedAtMS <= 0 {
		return nil
	}
	capturedBucket := capturedAtMS - capturedAtMS%QuotaWindowSampleBucketMS
	const statement = `
		INSERT INTO account_quota_window_samples (
			account_ref, provider_id, quota_key, window_label, window_minutes,
			remaining_pct, expected_reset_at_ms, captured_at_ms, captured_bucket,
			plan_type, created_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT (account_ref, quota_key, window_minutes, captured_bucket)
		DO NOTHING`
	prepared, err := transaction.PrepareContext(ctx, statement)
	if err != nil {
		return fmt.Errorf("准备额度窗口采样写入失败: %w", err)
	}
	defer func() {
		_ = prepared.Close()
	}()
	for _, entry := range snapshot.Entries() {
		if entry.Kind() != usagecore.KindWindow {
			continue
		}
		bucket := strings.TrimSpace(entry.Bucket())
		if bucket == "" {
			continue
		}
		windowLabel := strings.TrimSpace(entry.LimitName())
		if windowLabel == "" {
			windowLabel = bucket
		}
		var remainingPct *float64
		if basisPoints, known := entry.RemainingBasisPoints(); known {
			value := float64(basisPoints) / 100
			remainingPct = &value
		}
		expectedResetAtMS := int64(0)
		if resetAt := entry.ResetAt(); !resetAt.IsZero() {
			expectedResetAtMS = resetAt.UnixMilli()
		}
		observation := usagecore.QuotaWindowSample{
			QuotaKey:          "rate_limit:" + bucket,
			WindowLabel:       windowLabel,
			WindowMinutes:     entry.WindowSeconds() / 60,
			RemainingPct:      remainingPct,
			ExpectedResetAtMS: expectedResetAtMS,
			CapturedAtMS:      capturedAtMS,
		}
		// 检测器看到所有窗口观测（含幻影、含没有 reset 值的），与 Node 一致：
		// 重置判定只依赖剩余比例的跳变，窗口长度只是事件的展示字段。
		if err := store.advanceQuotaDetector(ctx, transaction, snapshot, observation); err != nil {
			return err
		}
		if observation.WindowMinutes <= 0 || observation.ExpectedResetAtMS <= 0 {
			continue
		}
		if _, err := prepared.ExecContext(
			ctx,
			snapshot.AccountRef().String(),
			snapshot.ProviderID(),
			observation.QuotaKey,
			observation.WindowLabel,
			observation.WindowMinutes,
			nullableFloat(remainingPct),
			observation.ExpectedResetAtMS,
			capturedAtMS,
			capturedBucket,
			snapshot.PlanType(),
			capturedAtMS,
		); err != nil {
			return fmt.Errorf("写入额度窗口采样失败: %w", err)
		}
	}
	return store.maybePruneQuotaWindowSamples(ctx, transaction, capturedAtMS)
}

// maybePruneQuotaWindowSamples 按保留期清理旧采样，最多每 6 小时一次。
func (store *Store) maybePruneQuotaWindowSamples(
	ctx context.Context,
	transaction *sql.Tx,
	nowMS int64,
) error {
	last := store.quotaPruneAtMS.Load()
	if nowMS-last < quotaWindowPruneIntervalMS {
		return nil
	}
	if !store.quotaPruneAtMS.CompareAndSwap(last, nowMS) {
		return nil
	}
	if _, err := transaction.ExecContext(
		ctx,
		"DELETE FROM account_quota_window_samples WHERE captured_at_ms < ?",
		nowMS-QuotaWindowSampleRetentionMS,
	); err != nil {
		// 清理失败不能回滚采样写入：历史多留几天比丢样本好。
		return nil
	}
	return nil
}

// ListQuotaWindowSamples 按账号 / quotaKey / 窗口长度读取一段时间的样本（升序）。
func (store *Store) ListQuotaWindowSamples(
	ctx context.Context,
	accountRef string,
	quotaKey string,
	windowMinutes int64,
	fromMS int64,
	toMS int64,
) ([]usagecore.QuotaWindowSample, error) {
	if store == nil || store.db == nil || ctx == nil || windowMinutes <= 0 {
		return nil, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	query := `
		SELECT quota_key, window_label, window_minutes, remaining_pct,
		       expected_reset_at_ms, captured_at_ms, plan_type
		FROM account_quota_window_samples
		WHERE account_ref = ? AND window_minutes = ?
		  AND captured_at_ms >= ? AND captured_at_ms <= ?`
	parameters := []any{accountRef, windowMinutes, fromMS, toMS}
	if quotaKey = strings.TrimSpace(quotaKey); quotaKey != "" {
		query += " AND quota_key = ?"
		parameters = append(parameters, quotaKey)
	}
	query += " ORDER BY captured_at_ms"
	rows, err := store.db.QueryContext(ctx, query, parameters...)
	if err != nil {
		return nil, fmt.Errorf("查询额度窗口采样失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()
	samples := make([]usagecore.QuotaWindowSample, 0, 128)
	for rows.Next() {
		var sample usagecore.QuotaWindowSample
		var remainingPct sql.NullFloat64
		if err := rows.Scan(
			&sample.QuotaKey,
			&sample.WindowLabel,
			&sample.WindowMinutes,
			&remainingPct,
			&sample.ExpectedResetAtMS,
			&sample.CapturedAtMS,
			&sample.PlanType,
		); err != nil {
			return nil, fmt.Errorf("读取额度窗口采样失败: %w", err)
		}
		if remainingPct.Valid {
			value := remainingPct.Float64
			sample.RemainingPct = &value
		}
		samples = append(samples, sample)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历额度窗口采样失败: %w", err)
	}
	return samples, nil
}

// ListQuotaWindowScopes 返回账号下出现过的 (quotaKey, 窗口长度) 及采样覆盖。
func (store *Store) ListQuotaWindowScopes(
	ctx context.Context,
	accountRef string,
) ([]usagecore.QuotaWindowScope, error) {
	if store == nil || store.db == nil || ctx == nil {
		return nil, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	const query = `
		SELECT quota_key, window_label, window_minutes,
		       COUNT(*) AS sample_count, MAX(captured_at_ms) AS last_captured_at_ms
		FROM account_quota_window_samples
		WHERE account_ref = ?
		GROUP BY quota_key, window_minutes
		ORDER BY window_minutes, quota_key`
	rows, err := store.db.QueryContext(ctx, query, accountRef)
	if err != nil {
		return nil, fmt.Errorf("查询额度窗口采样范围失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()
	scopes := make([]usagecore.QuotaWindowScope, 0, 8)
	for rows.Next() {
		var scope usagecore.QuotaWindowScope
		if err := rows.Scan(
			&scope.QuotaKey,
			&scope.WindowLabel,
			&scope.WindowMinutes,
			&scope.SampleCount,
			&scope.LastCapturedAtMS,
		); err != nil {
			return nil, fmt.Errorf("读取额度窗口采样范围失败: %w", err)
		}
		scopes = append(scopes, scope)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历额度窗口采样范围失败: %w", err)
	}
	return scopes, nil
}

// QueryQuotaWindowUsage 在 usage_ledger 上按半开窗口聚合 tokens 与请求数。
//
// 窗口区间由调用方给出且互不重叠（相邻窗口共享边界），半开区间保证不重复计数。
// Go 账本不含定价，成本由调用方标记为不可用，不在这里伪造 0。
func (store *Store) QueryQuotaWindowUsage(
	ctx context.Context,
	accountRef string,
	windows []usagecore.QuotaWindowRange,
) ([]usagecore.QuotaWindowUsage, error) {
	if store == nil || store.db == nil || ctx == nil || len(windows) == 0 {
		return nil, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var builder strings.Builder
	builder.WriteString("WITH w(idx, start_ms, end_ms) AS (VALUES ")
	parameters := make([]any, 0, len(windows)*3+3)
	minStartMS := int64(0)
	maxEndMS := int64(0)
	written := 0
	for _, window := range windows {
		if window.EndMS <= window.StartMS {
			continue
		}
		if written > 0 {
			builder.WriteString(", ")
		}
		builder.WriteString("(?, ?, ?)")
		written++
		parameters = append(parameters, window.Index, window.StartMS, window.EndMS)
		if minStartMS == 0 || window.StartMS < minStartMS {
			minStartMS = window.StartMS
		}
		if window.EndMS > maxEndMS {
			maxEndMS = window.EndMS
		}
	}
	if written == 0 {
		return nil, nil
	}
	builder.WriteString(`
		)
		SELECT w.idx,
		       u.provider_id,
		       u.model_id,
		       COALESCE(SUM(u.input_tokens), 0),
		       COALESCE(SUM(u.output_tokens), 0),
		       COALESCE(SUM(u.cached_input_tokens), 0),
		       COALESCE(SUM(u.cache_write_input_tokens), 0),
		       COALESCE(SUM(u.reasoning_tokens), 0),
		       COALESCE(SUM(u.total_tokens), 0) AS tokens,
		       COUNT(u.usage_id) AS request_count
		FROM usage_ledger AS u
		JOIN w ON u.occurred_at_ms >= w.start_ms AND u.occurred_at_ms < w.end_ms
		WHERE u.account_ref = ? AND u.occurred_at_ms >= ? AND u.occurred_at_ms < ?
		GROUP BY w.idx, u.provider_id, u.model_id
		ORDER BY w.idx`)
	parameters = append(parameters, accountRef, minStartMS, maxEndMS)
	rows, err := store.db.QueryContext(ctx, builder.String(), parameters...)
	if err != nil {
		return nil, fmt.Errorf("按窗口聚合用量失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()
	// 一行是一个 (窗口, Provider, 模型)；按窗口折回去，并把模型明细留在结构里供定价。
	byIndex := make(map[int]*usagecore.QuotaWindowUsage, len(windows))
	order := make([]int, 0, len(windows))
	for rows.Next() {
		var (
			index                                         int
			provider                                      string
			model                                         string
			input, output, cacheRead, cacheCreate, reason int64
			tokens, requests                              int64
		)
		if err := rows.Scan(
			&index, &provider, &model,
			&input, &output, &cacheRead, &cacheCreate, &reason,
			&tokens, &requests,
		); err != nil {
			return nil, fmt.Errorf("读取窗口用量失败: %w", err)
		}
		usage, exists := byIndex[index]
		if !exists {
			usage = &usagecore.QuotaWindowUsage{Index: index}
			byIndex[index] = usage
			order = append(order, index)
		}
		usage.Tokens += tokens
		usage.RequestCount += requests
		usage.Models = append(usage.Models, usagecore.QuotaWindowModelUsage{
			Provider:                 provider,
			Model:                    model,
			InputTokens:              input,
			OutputTokens:             output,
			CacheReadInputTokens:     cacheRead,
			CacheCreationInputTokens: cacheCreate,
			ReasoningOutputTokens:    reason,
			Tokens:                   tokens,
			RequestCount:             requests,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历窗口用量失败: %w", err)
	}
	usages := make([]usagecore.QuotaWindowUsage, 0, len(order))
	for _, index := range order {
		usages = append(usages, *byIndex[index])
	}
	return usages, nil
}
