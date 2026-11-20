package managementops

import (
	"context"
	"database/sql"
	"math"
)

type materializeCompMeta struct {
	minTS         int64
	maxTS         int64
	touchesTarget bool
	edges         []matchCandidate
}

func groupMaterializeComponents(
	candidates []matchCandidate,
	scannerByID map[int64]observationRow,
	proxyByID map[int64]observationRow,
	wantHour func(int64) bool,
) map[int]*materializeCompMeta {
	scannerNode := make(map[int64]int, len(scannerByID))
	proxyNode := make(map[int64]int, len(proxyByID))
	var parent, rank []int
	makeNode := func() int {
		id := len(parent)
		parent = append(parent, id)
		rank = append(rank, 0)
		return id
	}
	find := func(x int) int {
		root := x
		for parent[root] != root {
			root = parent[root]
		}
		for parent[x] != x {
			next := parent[x]
			parent[x] = root
			x = next
		}
		return root
	}
	union := func(a, b int) {
		ra, rb := find(a), find(b)
		if ra == rb {
			return
		}
		if rank[ra] < rank[rb] {
			ra, rb = rb, ra
		}
		parent[rb] = ra
		if rank[ra] == rank[rb] {
			rank[ra]++
		}
	}

	for _, c := range candidates {
		sn, ok := scannerNode[c.ScannerID]
		if !ok {
			sn = makeNode()
			scannerNode[c.ScannerID] = sn
		}
		pn, ok := proxyNode[c.ProxyID]
		if !ok {
			pn = makeNode()
			proxyNode[c.ProxyID] = pn
		}
		union(sn, pn)
	}

	comps := make(map[int]*materializeCompMeta)
	for _, c := range candidates {
		root := find(scannerNode[c.ScannerID])
		cm := comps[root]
		if cm == nil {
			cm = &materializeCompMeta{minTS: math.MaxInt64, maxTS: math.MinInt64}
			comps[root] = cm
		}
		cm.edges = append(cm.edges, c)
		sc := scannerByID[c.ScannerID]
		px := proxyByID[c.ProxyID]
		if sc.TimestampMS < cm.minTS {
			cm.minTS = sc.TimestampMS
		}
		if sc.TimestampMS > cm.maxTS {
			cm.maxTS = sc.TimestampMS
		}
		if px.TimestampMS < cm.minTS {
			cm.minTS = px.TimestampMS
		}
		if px.TimestampMS > cm.maxTS {
			cm.maxTS = px.TimestampMS
		}
		if wantHour(hourFloorMS(sc.TimestampMS)) || wantHour(hourFloorMS(px.TimestampMS)) {
			cm.touchesTarget = true
		}
	}
	return comps
}

// closeMaterializeAttributionsConn 对 [startHour, endHour) 内的目标小时执行完整候选图边界闭合：
//   - 在初始 [verifyFrom, verifyTo] 观测集上按连通分量切分，检测所有触及目标小时的分量时间极值；
//   - 若分量距 verifyFrom/verifyTo 不足 5 分钟（外部仍可能存在连通候选边），按步长增量拉取外部观测行
//     并复检，直至全部目标分量严格证明与外部断开（或触达 rollupMaterializeMaxExpandMS 上限）；
//   - 对触达上限仍未闭合的分量，将其触及的目标小时记入 unclosedHours（绝不截断落盘或标记 clean coverage），
//     仅对已严格闭合的分量直接调用基线 matchObservationComponent 求解并按 sortMatchCandidates 排序。
func (s *UsageStore) closeMaterializeAttributionsConn(
	ctx context.Context,
	conn *sql.Conn,
	startHour, endHour int64,
	wantHour func(int64) bool,
	verifyFrom, verifyTo int64,
	proxies, scanners []observationRow,
	forksByHash map[string]forkDescriptor,
	pricingSnap pricingResolverSnapshot,
) (
	attrs []usageAttribution,
	crossLeft map[int64]bool,
	crossRight map[int64]bool,
	unclosedHours map[int64]bool,
	err error,
) {
	if len(proxies) == 0 || len(scanners) == 0 {
		return nil, nil, nil, nil, nil
	}
	endInclusive := endHour - 1
	minExpandFrom := maxInt64(0, startHour-rollupMaterializeMaxExpandMS)
	maxExpandTo := endInclusive + rollupMaterializeMaxExpandMS
	if maxExpandTo < endInclusive {
		maxExpandTo = math.MaxInt64
	}

	rebuildGraph := true
	var (
		candidates     []matchCandidate
		scannerByID    map[int64]observationRow
		proxyByID      map[int64]observationRow
		candCrossLeft  map[int64]bool
		candCrossRight map[int64]bool
		comps          map[int]*materializeCompMeta
	)

	for {
		if rebuildGraph {
			candidates, scannerByID, proxyByID, candCrossLeft, candCrossRight = buildObservationCandidates(
				proxies, scanners, forksByHash,
			)
			if len(candidates) == 0 {
				return nil, nil, nil, nil, nil
			}
			comps = groupMaterializeComponents(candidates, scannerByID, proxyByID, wantHour)
			rebuildGraph = false
		}

		leftSafeFloor := verifyFrom + scannerAfterProxyWindowMS
		if leftSafeFloor < verifyFrom {
			leftSafeFloor = math.MaxInt64
		}
		var rightSafeCeil int64
		if verifyTo >= scannerAfterProxyWindowMS {
			rightSafeCeil = verifyTo - scannerAfterProxyWindowMS
		}

		needLeft := false
		needRight := false
		minOpenTS := int64(math.MaxInt64)
		maxOpenTS := int64(math.MinInt64)

		for _, cm := range comps {
			if !cm.touchesTarget {
				continue
			}
			if verifyFrom > 0 && cm.minTS < leftSafeFloor {
				needLeft = true
				if cm.minTS < minOpenTS {
					minOpenTS = cm.minTS
				}
			}
			if verifyTo < math.MaxInt64 && cm.maxTS > rightSafeCeil {
				needRight = true
				if cm.maxTS > maxOpenTS {
					maxOpenTS = cm.maxTS
				}
			}
		}

		didExpand := false
		if needLeft && verifyFrom > minExpandFrom {
			targetFrom := maxInt64(0, verifyFrom-rollupMaterializeExpandStepMS)
			if needFloor := maxInt64(0, minOpenTS-scannerAfterProxyWindowMS); needFloor < targetFrom {
				targetFrom = needFloor
			}
			if targetFrom < minExpandFrom {
				targetFrom = minExpandFrom
			}
			if targetFrom < verifyFrom {
				extProxies, extScanners, loadErr := loadAttributionObservationsConn(
					ctx, conn, targetFrom, verifyFrom-1, math.MaxInt64, false,
				)
				if loadErr != nil {
					return nil, nil, nil, nil, loadErr
				}
				if len(extProxies) > 0 || len(extScanners) > 0 {
					proxies = append(proxies, extProxies...)
					scanners = append(scanners, extScanners...)
					rebuildGraph = true
				}
				verifyFrom = targetFrom
				didExpand = true
			}
		}
		if needRight && verifyTo < maxExpandTo {
			targetTo := verifyTo + rollupMaterializeExpandStepMS
			if targetTo < verifyTo {
				targetTo = math.MaxInt64
			}
			if maxOpenTS <= math.MaxInt64-scannerAfterProxyWindowMS {
				if needCeil := maxOpenTS + scannerAfterProxyWindowMS; needCeil > targetTo {
					targetTo = needCeil
				}
			} else {
				targetTo = math.MaxInt64
			}
			if targetTo > maxExpandTo {
				targetTo = maxExpandTo
			}
			if targetTo > verifyTo {
				extProxies, extScanners, loadErr := loadAttributionObservationsConn(
					ctx, conn, verifyTo+1, targetTo, math.MaxInt64, false,
				)
				if loadErr != nil {
					return nil, nil, nil, nil, loadErr
				}
				if len(extProxies) > 0 || len(extScanners) > 0 {
					proxies = append(proxies, extProxies...)
					scanners = append(scanners, extScanners...)
					rebuildGraph = true
				}
				verifyTo = targetTo
				didExpand = true
			}
		}

		if didExpand {
			continue
		}

		var matches []matchCandidate
		for _, cm := range comps {
			if !cm.touchesTarget {
				continue
			}
			leftClosed := verifyFrom == 0 || cm.minTS >= leftSafeFloor
			rightClosed := verifyTo == math.MaxInt64 || cm.maxTS <= rightSafeCeil
			if !leftClosed || !rightClosed {
				if unclosedHours == nil {
					unclosedHours = make(map[int64]bool)
				}
				for _, c := range cm.edges {
					sh := hourFloorMS(scannerByID[c.ScannerID].TimestampMS)
					ph := hourFloorMS(proxyByID[c.ProxyID].TimestampMS)
					if wantHour(sh) {
						unclosedHours[sh] = true
					}
					if wantHour(ph) {
						unclosedHours[ph] = true
					}
				}
				continue
			}
			matches = append(matches, matchObservationComponent(cm.edges)...)
		}

		if len(matches) > 0 {
			if len(matches) > 1 {
				sortMatchCandidates(matches)
			}
			attrs = materializeAttributionMatches(matches, scannerByID, proxyByID, pricingSnap, s.attribution)
		}
		return attrs, candCrossLeft, candCrossRight, unclosedHours, nil
	}
}
