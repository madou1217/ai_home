package managementops

import (
	"context"
	"database/sql"
	"fmt"
)

func loadRollupModelRowsConn(
	ctx context.Context,
	conn *sql.Conn,
	acc *usagePanelAccumulator,
	rollupRanges []hourRange,
	includeModelFilter bool,
	trendEnabled bool,
	straddleSet map[int64]bool,
) error {
	for _, rr := range rollupRanges {
		query := `
			SELECT hour_ms, provider, model, account_ref,
				calls, input_tokens, output_tokens, cache_read_input_tokens,
				cache_creation_input_tokens, reasoning_output_tokens, total_tokens, cost_usd
			FROM model_usage_rollup_hourly_model
			WHERE hour_ms >= ? AND hour_ms < ?`
		args := []any{rr.StartHour, rr.EndHour}
		if acc.opts.provider != "" {
			query += ` AND provider = ?`
			args = append(args, acc.opts.provider)
		}
		if includeModelFilter && acc.opts.model != "" {
			query += ` AND model = ?`
			args = append(args, acc.opts.model)
		}
		rows, err := conn.QueryContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("查询小时模型汇总失败: %w", err)
		}
		for rows.Next() {
			var (
				hourMS, inTok, outTok, cr, cc, reason, totalTok int64
				provider, model, accountRef                     string
				calls                                           int
				costUSD                                         float64
			)
			if scanErr := rows.Scan(
				&hourMS, &provider, &model, &accountRef,
				&calls, &inTok, &outTok, &cr, &cc, &reason, &totalTok, &costUSD,
			); scanErr != nil {
				_ = rows.Close()
				return scanErr
			}
			incTrend := trendEnabled && (straddleSet == nil || !straddleSet[hourMS])
			acc.addRollupModelRow(
				hourMS, provider, model, accountRef, calls,
				inTok, outTok, cr, cc, reason, totalTok, costUSD, incTrend,
			)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return err
		}
		_ = rows.Close()
	}
	return nil
}

func loadRollupSessionRowsConn(
	ctx context.Context,
	conn *sql.Conn,
	acc *usagePanelAccumulator,
	rollupRanges []hourRange,
) error {
	for _, rr := range rollupRanges {
		if !acc.opts.needSessions {
			query := `
				SELECT DISTINCT provider, session_id
				FROM model_usage_rollup_hourly_session
				WHERE hour_ms >= ? AND hour_ms < ?`
			args := []any{rr.StartHour, rr.EndHour}
			if acc.opts.provider != "" {
				query += ` AND provider = ?`
				args = append(args, acc.opts.provider)
			}
			if acc.opts.model != "" {
				query += ` AND model = ?`
				args = append(args, acc.opts.model)
			}
			rows, err := conn.QueryContext(ctx, query, args...)
			if err != nil {
				return fmt.Errorf("查询小时会话去重计数失败: %w", err)
			}
			for rows.Next() {
				var prov, sid string
				if scanErr := rows.Scan(&prov, &sid); scanErr != nil {
					_ = rows.Close()
					return scanErr
				}
				if sid != "" {
					acc.sessionKeys[prov+"\x00"+sid] = struct{}{}
				}
			}
			if err := rows.Err(); err != nil {
				_ = rows.Close()
				return err
			}
			_ = rows.Close()
			continue
		}

		query := `
			SELECT provider, session_id, account_ref,
				SUM(calls), SUM(input_tokens), SUM(output_tokens),
				SUM(cache_read_input_tokens), SUM(cache_creation_input_tokens),
				SUM(reasoning_output_tokens), SUM(total_tokens), SUM(cost_usd),
				MIN(min_timestamp_ms), MAX(max_timestamp_ms),
				COALESCE(MAX(NULLIF(max_project, '')), ''),
				COALESCE(MAX(NULLIF(max_cwd, '')), ''),
				COALESCE(MAX(NULLIF(max_git_branch, '')), '')
			FROM model_usage_rollup_hourly_session
			WHERE hour_ms >= ? AND hour_ms < ?`
		args := []any{rr.StartHour, rr.EndHour}
		if acc.opts.provider != "" {
			query += ` AND provider = ?`
			args = append(args, acc.opts.provider)
		}
		if acc.opts.model != "" {
			query += ` AND model = ?`
			args = append(args, acc.opts.model)
		}
		query += ` GROUP BY provider, session_id, account_ref`

		rows, err := conn.QueryContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("查询小时会话汇总失败: %w", err)
		}
		for rows.Next() {
			var (
				prov, sid, accountRef, maxProj, maxCWD, maxBranch     string
				calls                                                 int
				inTok, outTok, cr, cc, reason, totalTok, minTS, maxTS int64
				costUSD                                               float64
			)
			if scanErr := rows.Scan(
				&prov, &sid, &accountRef,
				&calls, &inTok, &outTok, &cr, &cc, &reason, &totalTok, &costUSD,
				&minTS, &maxTS, &maxProj, &maxCWD, &maxBranch,
			); scanErr != nil {
				_ = rows.Close()
				return scanErr
			}
			acc.addSessionAggregate(
				prov, sid, accountRef, calls,
				inTok, outTok, cr, cc, reason, totalTok, costUSD,
				minTS, maxTS, maxProj, maxCWD, maxBranch,
			)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return err
		}
		_ = rows.Close()
	}
	return nil
}

func loadRollupPromptRowsConn(
	ctx context.Context,
	conn *sql.Conn,
	acc *usagePanelAccumulator,
	rollupRanges []hourRange,
	onlyNonEmptySession bool,
) error {
	for _, rr := range rollupRanges {
		if !acc.opts.needSessions {
			query := `
				SELECT COALESCE(SUM(prompt_count), 0)
				FROM model_usage_rollup_hourly_prompt
				WHERE hour_ms >= ? AND hour_ms < ?`
			args := []any{rr.StartHour, rr.EndHour}
			if acc.opts.provider != "" {
				query += ` AND provider = ?`
				args = append(args, acc.opts.provider)
			}
			var cnt int
			if err := conn.QueryRowContext(ctx, query, args...).Scan(&cnt); err != nil {
				return fmt.Errorf("查询小时提示词汇总失败: %w", err)
			}
			acc.stats.TotalPrompts += cnt
			continue
		}

		query := `
			SELECT provider, session_id, SUM(prompt_count)
			FROM model_usage_rollup_hourly_prompt
			WHERE hour_ms >= ? AND hour_ms < ?`
		args := []any{rr.StartHour, rr.EndHour}
		if onlyNonEmptySession {
			query += ` AND session_id != ''`
		}
		if acc.opts.provider != "" {
			query += ` AND provider = ?`
			args = append(args, acc.opts.provider)
		}
		query += ` GROUP BY provider, session_id`

		rows, err := conn.QueryContext(ctx, query, args...)
		if err != nil {
			return fmt.Errorf("查询小时会话提示词汇总失败: %w", err)
		}
		for rows.Next() {
			var prov, sid string
			var cnt int
			if scanErr := rows.Scan(&prov, &sid, &cnt); scanErr != nil {
				_ = rows.Close()
				return scanErr
			}
			acc.addPromptCount(prov, sid, cnt)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return err
		}
		_ = rows.Close()
	}
	return nil
}

func normalizeConnProjectionContext(pCtx *UsageProjectionContext) *UsageProjectionContext {
	if pCtx != nil {
		return pCtx
	}
	return &UsageProjectionContext{
		RecordHighWaterID:    -1,
		PromptHighWaterRowID: -1,
	}
}
