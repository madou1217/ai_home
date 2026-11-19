package managementops

import (
	"context"
	"database/sql"
	"math"
	"sort"
)

type rollupSyncInspection struct {
	gaps           []hourRange
	dirtyHours     []int64
	connectedRight map[int64]bool
	pricingRev     int64
	forkDigest     int64
	customPrice    int64
}

func expandDirtyHoursAcrossBoundariesConn(
	ctx context.Context,
	conn *sql.Conn,
	dirtySet map[int64]struct{},
	inGaps func(int64) bool,
) (map[int64]bool, error) {
	if len(dirtySet) == 0 {
		return nil, nil
	}
	const maxExpand = 64
	minH := int64(math.MaxInt64)
	maxH := int64(0)
	queue := make([]int64, 0, len(dirtySet))
	for h := range dirtySet {
		queue = append(queue, h)
		if h < minH {
			minH = h
		}
		if h > maxH {
			maxH = h
		}
	}
	spanPad := int64(maxExpand) * rollupHourMS
	qStart := maxInt64(0, minH-spanPad)
	qEnd := maxH + spanPad
	if qEnd < maxH {
		qEnd = math.MaxInt64
	}

	rows, err := conn.QueryContext(ctx, `
		SELECT hour_ms, has_left_boundary_attr, has_right_boundary_attr
		FROM model_usage_rollup_hours
		WHERE hour_ms >= ? AND hour_ms <= ?`, qStart, qEnd)
	if err != nil {
		return nil, err
	}
	matExists := make(map[int64]bool)
	hasLeft := make(map[int64]bool)
	hasRight := make(map[int64]bool)
	for rows.Next() {
		var h int64
		var l, r int
		if scanErr := rows.Scan(&h, &l, &r); scanErr != nil {
			_ = rows.Close()
			return nil, scanErr
		}
		matExists[h] = true
		if l != 0 {
			hasLeft[h] = true
		}
		if r != 0 {
			hasRight[h] = true
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	_ = rows.Close()

	added := 0
	for len(queue) > 0 && added < maxExpand {
		h := queue[0]
		queue = queue[1:]
		if h >= rollupHourMS {
			lh := h - rollupHourMS
			if matExists[lh] && !inGaps(lh) && (hasLeft[h] || hasRight[lh]) {
				if _, exists := dirtySet[lh]; !exists {
					dirtySet[lh] = struct{}{}
					queue = append(queue, lh)
					added++
				}
			}
		}
		if added < maxExpand && h <= math.MaxInt64-rollupHourMS {
			rh := h + rollupHourMS
			if matExists[rh] && !inGaps(rh) && (hasRight[h] || hasLeft[rh]) {
				if _, exists := dirtySet[rh]; !exists {
					dirtySet[rh] = struct{}{}
					queue = append(queue, rh)
					added++
				}
			}
		}
	}

	connectedRight := make(map[int64]bool)
	for h := range dirtySet {
		if h <= math.MaxInt64-rollupHourMS && (hasRight[h] || hasLeft[h+rollupHourMS]) {
			connectedRight[h] = true
		}
	}
	return connectedRight, nil
}

func (s *UsageStore) inspectRollupNeedsConn(ctx context.Context, conn *sql.Conn, startHour, endHour int64) (rollupSyncInspection, bool, error) {
	snap, err := beginProjectionReadSnapshot(ctx, conn)
	if err != nil {
		return rollupSyncInspection{}, false, err
	}
	defer snap.close()

	capReport, err := inspectRollupCapabilitiesQueryer(ctx, conn)
	if err != nil {
		return rollupSyncInspection{}, false, err
	}
	if !capReport.allReady {
		return rollupSyncInspection{}, false, nil
	}
	meta := capReport.meta

	covered, err := readCoverageRangesConn(ctx, conn, startHour, endHour)
	if err != nil {
		return rollupSyncInspection{}, false, err
	}
	gaps := findUncoveredHourRanges(startHour, endHour, covered)

	_, forkDigest, err := s.getCachedForkDescriptorsConn(ctx, conn, meta.forkRev)
	if err != nil {
		return rollupSyncInspection{}, false, err
	}

	customIndex, err := readCustomPricingIndexStrictConn(ctx, conn)
	if err != nil {
		return rollupSyncInspection{}, false, err
	}
	customPriceDigest := computeCustomPricingDigest(customIndex)

	dirtySet := make(map[int64]struct{})
	inGaps := func(h int64) bool {
		for _, g := range gaps {
			if h >= g.StartHour && h < g.EndHour {
				return true
			}
		}
		return false
	}

	addRows := func(q string, args ...any) error {
		rows, qErr := conn.QueryContext(ctx, q, args...)
		if qErr != nil {
			return qErr
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var h int64
			if scanErr := rows.Scan(&h); scanErr != nil {
				return scanErr
			}
			if !inGaps(h) {
				dirtySet[h] = struct{}{}
			}
		}
		return rows.Err()
	}

	if err := addRows(`
		SELECT hour_ms FROM model_usage_rollup_dirty_hours
		WHERE hour_ms >= ? AND hour_ms < ?`, startHour, endHour); err != nil {
		return rollupSyncInspection{}, false, err
	}
	if len(covered) > 0 {
		// 分叉变化会改变扫描行归因资格并经由连通分量波及相邻或相连代理小时，
		// 因此保守校验全部已物化小时的 fork_digest，而非仅限 has_codex_file = 1。
		if err := addRows(`
			SELECT hour_ms FROM model_usage_rollup_hours
			WHERE hour_ms >= ? AND hour_ms < ?
				AND fork_digest != ?`, startHour, endHour, forkDigest); err != nil {
			return rollupSyncInspection{}, false, err
		}
		if err := addRows(`
			SELECT hour_ms FROM model_usage_rollup_hours
			WHERE hour_ms >= ? AND hour_ms < ?
				AND attr_count > 0
				AND (pricing_rev != ? OR pricing_custom_digest != ?)`,
			startHour, endHour, meta.pricingRev, customPriceDigest); err != nil {
			return rollupSyncInspection{}, false, err
		}
	}

	var connectedRight map[int64]bool
	if len(dirtySet) > 0 && len(covered) > 0 {
		connectedRight, err = expandDirtyHoursAcrossBoundariesConn(ctx, conn, dirtySet, inGaps)
		if err != nil {
			return rollupSyncInspection{}, false, err
		}
	}

	dirtyHours := make([]int64, 0, len(dirtySet))
	for h := range dirtySet {
		dirtyHours = append(dirtyHours, h)
	}
	sort.Slice(dirtyHours, func(i, j int) bool { return dirtyHours[i] < dirtyHours[j] })

	return rollupSyncInspection{
		gaps:           gaps,
		dirtyHours:     dirtyHours,
		connectedRight: connectedRight,
		pricingRev:     meta.pricingRev,
		forkDigest:     forkDigest,
		customPrice:    customPriceDigest,
	}, true, nil
}
