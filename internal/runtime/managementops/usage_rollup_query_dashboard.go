package managementops

import (
	"context"
	"math"
)

// queryDashboardCombined 是 QueryDashboard 与 QueryDashboardShard 共用的单连接/单快照聚合内核。
func (s *UsageStore) queryDashboardCombined(
	ctx context.Context,
	q UsageQuery,
	reqBucketMS, reqOriginMS int64,
	prebuilt *UsageProjectionContext,
	includeModelRefs bool,
	applySessionLimit bool,
) (stats UsageStatsSummary, models []UsageModelItem, modelOptions []UsageModelItem, parts []UsageSessionPart, trend UsageTrend, err error) {
	originMS, bucketMS, fromMS, toMS := ResolveUsageTrend(q.FromMS, q.ToMS, reqBucketMS, reqOriginMS)
	if q.ToMS < q.FromMS {
		return UsageStatsSummary{}, []UsageModelItem{}, []UsageModelItem{}, []UsageSessionPart{}, UsageTrend{
			FromMS:   fromMS,
			ToMS:     toMS,
			BucketMS: bucketMS,
			Points:   listEmptyTrendPoints(fromMS, toMS, originMS, bucketMS),
		}, nil
	}

	// 1. 在不持有任何 *sql.Conn 时同步窗口内的持久化小时汇总（只读库/遇忙自动降级）。
	firstFull, lastFullEnd := fullHourWindow(q.FromMS, q.ToMS)
	if firstFull < lastFullEnd {
		if syncErr := s.ensureRollupSyncedForRange(ctx, firstFull, lastFullEnd); syncErr != nil {
			return UsageStatsSummary{}, nil, nil, nil, UsageTrend{}, syncErr
		}
	}

	// 2. 使用单连接 + beginProjectionReadSnapshot 读快照，保证四段聚合视图完全一致、取消安全且不争抢连接池。
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return UsageStatsSummary{}, nil, nil, nil, UsageTrend{}, err
	}
	defer func() { _ = conn.Close() }()

	snap, err := beginProjectionReadSnapshot(ctx, conn)
	if err != nil {
		return UsageStatsSummary{}, nil, nil, nil, UsageTrend{}, err
	}
	defer snap.close()

	capReport, err := inspectRollupCapabilitiesQueryer(ctx, conn)
	if err != nil {
		return UsageStatsSummary{}, nil, nil, nil, UsageTrend{}, err
	}

	var (
		curForks   []forkDescriptor
		curPricing pricingResolverSnapshot
	)
	if prebuilt == nil {
		if capReport.allReady {
			curForks, _, err = s.getCachedForkDescriptorsConn(ctx, conn, capReport.meta.forkRev)
		} else {
			curForks, err = readForkDescriptorsConn(ctx, conn)
		}
		if err != nil {
			return UsageStatsSummary{}, nil, nil, nil, UsageTrend{}, err
		}
		// 严格在同一 BEGIN DEFERRED 事务内现读定价，绝不复用 3s TTL 缓存。
		curPricing, err = loadStrictPricingSnapshotConn(ctx, conn)
		if err != nil {
			return UsageStatsSummary{}, nil, nil, nil, UsageTrend{}, err
		}
	}

	plan, err := planRollupReadConn(ctx, conn, q, prebuilt, curForks, curPricing, originMS, bucketMS, &capReport)
	if err != nil {
		return UsageStatsSummary{}, nil, nil, nil, UsageTrend{}, err
	}

	var (
		straddleSet       map[int64]bool
		straddleRanges    []timeRange
		allStraddle       bool
		resolvedLiveAttrs []usageAttribution
		persistedStraddle []usageAttribution
	)
	if prebuilt != nil {
		straddleSet, straddleRanges, allStraddle = partitionTrendStraddleHours(plan.rollupRanges, originMS, bucketMS)
		// 若全部汇总小时都跨越趋势桶边界（例如 1 天 15m 桶查询），直接单趟原始扫描同时产出全部面板，避免重复读。
		if allStraddle && len(plan.rollupRanges) > 0 {
			plan.rollupRanges = nil
			plan.liveRanges = []timeRange{{FromMS: q.FromMS, ToMS: q.ToMS}}
			straddleSet = nil
			straddleRanges = nil
		}
	} else {
		hadInitialRollup := len(plan.rollupRanges) > 0
		_, _, initAllStraddle := partitionTrendStraddleHours(plan.rollupRanges, originMS, bucketMS)
		collapsedAllStraddle := initAllStraddle && hadInitialRollup
		if collapsedAllStraddle {
			plan.rollupRanges = nil
			plan.liveRanges = []timeRange{{FromMS: q.FromMS, ToMS: q.ToMS}}
		}

		forksByHash := make(map[string]forkDescriptor, len(curForks))
		for _, f := range curForks {
			forksByHash[f.SourceHash] = f
		}
		res, pErr := s.resolvePartitionedAttributionsConn(ctx, conn, q, plan, math.MaxInt64, forksByHash, curPricing)
		if pErr != nil {
			return UsageStatsSummary{}, nil, nil, nil, UsageTrend{}, pErr
		}

		applyGlobalFallback := func(globalAttrs []usageAttribution) error {
			globalPCtx := &UsageProjectionContext{
				ForkDescriptors:      curForks,
				Attributions:         globalAttrs,
				RecordHighWaterID:    -1,
				PromptHighWaterRowID: -1,
			}
			prebuilt = globalPCtx
			if plan.rollupReady && hadInitialRollup && !collapsedAllStraddle {
				rePlan, reErr := planRollupReadConn(ctx, conn, q, globalPCtx, nil, pricingResolverSnapshot{}, originMS, bucketMS, &capReport)
				if reErr != nil {
					return reErr
				}
				plan = rePlan
			}
			straddleSet, straddleRanges, allStraddle = partitionTrendStraddleHours(plan.rollupRanges, originMS, bucketMS)
			if allStraddle && len(plan.rollupRanges) > 0 {
				plan.rollupRanges = nil
				plan.liveRanges = []timeRange{{FromMS: q.FromMS, ToMS: q.ToMS}}
				straddleSet = nil
				straddleRanges = nil
			}
			return nil
		}

		if res.usedGlobalFallback {
			if fbErr := applyGlobalFallback(res.liveAttrs); fbErr != nil {
				return UsageStatsSummary{}, nil, nil, nil, UsageTrend{}, fbErr
			}
		} else {
			plan = res.plan
			resolvedLiveAttrs = res.liveAttrs
			straddleSet, straddleRanges, _ = partitionTrendStraddleHours(plan.rollupRanges, originMS, bucketMS)
			if len(straddleRanges) > 0 && originMS > 0 && bucketMS > 0 {
				attrFrom, attrTo := queryAttributionBounds(q)
				pAttrs, pOK, pLoadErr := loadValidatedPersistedAttributionsForRangesConn(
					ctx, conn, plan.rollupRanges, timeRangesToHourRanges(straddleRanges), attrFrom, attrTo, math.MaxInt64,
				)
				if pLoadErr != nil {
					return UsageStatsSummary{}, nil, nil, nil, UsageTrend{}, pLoadErr
				}
				if !pOK {
					globalAttrs, gErr := computeAttributionsRangeConn(
						ctx, conn, attrFrom, attrTo, math.MaxInt64, forksByHash, curPricing, s.attribution,
					)
					if gErr != nil {
						return UsageStatsSummary{}, nil, nil, nil, UsageTrend{}, gErr
					}
					if fbErr := applyGlobalFallback(globalAttrs); fbErr != nil {
						return UsageStatsSummary{}, nil, nil, nil, UsageTrend{}, fbErr
					}
				} else {
					persistedStraddle = pAttrs
				}
			}
		}
	}

	needOpts := q.Model != ""
	acc := newUsagePanelAccumulator(usagePanelOptions{
		provider:         q.Provider,
		model:            q.Model,
		needStats:        true,
		needModels:       true,
		needModelOptions: needOpts,
		needSessions:     true,
		needPrompts:      true,
		needTrend:        originMS > 0 && bucketMS > 0,
		trendOriginMS:    originMS,
		trendBucketMS:    bucketMS,
		trendFromMS:      fromMS,
		trendToMS:        toMS,
	})

	// 3. 读取全部已验证的小时汇总区间。
	if len(plan.rollupRanges) > 0 {
		if err := loadRollupModelRowsConn(ctx, conn, acc, plan.rollupRanges, !needOpts, true, straddleSet); err != nil {
			return UsageStatsSummary{}, nil, nil, nil, UsageTrend{}, err
		}
		if err := loadRollupSessionRowsConn(ctx, conn, acc, plan.rollupRanges); err != nil {
			return UsageStatsSummary{}, nil, nil, nil, UsageTrend{}, err
		}
		if err := loadRollupPromptRowsConn(ctx, conn, acc, plan.rollupRanges, false); err != nil {
			return UsageStatsSummary{}, nil, nil, nil, UsageTrend{}, err
		}
	}

	// 4. 对跨趋势桶边界的少量已汇总小时（仅在未对齐长窗出现），复用经验证的归因只补算趋势桶。
	if len(straddleRanges) > 0 && originMS > 0 && bucketMS > 0 {
		trendAcc := newUsagePanelAccumulator(usagePanelOptions{
			provider:      q.Provider,
			model:         q.Model,
			needTrend:     true,
			trendOriginMS: originMS,
			trendBucketMS: bucketMS,
			trendFromMS:   fromMS,
			trendToMS:     toMS,
		})
		var lctx liveCanonicalContext
		if prebuilt != nil {
			lctx = buildLiveCanonicalContext(prebuilt)
		} else {
			lctx = buildLiveCanonicalContext(&UsageProjectionContext{
				ForkDescriptors:      curForks,
				Attributions:         persistedStraddle,
				RecordHighWaterID:    -1,
				PromptHighWaterRowID: -1,
			})
		}
		for _, sr := range straddleRanges {
			if err := scanLiveCanonicalRangeConn(ctx, conn, trendAcc, sr, lctx, true, false, true); err != nil {
				return UsageStatsSummary{}, nil, nil, nil, UsageTrend{}, err
			}
		}
		for start, pt := range trendAcc.trendByStart {
			acc.addTrendBucket(
				start, pt.Calls, pt.InputTokens, pt.OutputTokens,
				pt.CacheReadInputTokens, pt.CacheCreationInputTokens,
				pt.ReasoningOutputTokens, pt.TotalTokens, pt.CostUSD,
			)
		}
	}

	// 5. 对边缘毫秒片段、未覆盖或经边界闭包含并的实时区间执行单趟 Go 规范扫描，同时写入全部面板。
	if len(plan.liveRanges) > 0 {
		var lctx liveCanonicalContext
		if prebuilt != nil {
			lctx = buildLiveCanonicalContext(prebuilt)
		} else {
			lctx = buildLiveCanonicalContext(&UsageProjectionContext{
				ForkDescriptors:      curForks,
				Attributions:         resolvedLiveAttrs,
				RecordHighWaterID:    -1,
				PromptHighWaterRowID: -1,
			})
		}
		for _, lr := range plan.liveRanges {
			if err := scanLiveCanonicalRangeConn(ctx, conn, acc, lr, lctx, true, true, true); err != nil {
				return UsageStatsSummary{}, nil, nil, nil, UsageTrend{}, err
			}
		}
	}

	stats = acc.finalizeStats()
	models = acc.finalizeModels(includeModelRefs)
	if needOpts {
		modelOptions = acc.finalizeModelOptions(includeModelRefs)
	} else {
		modelOptions = models
	}
	parts, err = acc.finalizeSessionParts(ctx, conn, applySessionLimit, q.Limit)
	if err != nil {
		return UsageStatsSummary{}, nil, nil, nil, UsageTrend{}, err
	}
	trend = acc.finalizeTrend()
	return stats, models, modelOptions, parts, trend, nil
}

func listEmptyTrendPoints(fromMS, toMS, originMS, bucketMS int64) []UsageTrendPoint {
	starts := listTrendBucketStarts(fromMS, toMS, originMS, bucketMS)
	points := make([]UsageTrendPoint, 0, len(starts))
	for _, st := range starts {
		points = append(points, UsageTrendPoint{BucketStartMS: st})
	}
	return points
}

func (s *UsageStore) queryDashboardWithRollup(ctx context.Context, q UsageQuery) (UsageDashboardPayload, error) {
	stats, models, modelOptions, parts, trend, err := s.queryDashboardCombined(ctx, q, 0, 0, nil, false, true)
	if err != nil {
		return UsageDashboardPayload{}, err
	}
	sessions := make([]UsageSessionItem, 0, len(parts))
	for _, p := range parts {
		sessions = append(sessions, materializeSessionFromPart(p))
	}
	return UsageDashboardPayload{
		Stats:        stats,
		Models:       models,
		Sessions:     sessions,
		ModelOptions: modelOptions,
		Trend:        trend,
	}, nil
}

func (s *UsageStore) queryDashboardShardWithRollup(
	ctx context.Context,
	q UsageQuery,
	overallTrendBucketMS, overallTrendOriginMS int64,
	prebuilt *UsageProjectionContext,
) (UsageDashboardShard, error) {
	stats, models, modelOptions, parts, trend, err := s.queryDashboardCombined(
		ctx, q, overallTrendBucketMS, overallTrendOriginMS, prebuilt, true, false,
	)
	if err != nil {
		return UsageDashboardShard{}, err
	}
	return UsageDashboardShard{
		Stats:        stats,
		Models:       models,
		SessionParts: parts,
		ModelOptions: modelOptions,
		Trend:        trend,
	}, nil
}
