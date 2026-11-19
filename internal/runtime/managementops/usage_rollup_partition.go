package managementops

import (
	"context"
	"database/sql"
	"math"
	"sort"
)

// maxPartitionBoundaryExpandHours 限制局部跨小时连通分量边界扩张的最大小时数；
// 超过上限时退回单次全局 [attrFrom, attrTo] 归因，避免长链反复扩张扫描。
const maxPartitionBoundaryExpandHours = 6

type partitionedAttributionResult struct {
	plan               rollupReadPlan
	liveAttrs          []usageAttribution
	usedGlobalFallback bool
}

func isHourInRanges(h int64, ranges []hourRange) bool {
	if len(ranges) == 0 {
		return false
	}
	lo, hi := 0, len(ranges)-1
	for lo <= hi {
		mid := lo + (hi-lo)/2
		r := ranges[mid]
		if h < r.StartHour {
			hi = mid - 1
		} else if h >= r.EndHour {
			lo = mid + 1
		} else {
			return true
		}
	}
	return false
}

func queryAttributionBounds(q UsageQuery) (attrFrom, attrTo int64) {
	attrFrom = maxInt64(0, q.FromMS-scannerAfterProxyWindowMS)
	attrTo = q.ToMS + scannerBeforeProxyWindowMS
	if attrTo < q.ToMS {
		attrTo = math.MaxInt64
	}
	return attrFrom, attrTo
}

func areAttributionsDisjoint(attrs []usageAttribution) bool {
	if len(attrs) <= 1 {
		return true
	}
	seenScanner := make(map[int64]struct{}, len(attrs))
	seenProxy := make(map[int64]struct{}, len(attrs))
	for _, a := range attrs {
		if _, dup := seenScanner[a.ScannerID]; dup {
			return false
		}
		if _, dup := seenProxy[a.ProxyID]; dup {
			return false
		}
		seenScanner[a.ScannerID] = struct{}{}
		seenProxy[a.ProxyID] = struct{}{}
	}
	return true
}

func sortUsageAttributions(attrs []usageAttribution) {
	sort.Slice(attrs, func(i, j int) bool {
		if attrs[i].ScannerTimestampMS != attrs[j].ScannerTimestampMS {
			return attrs[i].ScannerTimestampMS < attrs[j].ScannerTimestampMS
		}
		if attrs[i].ScannerID != attrs[j].ScannerID {
			return attrs[i].ScannerID < attrs[j].ScannerID
		}
		return attrs[i].ProxyID < attrs[j].ProxyID
	})
}

// resolvePartitionedAttributionsConn 在单一读快照连接下对 plan=(rollupRanges, liveRanges) 执行
// 跨边界候选图连通分量闭包含并：
//   - 若无 liveRanges，零额外扫描直接返回；
//   - 若存在 liveRanges，先按 matByHour 边界标记预扩张，再实测每个 liveRange ±5m 切口候选边，
//     将所有跨切口连通的相邻 rollup 小时吸收进 liveRanges 合并统一匹配，仅保留严格无跨边切口的内部汇总小时；
//   - 若扩展超出局部上限或出现异常冲突，保守退回单次全局 [attrFrom, attrTo] 规范归因（与基线完全一致）。
func (s *UsageStore) resolvePartitionedAttributionsConn(
	ctx context.Context,
	conn *sql.Conn,
	q UsageQuery,
	plan rollupReadPlan,
	recordHW int64,
	forksByHash map[string]forkDescriptor,
	pricingSnap pricingResolverSnapshot,
) (partitionedAttributionResult, error) {
	attrFrom, attrTo := queryAttributionBounds(q)

	runGlobalFallback := func() (partitionedAttributionResult, error) {
		attrs, err := computeAttributionsRangeConn(
			ctx, conn, attrFrom, attrTo, recordHW, forksByHash, pricingSnap, s.attribution,
		)
		if err != nil {
			return partitionedAttributionResult{}, err
		}
		return partitionedAttributionResult{
			plan:               plan,
			liveAttrs:          attrs,
			usedGlobalFallback: true,
		}, nil
	}

	if !plan.rollupReady || len(plan.rollupRanges) == 0 {
		return runGlobalFallback()
	}
	if len(plan.liveRanges) == 0 {
		return partitionedAttributionResult{
			plan:               plan,
			liveAttrs:          nil,
			usedGlobalFallback: false,
		}, nil
	}

	rollupRanges := append([]hourRange(nil), plan.rollupRanges...)
	liveRanges := append([]timeRange(nil), plan.liveRanges...)
	absorbedHours := 0

	type verifiedLiveKey struct {
		ownFrom        int64
		ownTo          int64
		hasLeftRollup  bool
		hasRightRollup bool
	}
	verifiedCache := make(map[verifiedLiveKey][]usageAttribution)

	for {
		// Phase A: 基于 matByHour 跨小时边界标记 O(1) 预吸收，避免已知跨边界小时二次扫描。
		for {
			toAbsorb := make(map[int64]bool)
			for _, lr := range liveRanges {
				if lr.FromMS >= rollupHourMS && lr.FromMS%rollupHourMS == 0 {
					leftH := lr.FromMS - rollupHourMS
					if isHourInRanges(leftH, rollupRanges) {
						if mh, ok := plan.matByHour[leftH]; ok && mh.hasRightBoundaryAttr {
							toAbsorb[leftH] = true
						}
					}
				}
				if lr.ToMS < math.MaxInt64 && (lr.ToMS+1)%rollupHourMS == 0 {
					rightH := lr.ToMS + 1
					if isHourInRanges(rightH, rollupRanges) {
						if mh, ok := plan.matByHour[rightH]; ok && mh.hasLeftBoundaryAttr {
							toAbsorb[rightH] = true
						}
					}
				}
			}
			if len(toAbsorb) == 0 {
				break
			}
			var removed []hourRange
			rollupRanges, removed = subtractHoursFromRanges(rollupRanges, toAbsorb)
			if len(removed) == 0 {
				break
			}
			for _, rem := range removed {
				liveRanges = append(liveRanges, timeRange{FromMS: rem.StartHour, ToMS: rem.EndHour - 1})
			}
			liveRanges = mergeTimeRanges(liveRanges)
			absorbedHours += len(removed)
			if len(rollupRanges) == 0 || absorbedHours > maxPartitionBoundaryExpandHours {
				return runGlobalFallback()
			}
		}

		// Phase B: 对每个实时分区实测 [winFrom, winTo] 候选图，验证切口零跨边并仅在自有域内求解。
		expanded := make(map[int64]bool)
		var roundLiveAttrs []usageAttribution
		needGlobal := false

		for _, lr := range liveRanges {
			hasLeftRollup := lr.FromMS >= rollupHourMS && lr.FromMS%rollupHourMS == 0 &&
				isHourInRanges(lr.FromMS-rollupHourMS, rollupRanges)
			hasRightRollup := lr.ToMS < math.MaxInt64 && (lr.ToMS+1)%rollupHourMS == 0 &&
				isHourInRanges(lr.ToMS+1, rollupRanges)

			if (!hasLeftRollup && lr.FromMS != q.FromMS) || (!hasRightRollup && lr.ToMS != q.ToMS) {
				needGlobal = true
				break
			}

			ownFrom := lr.FromMS
			if !hasLeftRollup {
				ownFrom = attrFrom
			}
			ownTo := lr.ToMS
			if !hasRightRollup {
				ownTo = attrTo
			}

			cacheKey := verifiedLiveKey{
				ownFrom:        ownFrom,
				ownTo:          ownTo,
				hasLeftRollup:  hasLeftRollup,
				hasRightRollup: hasRightRollup,
			}
			if cached, ok := verifiedCache[cacheKey]; ok {
				roundLiveAttrs = append(roundLiveAttrs, cached...)
				continue
			}

			winFrom := ownFrom
			if hasLeftRollup {
				winFrom = maxInt64(attrFrom, maxInt64(0, ownFrom-scannerAfterProxyWindowMS))
			}
			winTo := ownTo
			if hasRightRollup {
				if ownTo > math.MaxInt64-scannerAfterProxyWindowMS {
					winTo = attrTo
				} else {
					winTo = minInt64Val(attrTo, ownTo+scannerAfterProxyWindowMS)
				}
			}

			proxies, scanners, loadErr := loadAttributionObservationsConn(ctx, conn, winFrom, winTo, recordHW, true)
			if loadErr != nil {
				return partitionedAttributionResult{}, loadErr
			}
			if len(proxies) == 0 || len(scanners) == 0 {
				verifiedCache[cacheKey] = nil
				continue
			}

			candidates, scannerByID, proxyByID, _, _ := buildObservationCandidates(proxies, scanners, forksByHash)
			if len(candidates) == 0 {
				verifiedCache[cacheKey] = nil
				continue
			}

			var ownedCandidates []matchCandidate
			localCross := false
			for _, c := range candidates {
				sc := scannerByID[c.ScannerID]
				px := proxyByID[c.ProxyID]
				sIn := sc.TimestampMS >= ownFrom && sc.TimestampMS <= ownTo
				pIn := px.TimestampMS >= ownFrom && px.TimestampMS <= ownTo
				if sIn && pIn {
					ownedCandidates = append(ownedCandidates, c)
					continue
				}
				if sIn != pIn {
					outTS := px.TimestampMS
					if !sIn {
						outTS = sc.TimestampMS
					}
					outH := hourFloorMS(outTS)
					if !isHourInRanges(outH, rollupRanges) {
						needGlobal = true
						break
					}
					expanded[outH] = true
					localCross = true
				}
			}
			if needGlobal {
				break
			}
			if localCross {
				continue
			}

			var lrAttrs []usageAttribution
			if len(ownedCandidates) > 0 {
				matches := matchObservationCandidates(ownedCandidates)
				lrAttrs = materializeAttributionMatches(matches, scannerByID, proxyByID, pricingSnap, s.attribution)
			}
			verifiedCache[cacheKey] = lrAttrs
			roundLiveAttrs = append(roundLiveAttrs, lrAttrs...)
		}

		if needGlobal {
			return runGlobalFallback()
		}
		if len(expanded) > 0 {
			var removed []hourRange
			rollupRanges, removed = subtractHoursFromRanges(rollupRanges, expanded)
			if len(removed) == 0 {
				return runGlobalFallback()
			}
			for _, rem := range removed {
				liveRanges = append(liveRanges, timeRange{FromMS: rem.StartHour, ToMS: rem.EndHour - 1})
			}
			liveRanges = mergeTimeRanges(liveRanges)
			absorbedHours += len(removed)
			if len(rollupRanges) == 0 || absorbedHours > maxPartitionBoundaryExpandHours {
				return runGlobalFallback()
			}
			continue
		}

		if !areAttributionsDisjoint(roundLiveAttrs) {
			return runGlobalFallback()
		}

		outPlan := plan
		outPlan.rollupRanges = rollupRanges
		outPlan.liveRanges = liveRanges
		return partitionedAttributionResult{
			plan:               outPlan,
			liveAttrs:          roundLiveAttrs,
			usedGlobalFallback: false,
		}, nil
	}
}

// loadValidatedPersistedAttributionsForRangesConn 读取 queryRanges 对应的持久化归因，
// 并严格校验：所有端点均落在 allowedRollupRanges 与 [attrFrom, attrTo] 之内，且无 ProxyID/高水位冲突。
// 任意校验不满足时返回 ok=false，由调用方退回单次全局规范归因，绝不静默丢边。
func loadValidatedPersistedAttributionsForRangesConn(
	ctx context.Context,
	conn *sql.Conn,
	allowedRollupRanges []hourRange,
	queryRanges []hourRange,
	attrFrom, attrTo, recordHW int64,
) ([]usageAttribution, bool, error) {
	if len(queryRanges) == 0 {
		return nil, true, nil
	}
	byScanner := make(map[int64]usageAttribution)
	byProxy := make(map[int64]int64)
	for _, rr := range queryRanges {
		rows, err := conn.QueryContext(ctx, `
			SELECT scanner_id, proxy_id, scanner_timestamp_ms, proxy_timestamp_ms,
				model, account_provider, account_ref, cost_usd
			FROM model_usage_rollup_attributions
			WHERE (scanner_hour_ms >= ? AND scanner_hour_ms < ?)
				OR (proxy_hour_ms >= ? AND proxy_hour_ms < ?)`,
			rr.StartHour, rr.EndHour, rr.StartHour, rr.EndHour)
		if err != nil {
			return nil, false, err
		}
		for rows.Next() {
			var a usageAttribution
			if scanErr := rows.Scan(
				&a.ScannerID, &a.ProxyID, &a.ScannerTimestampMS, &a.ProxyTimestampMS,
				&a.Model, &a.AccountProvider, &a.AccountRef, &a.CostUSD,
			); scanErr != nil {
				_ = rows.Close()
				return nil, false, scanErr
			}
			if recordHW > 0 && (a.ScannerID > recordHW || a.ProxyID > recordHW) {
				_ = rows.Close()
				return nil, false, nil
			}
			if a.ScannerTimestampMS < attrFrom || a.ScannerTimestampMS > attrTo ||
				a.ProxyTimestampMS < attrFrom || a.ProxyTimestampMS > attrTo {
				_ = rows.Close()
				return nil, false, nil
			}
			sh := hourFloorMS(a.ScannerTimestampMS)
			ph := hourFloorMS(a.ProxyTimestampMS)
			if !isHourInRanges(sh, allowedRollupRanges) || !isHourInRanges(ph, allowedRollupRanges) {
				_ = rows.Close()
				return nil, false, nil
			}
			if existing, dupS := byScanner[a.ScannerID]; dupS {
				if existing.ProxyID != a.ProxyID {
					_ = rows.Close()
					return nil, false, nil
				}
				continue
			}
			if prevScanner, dupP := byProxy[a.ProxyID]; dupP && prevScanner != a.ScannerID {
				_ = rows.Close()
				return nil, false, nil
			}
			byScanner[a.ScannerID] = a
			byProxy[a.ProxyID] = a.ScannerID
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, false, err
		}
		_ = rows.Close()
	}
	out := make([]usageAttribution, 0, len(byScanner))
	for _, a := range byScanner {
		out = append(out, a)
	}
	return out, true, nil
}

// mergeDisjointAttributions 合并已验证的持久化归因与实时归因，严格要求 ScannerID 与 ProxyID 均无交集。
// 若发现任何交集返回 ok=false，由调用方退回单次全局规范归因，绝不覆盖或静默丢边。
func mergeDisjointAttributions(persisted, live []usageAttribution) ([]usageAttribution, bool) {
	total := len(persisted) + len(live)
	if total == 0 {
		return nil, true
	}
	seenScanner := make(map[int64]struct{}, total)
	seenProxy := make(map[int64]struct{}, total)
	out := make([]usageAttribution, 0, total)
	appendChecked := func(list []usageAttribution) bool {
		for _, a := range list {
			if _, dupS := seenScanner[a.ScannerID]; dupS {
				return false
			}
			if _, dupP := seenProxy[a.ProxyID]; dupP {
				return false
			}
			seenScanner[a.ScannerID] = struct{}{}
			seenProxy[a.ProxyID] = struct{}{}
			out = append(out, a)
		}
		return true
	}
	if !appendChecked(persisted) || !appendChecked(live) {
		return nil, false
	}
	sortUsageAttributions(out)
	return out, true
}

func timeRangesToHourRanges(ranges []timeRange) []hourRange {
	if len(ranges) == 0 {
		return nil
	}
	out := make([]hourRange, 0, len(ranges))
	for _, r := range ranges {
		if r.ToMS < r.FromMS {
			continue
		}
		endH := hourFloorMS(r.ToMS)
		if endH > math.MaxInt64-rollupHourMS {
			endH = math.MaxInt64
		} else {
			endH += rollupHourMS
		}
		out = append(out, hourRange{
			StartHour: hourFloorMS(r.FromMS),
			EndHour:   endH,
		})
	}
	return out
}
