package managementops

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"sort"
	"sync"
	"sync/atomic"
)

// tryComputeColdDashboardShards 面向首次无汇总覆盖的长窗（>=30d，含 FromMS=0）渐进看板作业：
// 在请求私有的 3 连接同版本只读 WAL 快照队列上，复用 scanRollupHourRangeConn 并行计算小时聚合，
// 通过虚拟计划边界闭合求得整窗精确归因，再在同一快照队列上产出与原有分片器完全一致的 []UsageDashboardShard；
// 返回前关闭并回收全部快照与连接（零持久化写、零共享缓存、零跨调用租约）。
// 不符合条件或遇不可闭合边界/并发版本变动时返回 eligible=false，由调用方安全回退至原有路径。
func (s *UsageStore) tryComputeColdDashboardShards(
	ctx context.Context,
	query UsageQuery,
	shards []UsageQuery,
	overallTrendOriginMS, overallTrendBucketMS int64,
) ([]UsageDashboardShard, bool, error) {
	if s == nil || s.db == nil {
		return nil, false, ErrUsageUnavailable
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	if len(shards) == 0 {
		return nil, false, nil
	}

	q := normalizeUsageQueryBounds(query)
	if q.ToMS < q.FromMS || q.ToMS-q.FromMS < coldDashboardMinSpanMS-1 {
		return nil, false, nil
	}
	firstFull, lastFullEnd := fullHourWindow(q.FromMS, q.ToMS)
	resolvedOrigin, resolvedBucket, _, _ := ResolveUsageTrend(q.FromMS, q.ToMS, overallTrendBucketMS, overallTrendOriginMS)
	if !isColdDashboardTrendSupported(firstFull, lastFullEnd, resolvedOrigin, resolvedBucket) {
		return nil, false, nil
	}
	normShards, shardsValid := normalizeAndValidateColdShards(q, shards)
	if !shardsValid {
		return nil, false, nil
	}

	cohort, ok, err := s.openColdSnapshotCohort(ctx)
	if err != nil || !ok {
		return nil, false, err
	}
	defer cohort.close()

	baseSlot := cohort.slots[0]
	forks, forkDigest, err := s.getCachedForkDescriptorsConn(ctx, baseSlot.conn, baseSlot.capReport.meta.forkRev)
	if err != nil {
		return nil, false, err
	}
	pricingSnap, customPricingDigest, err := baseSlot.pricingCache.loadConn(ctx, s, baseSlot.conn, baseSlot.capReport)
	if err != nil {
		return nil, false, err
	}
	needCold, err := needsColdComputeConn(ctx, baseSlot.conn, firstFull, lastFullEnd, baseSlot.capReport, forkDigest, customPricingDigest)
	if err != nil || !needCold {
		return nil, false, err
	}
	minTS, maxTS, hasData, hasScanner, err := probeColdActiveBoundsConn(ctx, baseSlot.conn, firstFull, lastFullEnd)
	if err != nil {
		return nil, false, err
	}

	byHour := make(map[int64]*rollupHourBuild)
	if hasData {
		activeStart := maxInt64(firstFull, hourFloorMS(minTS))
		activeEnd := hourFloorMS(maxTS) + rollupHourMS
		if activeEnd < hourFloorMS(maxTS) || activeEnd > lastFullEnd {
			activeEnd = lastFullEnd
		}
		chunkHours := rollupStreamingChunkHours
		if hasScanner {
			chunkHours = rollupAttributedChunkHours
		}
		byHour, ok, err = s.scanColdChunksParallel(ctx, cohort, activeStart, activeEnd, chunkHours*rollupHourMS)
		if err != nil || !ok {
			return nil, false, err
		}
	}

	win, ok, err := s.resolveColdWindowAttributionsConn(ctx, baseSlot, q, firstFull, lastFullEnd, byHour, forks, pricingSnap)
	if err != nil || !ok {
		return nil, false, err
	}
	globalLctx := buildLiveCanonicalContext(&UsageProjectionContext{
		ForkDescriptors:      win.forks,
		Attributions:         win.fullQueryAttrs,
		RecordHighWaterID:    -1,
		PromptHighWaterRowID: -1,
	})
	outShards, err := buildColdShardsParallel(ctx, cohort, normShards, overallTrendOriginMS, overallTrendBucketMS, win, globalLctx)
	if err != nil {
		return nil, false, err
	}
	return outShards, true, nil
}

func normalizeAndValidateColdShards(q UsageQuery, shards []UsageQuery) ([]UsageQuery, bool) {
	out := make([]UsageQuery, len(shards))
	for i, raw := range shards {
		if raw.ToMS <= 0 {
			raw.ToMS = q.ToMS
		}
		sq := normalizeUsageQueryBounds(raw)
		if sq.Provider != q.Provider || sq.Model != q.Model ||
			(sq.ToMS >= sq.FromMS && (sq.FromMS < q.FromMS || sq.ToMS > q.ToMS)) {
			return nil, false
		}
		out[i] = sq
	}
	return out, true
}

// resolveColdWindowAttributionsConn 将全历史闭合得到的 byHour 构造成虚拟 rollupReadPlan，
// 在同快照连接上运行现有 resolvePartitionedAttributionsConn 处理查询边界 [q.FromMS-5m, q.ToMS+5s]。
func (s *UsageStore) resolveColdWindowAttributionsConn(
	ctx context.Context,
	slot *coldCohortSlot,
	q UsageQuery,
	firstFull, lastFullEnd int64,
	byHour map[int64]*rollupHourBuild,
	forks []forkDescriptor,
	pricingSnap pricingResolverSnapshot,
) (coldComputedWindow, bool, error) {
	sortedHours := make([]int64, 0, len(byHour))
	matByHour := make(map[int64]rollupHourMetaRow, len(byHour))
	for h, hb := range byHour {
		sortedHours = append(sortedHours, h)
		matByHour[h] = rollupHourMetaRow{
			hourMS:               h,
			hasLeftBoundaryAttr:  hb.hasLeftBoundaryAttr,
			hasRightBoundaryAttr: hb.hasRightBoundaryAttr,
		}
	}
	sort.Slice(sortedHours, func(i, j int) bool { return sortedHours[i] < sortedHours[j] })

	bypassed := make(map[int64]bool)
	if firstFull-q.FromMS < scannerAfterProxyWindowMS {
		if hb := byHour[firstFull]; hb != nil && hb.hasLeftBoundaryAttr {
			bypassed[firstFull] = true
		}
	}
	lastHour := lastFullEnd - rollupHourMS
	if q.ToMS-lastFullEnd < scannerAfterProxyWindowMS {
		if hb := byHour[lastHour]; hb != nil && hb.hasRightBoundaryAttr {
			bypassed[lastHour] = true
		}
	}

	initRollup, removed := subtractHoursFromRanges([]hourRange{{StartHour: firstFull, EndHour: lastFullEnd}}, bypassed)
	var initLive []timeRange
	if q.FromMS < firstFull {
		initLive = append(initLive, timeRange{FromMS: q.FromMS, ToMS: firstFull - 1})
	}
	for _, rem := range removed {
		initLive = append(initLive, timeRange{FromMS: rem.StartHour, ToMS: rem.EndHour - 1})
	}
	if lastFullEnd <= q.ToMS {
		initLive = append(initLive, timeRange{FromMS: lastFullEnd, ToMS: q.ToMS})
	}
	initLive = mergeTimeRanges(initLive)
	if len(initRollup) == 0 || precheckColdBoundaryOverflow(initRollup, initLive, matByHour) {
		return coldComputedWindow{}, false, nil
	}

	virtualPlan := rollupReadPlan{rollupReady: true, rollupRanges: initRollup, liveRanges: initLive, matByHour: matByHour}
	forksByHash := make(map[string]forkDescriptor, len(forks))
	for _, f := range forks {
		forksByHash[f.SourceHash] = f
	}
	res, err := s.resolvePartitionedAttributionsConn(ctx, slot.conn, q, virtualPlan, math.MaxInt64, forksByHash, pricingSnap)
	if err != nil || res.usedGlobalFallback || len(res.plan.rollupRanges) == 0 {
		return coldComputedWindow{}, false, err
	}
	attrFrom, attrTo := queryAttributionBounds(q)
	rollupAttrs, ok := collectValidatedColdRollupAttrs(byHour, sortedHours, res.plan.rollupRanges, attrFrom, attrTo)
	if !ok {
		return coldComputedWindow{}, false, nil
	}
	fullAttrs, disjointOK := mergeDisjointAttributions(rollupAttrs, res.liveAttrs)
	if !disjointOK {
		return coldComputedWindow{}, false, nil
	}
	return coldComputedWindow{
		byHour:         byHour,
		sortedHours:    sortedHours,
		rollupRanges:   res.plan.rollupRanges,
		liveRanges:     res.plan.liveRanges,
		fullQueryAttrs: fullAttrs,
		forks:          append([]forkDescriptor(nil), forks...),
	}, true, nil
}

func buildColdShardsParallel(ctx context.Context, cohort *coldSnapshotCohort, shards []UsageQuery, overallTrendOriginMS, overallTrendBucketMS int64, win coldComputedWindow, globalLctx liveCanonicalContext) ([]UsageDashboardShard, error) {
	out := make([]UsageDashboardShard, len(shards))
	workerCount := min(len(cohort.slots), len(shards))
	workerCtx, cancel := context.WithCancelCause(ctx)
	defer cancel(nil)

	tasks := make(chan int, len(shards))
	for i := range shards {
		tasks <- i
	}
	close(tasks)

	var errMu sync.Mutex
	var firstErr error
	var completed atomic.Int64
	var wg sync.WaitGroup
	for w := 0; w < workerCount; w++ {
		conn := cohort.slots[w].conn
		wg.Add(1)
		go func() {
			defer wg.Done()
			for idx := range tasks {
				if workerCtx.Err() != nil {
					return
				}
				sh, shErr := buildColdDashboardShardConn(workerCtx, conn, shards[idx], overallTrendOriginMS, overallTrendBucketMS, win, globalLctx)
				if shErr != nil {
					if !isInternalWorkerCancelErr(ctx, workerCtx, shErr) {
						errMu.Lock()
						if firstErr == nil {
							firstErr = shErr
						}
						errMu.Unlock()
						cancel(errColdSiblingFailed)
					}
					return
				}
				out[idx] = sh
				completed.Add(1)
			}
		}()
	}
	wg.Wait()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if firstErr != nil {
		return nil, firstErr
	}
	if int(completed.Load()) != len(shards) {
		return nil, errors.New("cold_dashboard_shards_incomplete")
	}
	return out, nil
}

func buildColdDashboardShardConn(ctx context.Context, conn *sql.Conn, sq UsageQuery, overallTrendOriginMS, overallTrendBucketMS int64, win coldComputedWindow, globalLctx liveCanonicalContext) (UsageDashboardShard, error) {
	originMS, bucketMS, fromMS, toMS := ResolveUsageTrend(sq.FromMS, sq.ToMS, overallTrendBucketMS, overallTrendOriginMS)
	if sq.ToMS < sq.FromMS {
		return UsageDashboardShard{
			Models: []UsageModelItem{}, SessionParts: []UsageSessionPart{}, ModelOptions: []UsageModelItem{},
			Trend: UsageTrend{FromMS: fromMS, ToMS: toMS, BucketMS: bucketMS, Points: listEmptyTrendPoints(fromMS, toMS, originMS, bucketMS)},
		}, nil
	}

	needOpts := sq.Model != ""
	needTrend := originMS > 0 && bucketMS > 0
	acc := newUsagePanelAccumulator(usagePanelOptions{
		provider: sq.Provider, model: sq.Model, needStats: true, needModels: true,
		needModelOptions: needOpts, needSessions: true, needPrompts: true, needTrend: needTrend,
		trendOriginMS: originMS, trendBucketMS: bucketMS, trendFromMS: fromMS, trendToMS: toMS,
	})

	var straddleRanges []timeRange
	sFirstFull, sLastFullEnd := fullHourWindow(sq.FromMS, sq.ToMS)
	shardRollup := intersectHourRanges(win.rollupRanges, sFirstFull, sLastFullEnd)
	for _, rr := range shardRollup {
		idx := sort.Search(len(win.sortedHours), func(i int) bool { return win.sortedHours[i] >= rr.StartHour })
		for i := idx; i < len(win.sortedHours) && win.sortedHours[i] < rr.EndHour; i++ {
			h := win.sortedHours[i]
			hb := win.byHour[h]
			aligned := !needTrend || isHourAlignedToTrendBucket(h, originMS, bucketMS)
			feedColdHourIntoAcc(acc, h, hb, aligned)
			if !aligned && len(hb.models) > 0 {
				straddleRanges = append(straddleRanges, timeRange{FromMS: h, ToMS: h + rollupHourMS - 1})
			}
		}
	}
	if len(straddleRanges) > 0 {
		trendAcc := newUsagePanelAccumulator(usagePanelOptions{
			provider: sq.Provider, model: sq.Model, needTrend: true,
			trendOriginMS: originMS, trendBucketMS: bucketMS, trendFromMS: fromMS, trendToMS: toMS,
		})
		for _, sr := range mergeTimeRanges(straddleRanges) {
			if err := scanLiveCanonicalRangeConn(ctx, conn, trendAcc, sr, globalLctx, true, false, true); err != nil {
				return UsageDashboardShard{}, err
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
	for _, lr := range complementTimeRanges(sq.FromMS, sq.ToMS, shardRollup) {
		if err := scanLiveCanonicalRangeConn(ctx, conn, acc, lr, globalLctx, true, true, true); err != nil {
			return UsageDashboardShard{}, err
		}
	}

	stats := acc.finalizeStats()
	models := acc.finalizeModels(true)
	modelOptions := models
	if needOpts {
		modelOptions = acc.finalizeModelOptions(true)
	}
	parts, err := acc.finalizeSessionParts(ctx, conn, false, sq.Limit)
	if err != nil {
		return UsageDashboardShard{}, err
	}
	return UsageDashboardShard{Stats: stats, Models: models, SessionParts: parts, ModelOptions: modelOptions, Trend: acc.finalizeTrend()}, nil
}

func feedColdHourIntoAcc(acc *usagePanelAccumulator, h int64, hb *rollupHourBuild, includeTrend bool) {
	for mk, mAgg := range hb.models {
		acc.addRollupModelRow(
			h, mk.provider, mk.model, mk.accountRef, mAgg.calls,
			mAgg.inputTokens, mAgg.outputTokens, mAgg.cacheReadInputTokens,
			mAgg.cacheCreationInputTokens, mAgg.reasoningOutputTokens,
			mAgg.totalTokens, mAgg.costUSD, includeTrend,
		)
	}
	for sk, sAgg := range hb.sessions {
		if (acc.opts.provider != "" && sk.provider != acc.opts.provider) ||
			(acc.opts.model != "" && sk.model != acc.opts.model) {
			continue
		}
		acc.addSessionAggregate(
			sk.provider, sk.sessionID, sk.accountRef, sAgg.calls,
			sAgg.inputTokens, sAgg.outputTokens, sAgg.cacheReadInputTokens,
			sAgg.cacheCreationInputTokens, sAgg.reasoningOutputTokens,
			sAgg.totalTokens, sAgg.costUSD,
			sAgg.minTimestampMS, sAgg.maxTimestampMS,
			sAgg.maxProject, sAgg.maxCWD, sAgg.maxGitBranch,
		)
	}
	for pk, cnt := range hb.prompts {
		acc.addPromptCount(pk.provider, pk.sessionID, cnt)
	}
}

func intersectHourRanges(ranges []hourRange, startHour, endHour int64) []hourRange {
	if endHour <= startHour || len(ranges) == 0 {
		return nil
	}
	var out []hourRange
	for _, rr := range ranges {
		if rr.EndHour <= startHour {
			continue
		}
		if rr.StartHour >= endHour {
			break
		}
		if s, e := maxInt64(rr.StartHour, startHour), minInt64Val(rr.EndHour, endHour); e > s {
			out = append(out, hourRange{StartHour: s, EndHour: e})
		}
	}
	return out
}

func complementTimeRanges(fromMS, toMS int64, covered []hourRange) []timeRange {
	if toMS < fromMS {
		return nil
	}
	var out []timeRange
	cursor := fromMS
	for _, rr := range covered {
		if rr.StartHour > cursor {
			out = append(out, timeRange{FromMS: cursor, ToMS: rr.StartHour - 1})
		}
		cursor = rr.EndHour
	}
	if cursor <= toMS {
		out = append(out, timeRange{FromMS: cursor, ToMS: toMS})
	}
	return out
}
