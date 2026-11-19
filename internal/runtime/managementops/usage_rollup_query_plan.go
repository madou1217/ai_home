package managementops

import (
	"context"
	"database/sql"
	"math"
	"sort"
)

func fullHourWindow(fromMS, toMS int64) (firstFullHour, lastFullHourEnd int64) {
	if fromMS < 0 {
		fromMS = 0
	}
	if toMS < fromMS {
		return 0, 0
	}
	if fromMS > math.MaxInt64-rollupHourMS {
		return 0, 0
	}
	firstFullHour = ((fromMS + rollupHourMS - 1) / rollupHourMS) * rollupHourMS
	if toMS >= math.MaxInt64-rollupHourMS {
		lastFullHourEnd = (toMS / rollupHourMS) * rollupHourMS
	} else {
		lastFullHourEnd = ((toMS + 1) / rollupHourMS) * rollupHourMS
	}
	if lastFullHourEnd <= firstFullHour {
		return 0, 0
	}
	return firstFullHour, lastFullHourEnd
}

func isHourAlignedToTrendBucket(hourMS, originMS, bucketMS int64) bool {
	if originMS <= 0 || bucketMS <= 0 || hourMS < originMS {
		return false
	}
	return (hourMS-originMS)/bucketMS == (hourMS+rollupHourMS-1-originMS)/bucketMS
}

type rollupHourMetaRow struct {
	hourMS               int64
	maxRecordID          int64
	maxPromptRowID       int64
	attrCount            int
	attrDigest           int64
	forkDigest           int64
	pricingRev           int64
	pricingCustomDigest  int64
	hasCodexFile         bool
	hasLeftBoundaryAttr  bool
	hasRightBoundaryAttr bool
}

type rollupReadPlan struct {
	rollupReady  bool
	rollupRanges []hourRange
	liveRanges   []timeRange
	matByHour    map[int64]rollupHourMetaRow
}

func subtractHoursFromRanges(covered []hourRange, bypassed map[int64]bool) (kept []hourRange, removed []hourRange) {
	if len(covered) == 0 {
		return nil, nil
	}
	if len(bypassed) == 0 {
		return append([]hourRange(nil), covered...), nil
	}
	bypassList := make([]int64, 0, len(bypassed))
	for h := range bypassed {
		bypassList = append(bypassList, h)
	}
	sort.Slice(bypassList, func(i, j int) bool { return bypassList[i] < bypassList[j] })

	bi := 0
	for _, c := range covered {
		for bi < len(bypassList) && bypassList[bi] < c.StartHour {
			bi++
		}
		cur := c.StartHour
		for bi < len(bypassList) && bypassList[bi] < c.EndHour {
			bh := bypassList[bi]
			if bh > cur {
				kept = append(kept, hourRange{StartHour: cur, EndHour: bh})
			}
			removed = append(removed, hourRange{StartHour: bh, EndHour: bh + rollupHourMS})
			cur = bh + rollupHourMS
			bi++
		}
		if cur < c.EndHour {
			kept = append(kept, hourRange{StartHour: cur, EndHour: c.EndHour})
		}
	}
	return kept, removed
}

func mergeTimeRanges(ranges []timeRange) []timeRange {
	if len(ranges) <= 1 {
		return ranges
	}
	sort.Slice(ranges, func(i, j int) bool {
		if ranges[i].FromMS != ranges[j].FromMS {
			return ranges[i].FromMS < ranges[j].FromMS
		}
		return ranges[i].ToMS < ranges[j].ToMS
	})
	out := make([]timeRange, 0, len(ranges))
	for _, r := range ranges {
		if r.ToMS < r.FromMS {
			continue
		}
		if len(out) > 0 {
			last := &out[len(out)-1]
			if r.FromMS <= last.ToMS || (last.ToMS < math.MaxInt64 && r.FromMS == last.ToMS+1) {
				if r.ToMS > last.ToMS {
					last.ToMS = r.ToMS
				}
				continue
			}
		}
		out = append(out, r)
	}
	return out
}

// planRollupReadConn 在当前只读连接/快照下验证汇总能力与有效性，将 [q.FromMS, q.ToMS] 精确切分为
// 互不相交的 rollupRanges（安全复用小时汇总）与 liveRanges（精确扫描原始边缘/旁路小时）。
func planRollupReadConn(
	ctx context.Context,
	conn *sql.Conn,
	q UsageQuery,
	pCtx *UsageProjectionContext,
	curForks []forkDescriptor,
	curPricing pricingResolverSnapshot,
	_ int64,
	_ int64,
	precheckedCap *rollupCapabilityReport,
) (rollupReadPlan, error) {
	if q.ToMS < q.FromMS {
		return rollupReadPlan{}, nil
	}
	firstFull, lastFullEnd := fullHourWindow(q.FromMS, q.ToMS)
	if firstFull >= lastFullEnd {
		return rollupReadPlan{
			rollupReady: false,
			liveRanges:  []timeRange{{FromMS: q.FromMS, ToMS: q.ToMS}},
		}, nil
	}

	var capReport rollupCapabilityReport
	if precheckedCap != nil {
		capReport = *precheckedCap
	} else {
		var err error
		capReport, err = inspectRollupCapabilitiesQueryer(ctx, conn)
		if err != nil {
			return rollupReadPlan{}, err
		}
	}
	if !capReport.allReady {
		return rollupReadPlan{
			rollupReady: false,
			liveRanges:  []timeRange{{FromMS: q.FromMS, ToMS: q.ToMS}},
		}, nil
	}
	meta := capReport.meta

	covered, err := readCoverageRangesConn(ctx, conn, firstFull, lastFullEnd)
	if err != nil {
		return rollupReadPlan{}, err
	}
	if len(covered) == 0 {
		return rollupReadPlan{
			rollupReady: true,
			liveRanges:  []timeRange{{FromMS: q.FromMS, ToMS: q.ToMS}},
		}, nil
	}

	bypassed := make(map[int64]bool)

	// 1. 排除全部未同步的脏小时。
	dRows, err := conn.QueryContext(ctx, `
		SELECT hour_ms FROM model_usage_rollup_dirty_hours
		WHERE hour_ms >= ? AND hour_ms < ?`, firstFull, lastFullEnd)
	if err != nil {
		return rollupReadPlan{}, err
	}
	for dRows.Next() {
		var h int64
		if scanErr := dRows.Scan(&h); scanErr != nil {
			_ = dRows.Close()
			return rollupReadPlan{}, scanErr
		}
		bypassed[h] = true
	}
	if err := dRows.Err(); err != nil {
		_ = dRows.Close()
		return rollupReadPlan{}, err
	}
	_ = dRows.Close()

	// 2. 快照高水位线校验：先 O(log N) 比较当前最大 id/rowid，仅当存在新写入时用 NOT INDEXED 走 rowid 主键范围查。
	if pCtx != nil && (pCtx.RecordHighWaterID >= 0 || pCtx.PromptHighWaterRowID >= 0) {
		var curMaxRec, curMaxPrompt int64
		if err := conn.QueryRowContext(ctx, `
			SELECT
				(SELECT COALESCE(MAX(id), 0) FROM model_usage_records),
				(SELECT COALESCE(MAX(rowid), 0) FROM model_usage_prompt_events)`).Scan(&curMaxRec, &curMaxPrompt); err != nil {
			return rollupReadPlan{}, err
		}
		if pCtx.RecordHighWaterID >= 0 && curMaxRec > pCtx.RecordHighWaterID {
			hwRows, qErr := conn.QueryContext(ctx, `
				SELECT DISTINCT CASE WHEN timestamp_ms > 0 THEN (timestamp_ms / 3600000) * 3600000 ELSE 0 END
				FROM model_usage_records NOT INDEXED
				WHERE id > ?`, pCtx.RecordHighWaterID)
			if qErr != nil {
				return rollupReadPlan{}, qErr
			}
			for hwRows.Next() {
				var h int64
				if scanErr := hwRows.Scan(&h); scanErr != nil {
					_ = hwRows.Close()
					return rollupReadPlan{}, scanErr
				}
				for _, cand := range []int64{h - rollupHourMS, h, h + rollupHourMS} {
					if cand >= firstFull && cand < lastFullEnd {
						bypassed[cand] = true
					}
				}
			}
			if err := hwRows.Err(); err != nil {
				_ = hwRows.Close()
				return rollupReadPlan{}, err
			}
			_ = hwRows.Close()
		}
		if pCtx.PromptHighWaterRowID >= 0 && curMaxPrompt > pCtx.PromptHighWaterRowID {
			phwRows, qErr := conn.QueryContext(ctx, `
				SELECT DISTINCT CASE WHEN timestamp_ms > 0 THEN (timestamp_ms / 3600000) * 3600000 ELSE 0 END
				FROM model_usage_prompt_events NOT INDEXED
				WHERE rowid > ?`, pCtx.PromptHighWaterRowID)
			if qErr != nil {
				return rollupReadPlan{}, qErr
			}
			for phwRows.Next() {
				var h int64
				if scanErr := phwRows.Scan(&h); scanErr != nil {
					_ = phwRows.Close()
					return rollupReadPlan{}, scanErr
				}
				if h >= firstFull && h < lastFullEnd {
					bypassed[h] = true
				}
			}
			if err := phwRows.Err(); err != nil {
				_ = phwRows.Close()
				return rollupReadPlan{}, err
			}
			_ = phwRows.Close()
		}
	}

	// 3. 逐小时校验分叉摘要、归因摘要、定价版本与跨边界归因标记。
	hRows, err := conn.QueryContext(ctx, `
		SELECT hour_ms, max_record_id, max_prompt_rowid,
			attr_count, attr_digest, fork_digest,
			pricing_rev, pricing_custom_digest,
			has_codex_file, has_left_boundary_attr, has_right_boundary_attr
		FROM model_usage_rollup_hours
		WHERE hour_ms >= ? AND hour_ms < ?`, firstFull, lastFullEnd)
	if err != nil {
		return rollupReadPlan{}, err
	}
	matByHour := make(map[int64]rollupHourMetaRow)
	for hRows.Next() {
		var row rollupHourMetaRow
		var hasCodex, hasLeft, hasRight int
		if scanErr := hRows.Scan(
			&row.hourMS, &row.maxRecordID, &row.maxPromptRowID,
			&row.attrCount, &row.attrDigest, &row.forkDigest,
			&row.pricingRev, &row.pricingCustomDigest,
			&hasCodex, &hasLeft, &hasRight,
		); scanErr != nil {
			_ = hRows.Close()
			return rollupReadPlan{}, scanErr
		}
		row.hasCodexFile = hasCodex != 0
		row.hasLeftBoundaryAttr = hasLeft != 0
		row.hasRightBoundaryAttr = hasRight != 0
		matByHour[row.hourMS] = row
	}
	if err := hRows.Err(); err != nil {
		_ = hRows.Close()
		return rollupReadPlan{}, err
	}
	_ = hRows.Close()

	if pCtx != nil {
		wantForkDigest := computeForkDigest(pCtx.ForkDescriptors)
		wantAttrByHour := computeHourAttrDigests(pCtx.Attributions, firstFull, lastFullEnd)
		for h, mh := range matByHour {
			if pCtx.RecordHighWaterID >= 0 && mh.maxRecordID > pCtx.RecordHighWaterID {
				bypassed[h] = true
				continue
			}
			if pCtx.PromptHighWaterRowID >= 0 && mh.maxPromptRowID > pCtx.PromptHighWaterRowID {
				bypassed[h] = true
				continue
			}
			if mh.forkDigest != wantForkDigest {
				bypassed[h] = true
				continue
			}
			want := wantAttrByHour[h]
			if mh.attrCount != want.count || mh.attrDigest != want.digest {
				bypassed[h] = true
			}
		}
		for h, want := range wantAttrByHour {
			if want.count > 0 {
				if _, exists := matByHour[h]; !exists {
					bypassed[h] = true
				}
			}
		}
	} else {
		curForkDigest := computeForkDigest(curForks)
		curCustomPriceDigest := computeCustomPricingDigest(curPricing.customIndex)
		for h, mh := range matByHour {
			if mh.forkDigest != curForkDigest {
				bypassed[h] = true
				continue
			}
			if mh.attrCount > 0 && (mh.pricingRev != meta.pricingRev || mh.pricingCustomDigest != curCustomPriceDigest) {
				bypassed[h] = true
			}
		}
		// 边界归因保守处理：若窗口边界 5 分钟内存在跨小时配对候选，旁路该边界小时按窗口精确配对。
		if firstFull-q.FromMS < scannerAfterProxyWindowMS {
			if mh, ok := matByHour[firstFull]; ok && mh.hasLeftBoundaryAttr {
				bypassed[firstFull] = true
			}
		}
		lastHour := lastFullEnd - rollupHourMS
		if q.ToMS-lastFullEnd < scannerAfterProxyWindowMS {
			if mh, ok := matByHour[lastHour]; ok && mh.hasRightBoundaryAttr {
				bypassed[lastHour] = true
			}
		}
	}

	uncovered := findUncoveredHourRanges(firstFull, lastFullEnd, covered)
	keptRollup, removedFromCovered := subtractHoursFromRanges(covered, bypassed)

	var live []timeRange
	if q.FromMS < firstFull {
		live = append(live, timeRange{FromMS: q.FromMS, ToMS: firstFull - 1})
	}
	for _, g := range uncovered {
		live = append(live, timeRange{FromMS: g.StartHour, ToMS: g.EndHour - 1})
	}
	for _, rem := range removedFromCovered {
		live = append(live, timeRange{FromMS: rem.StartHour, ToMS: rem.EndHour - 1})
	}
	if lastFullEnd <= q.ToMS {
		live = append(live, timeRange{FromMS: lastFullEnd, ToMS: q.ToMS})
	}
	live = mergeTimeRanges(live)

	return rollupReadPlan{
		rollupReady:  true,
		rollupRanges: keptRollup,
		liveRanges:   live,
		matByHour:    matByHour,
	}, nil
}

// partitionTrendStraddleHours 将 rollupRanges 中跨越趋势桶边界的小时拆出，
// 返回 (straddleHoursMap, straddleLiveRanges, allStraddle)。
func partitionTrendStraddleHours(
	rollupRanges []hourRange,
	originMS, bucketMS int64,
) (straddleSet map[int64]bool, straddleRanges []timeRange, allStraddle bool) {
	if len(rollupRanges) == 0 || originMS <= 0 || bucketMS <= 0 {
		return nil, nil, false
	}
	firstStart := rollupRanges[0].StartHour
	if originMS%rollupHourMS == 0 && bucketMS%rollupHourMS == 0 && firstStart >= originMS {
		return nil, nil, false
	}
	if bucketMS < 6*rollupHourMS {
		// 桶宽小于 6 小时且未对齐（如 15m/5m 桶或未对齐 1h 桶，仅在短窗出现）：全量走实时分桶。
		out := make([]timeRange, 0, len(rollupRanges))
		for _, rr := range rollupRanges {
			out = append(out, timeRange{FromMS: rr.StartHour, ToMS: rr.EndHour - 1})
		}
		return nil, mergeTimeRanges(out), true
	}
	straddleSet = make(map[int64]bool)
	totalHours := int64(0)
	for _, rr := range rollupRanges {
		for h := rr.StartHour; h < rr.EndHour; h += rollupHourMS {
			totalHours++
			if !isHourAlignedToTrendBucket(h, originMS, bucketMS) {
				straddleSet[h] = true
				straddleRanges = append(straddleRanges, timeRange{FromMS: h, ToMS: h + rollupHourMS - 1})
			}
		}
	}
	if len(straddleSet) == 0 {
		return nil, nil, false
	}
	if int64(len(straddleSet)) == totalHours {
		return straddleSet, mergeTimeRanges(straddleRanges), true
	}
	return straddleSet, mergeTimeRanges(straddleRanges), false
}
