package managementops

import (
	"context"
	"database/sql"
	"fmt"
)

func queryStatsWithRollupConn(ctx context.Context, conn *sql.Conn, pCtx *UsageProjectionContext, q UsageQuery) (UsageStatsSummary, error) {
	if q.ToMS < q.FromMS {
		return UsageStatsSummary{}, nil
	}
	pCtx = normalizeConnProjectionContext(pCtx)
	plan, err := planRollupReadConn(ctx, conn, q, pCtx, nil, pricingResolverSnapshot{}, 0, 0, nil)
	if err != nil {
		return UsageStatsSummary{}, err
	}

	// 单段全命中汇总快路径：直接在 SQLite 内聚合标量，仅返回 3 行标量。
	if len(plan.rollupRanges) == 1 && len(plan.liveRanges) == 0 {
		rr := plan.rollupRanges[0]
		var out UsageStatsSummary
		mSQL := `
			SELECT COALESCE(SUM(calls), 0),
				COALESCE(SUM(input_tokens), 0),
				COALESCE(SUM(output_tokens), 0),
				COALESCE(SUM(cache_read_input_tokens), 0),
				COALESCE(SUM(cache_creation_input_tokens), 0),
				COALESCE(SUM(reasoning_output_tokens), 0),
				COALESCE(SUM(total_tokens), 0),
				COALESCE(SUM(cost_usd), 0)
			FROM model_usage_rollup_hourly_model
			WHERE hour_ms >= ? AND hour_ms < ?`
		mArgs := []any{rr.StartHour, rr.EndHour}
		if q.Provider != "" {
			mSQL += ` AND provider = ?`
			mArgs = append(mArgs, q.Provider)
		}
		if q.Model != "" {
			mSQL += ` AND model = ?`
			mArgs = append(mArgs, q.Model)
		}
		if err := conn.QueryRowContext(ctx, mSQL, mArgs...).Scan(
			&out.TotalCalls, &out.InputTokens, &out.OutputTokens,
			&out.CacheReadInputTokens, &out.CacheCreationInputTokens,
			&out.ReasoningOutputTokens, &out.TotalTokens, &out.TotalCostUSD,
		); err != nil {
			return UsageStatsSummary{}, fmt.Errorf("查询统计总览失败: %w", err)
		}

		sSQL := `
			SELECT COUNT(DISTINCT provider || ':' || session_id)
			FROM model_usage_rollup_hourly_session
			WHERE hour_ms >= ? AND hour_ms < ?`
		sArgs := []any{rr.StartHour, rr.EndHour}
		if q.Provider != "" {
			sSQL += ` AND provider = ?`
			sArgs = append(sArgs, q.Provider)
		}
		if q.Model != "" {
			sSQL += ` AND model = ?`
			sArgs = append(sArgs, q.Model)
		}
		if err := conn.QueryRowContext(ctx, sSQL, sArgs...).Scan(&out.TotalSessions); err != nil {
			return UsageStatsSummary{}, fmt.Errorf("查询统计会话数失败: %w", err)
		}

		pSQL := `
			SELECT COALESCE(SUM(prompt_count), 0)
			FROM model_usage_rollup_hourly_prompt
			WHERE hour_ms >= ? AND hour_ms < ?`
		pArgs := []any{rr.StartHour, rr.EndHour}
		if q.Provider != "" {
			pSQL += ` AND provider = ?`
			pArgs = append(pArgs, q.Provider)
		}
		if err := conn.QueryRowContext(ctx, pSQL, pArgs...).Scan(&out.TotalPrompts); err != nil {
			return UsageStatsSummary{}, fmt.Errorf("查询提示词统计失败: %w", err)
		}
		out.TotalCostUSD = NormalizeUsageCostUSD(out.TotalCostUSD)
		return out, nil
	}

	acc := newUsagePanelAccumulator(usagePanelOptions{
		provider:    q.Provider,
		model:       q.Model,
		needStats:   true,
		needPrompts: true,
	})
	if len(plan.rollupRanges) > 0 {
		if err := loadRollupModelRowsConn(ctx, conn, acc, plan.rollupRanges, true, false, nil); err != nil {
			return UsageStatsSummary{}, err
		}
		if err := loadRollupSessionRowsConn(ctx, conn, acc, plan.rollupRanges); err != nil {
			return UsageStatsSummary{}, err
		}
		if err := loadRollupPromptRowsConn(ctx, conn, acc, plan.rollupRanges, false); err != nil {
			return UsageStatsSummary{}, err
		}
	}
	if len(plan.liveRanges) > 0 {
		lctx := buildLiveCanonicalContext(pCtx)
		for _, lr := range plan.liveRanges {
			if err := scanLiveCanonicalRangeConn(ctx, conn, acc, lr, lctx, true, true, false); err != nil {
				return UsageStatsSummary{}, err
			}
		}
	}
	return acc.finalizeStats(), nil
}

func queryModelsWithRollupConn(ctx context.Context, conn *sql.Conn, pCtx *UsageProjectionContext, q UsageQuery, includeRefs bool) ([]UsageModelItem, error) {
	if q.ToMS < q.FromMS {
		return []UsageModelItem{}, nil
	}
	pCtx = normalizeConnProjectionContext(pCtx)
	plan, err := planRollupReadConn(ctx, conn, q, pCtx, nil, pricingResolverSnapshot{}, 0, 0, nil)
	if err != nil {
		return nil, err
	}
	acc := newUsagePanelAccumulator(usagePanelOptions{
		provider:   q.Provider,
		model:      q.Model,
		needModels: true,
	})
	if len(plan.rollupRanges) > 0 {
		for _, rr := range plan.rollupRanges {
			query := `
				SELECT provider, model, account_ref,
					SUM(calls), SUM(input_tokens), SUM(output_tokens),
					SUM(cache_read_input_tokens), SUM(cache_creation_input_tokens),
					SUM(reasoning_output_tokens), SUM(total_tokens), SUM(cost_usd)
				FROM model_usage_rollup_hourly_model
				WHERE hour_ms >= ? AND hour_ms < ?`
			args := []any{rr.StartHour, rr.EndHour}
			if q.Provider != "" {
				query += ` AND provider = ?`
				args = append(args, q.Provider)
			}
			if q.Model != "" {
				query += ` AND model = ?`
				args = append(args, q.Model)
			}
			query += ` GROUP BY provider, model, account_ref`
			rows, qErr := conn.QueryContext(ctx, query, args...)
			if qErr != nil {
				return nil, fmt.Errorf("查询模型分布汇总失败: %w", qErr)
			}
			for rows.Next() {
				var (
					prov, model, accountRef                 string
					calls                                   int
					inTok, outTok, cr, cc, reason, totalTok int64
					costUSD                                 float64
				)
				if scanErr := rows.Scan(
					&prov, &model, &accountRef,
					&calls, &inTok, &outTok, &cr, &cc, &reason, &totalTok, &costUSD,
				); scanErr != nil {
					_ = rows.Close()
					return nil, scanErr
				}
				acc.addRollupModelRow(0, prov, model, accountRef, calls, inTok, outTok, cr, cc, reason, totalTok, costUSD, false)
			}
			if err := rows.Err(); err != nil {
				_ = rows.Close()
				return nil, err
			}
			_ = rows.Close()
		}
	}
	if len(plan.liveRanges) > 0 {
		lctx := buildLiveCanonicalContext(pCtx)
		for _, lr := range plan.liveRanges {
			if err := scanLiveCanonicalRangeConn(ctx, conn, acc, lr, lctx, true, false, false); err != nil {
				return nil, err
			}
		}
	}
	return acc.finalizeModels(includeRefs), nil
}

func querySessionPartsWithRollupConn(ctx context.Context, conn *sql.Conn, pCtx *UsageProjectionContext, q UsageQuery, applyLimit bool) ([]UsageSessionPart, error) {
	if q.ToMS < q.FromMS {
		return []UsageSessionPart{}, nil
	}
	pCtx = normalizeConnProjectionContext(pCtx)
	plan, err := planRollupReadConn(ctx, conn, q, pCtx, nil, pricingResolverSnapshot{}, 0, 0, nil)
	if err != nil {
		return nil, err
	}
	acc := newUsagePanelAccumulator(usagePanelOptions{
		provider:     q.Provider,
		model:        q.Model,
		needSessions: true,
		needPrompts:  true,
	})
	if len(plan.rollupRanges) > 0 {
		if err := loadRollupSessionRowsConn(ctx, conn, acc, plan.rollupRanges); err != nil {
			return nil, err
		}
		if err := loadRollupPromptRowsConn(ctx, conn, acc, plan.rollupRanges, true); err != nil {
			return nil, err
		}
	}
	if len(plan.liveRanges) > 0 {
		lctx := buildLiveCanonicalContext(pCtx)
		for _, lr := range plan.liveRanges {
			if err := scanLiveCanonicalRangeConn(ctx, conn, acc, lr, lctx, true, true, false); err != nil {
				return nil, err
			}
		}
	}
	return acc.finalizeSessionParts(ctx, conn, applyLimit, q.Limit)
}

func queryTrendWithRollupConn(ctx context.Context, conn *sql.Conn, pCtx *UsageProjectionContext, q UsageQuery, reqBucketMS, reqOriginMS int64) (UsageTrend, error) {
	originMS, bucketMS, fromMS, toMS := ResolveUsageTrend(q.FromMS, q.ToMS, reqBucketMS, reqOriginMS)
	if originMS <= 0 || bucketMS <= 0 {
		return UsageTrend{FromMS: fromMS, ToMS: toMS, BucketMS: 0, Points: []UsageTrendPoint{}}, nil
	}
	acc := newUsagePanelAccumulator(usagePanelOptions{
		provider:      q.Provider,
		model:         q.Model,
		needTrend:     true,
		trendOriginMS: originMS,
		trendBucketMS: bucketMS,
		trendFromMS:   fromMS,
		trendToMS:     toMS,
	})
	if q.ToMS < q.FromMS {
		return acc.finalizeTrend(), nil
	}

	pCtx = normalizeConnProjectionContext(pCtx)
	plan, err := planRollupReadConn(ctx, conn, q, pCtx, nil, pricingResolverSnapshot{}, originMS, bucketMS, nil)
	if err != nil {
		return UsageTrend{}, err
	}
	straddleSet, straddleRanges, allStraddle := partitionTrendStraddleHours(plan.rollupRanges, originMS, bucketMS)

	liveTrendRanges := append([]timeRange(nil), plan.liveRanges...)
	if allStraddle {
		liveTrendRanges = mergeTimeRanges(append(liveTrendRanges, straddleRanges...))
	} else {
		if len(plan.rollupRanges) > 0 {
			if len(straddleSet) == 0 {
				// 全部完整小时与趋势桶对齐：直接在 SQLite 内按桶索引聚合。
				for _, rr := range plan.rollupRanges {
					query := `
						SELECT CAST((hour_ms - ?) / ? AS INTEGER) AS bucket_index,
							COALESCE(SUM(calls), 0),
							COALESCE(SUM(input_tokens), 0),
							COALESCE(SUM(output_tokens), 0),
							COALESCE(SUM(cache_read_input_tokens), 0),
							COALESCE(SUM(cache_creation_input_tokens), 0),
							COALESCE(SUM(reasoning_output_tokens), 0),
							COALESCE(SUM(total_tokens), 0),
							COALESCE(SUM(cost_usd), 0)
						FROM model_usage_rollup_hourly_model
						WHERE hour_ms >= ? AND hour_ms < ?`
					args := []any{originMS, bucketMS, rr.StartHour, rr.EndHour}
					if q.Provider != "" {
						query += ` AND provider = ?`
						args = append(args, q.Provider)
					}
					if q.Model != "" {
						query += ` AND model = ?`
						args = append(args, q.Model)
					}
					query += ` GROUP BY bucket_index`
					rows, qErr := conn.QueryContext(ctx, query, args...)
					if qErr != nil {
						return UsageTrend{}, fmt.Errorf("查询趋势分桶汇总失败: %w", qErr)
					}
					for rows.Next() {
						var idx, inTok, outTok, cr, cc, reason, totalTok int64
						var calls int
						var costUSD float64
						if scanErr := rows.Scan(
							&idx, &calls, &inTok, &outTok, &cr, &cc, &reason, &totalTok, &costUSD,
						); scanErr != nil {
							_ = rows.Close()
							return UsageTrend{}, scanErr
						}
						acc.addTrendBucket(originMS+idx*bucketMS, calls, inTok, outTok, cr, cc, reason, totalTok, costUSD)
					}
					if err := rows.Err(); err != nil {
						_ = rows.Close()
						return UsageTrend{}, err
					}
					_ = rows.Close()
				}
			} else {
				if err := loadRollupModelRowsConn(ctx, conn, acc, plan.rollupRanges, true, true, straddleSet); err != nil {
					return UsageTrend{}, err
				}
				liveTrendRanges = mergeTimeRanges(append(liveTrendRanges, straddleRanges...))
			}
		}
	}

	if len(liveTrendRanges) > 0 {
		lctx := buildLiveCanonicalContext(pCtx)
		for _, lr := range liveTrendRanges {
			if err := scanLiveCanonicalRangeConn(ctx, conn, acc, lr, lctx, true, false, true); err != nil {
				return UsageTrend{}, err
			}
		}
	}
	return acc.finalizeTrend(), nil
}
