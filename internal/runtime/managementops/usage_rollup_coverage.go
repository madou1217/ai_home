package managementops

import (
	"context"
	"database/sql"
	"math"
	"sort"
)

func readCoverageRangesConn(ctx context.Context, conn *sql.Conn, startHour, endHour int64) ([]hourRange, error) {
	rows, err := conn.QueryContext(ctx, `
		SELECT start_hour_ms, end_hour_ms
		FROM model_usage_rollup_coverage
		WHERE end_hour_ms > ? AND start_hour_ms < ?
		ORDER BY start_hour_ms`, startHour, endHour)
	if err != nil {
		if isSQLiteMissingTable(err) {
			return nil, nil
		}
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var out []hourRange
	for rows.Next() {
		var s, e int64
		if scanErr := rows.Scan(&s, &e); scanErr != nil {
			return nil, scanErr
		}
		if s < startHour {
			s = startHour
		}
		if e > endHour {
			e = endHour
		}
		if e <= s {
			continue
		}
		if len(out) > 0 && s <= out[len(out)-1].EndHour {
			if e > out[len(out)-1].EndHour {
				out[len(out)-1].EndHour = e
			}
			continue
		}
		out = append(out, hourRange{StartHour: s, EndHour: e})
	}
	return out, rows.Err()
}

func findUncoveredHourRanges(startHour, endHour int64, covered []hourRange) []hourRange {
	if endHour <= startHour {
		return nil
	}
	var gaps []hourRange
	cursor := startHour
	for _, c := range covered {
		if c.EndHour <= cursor {
			continue
		}
		if c.StartHour > cursor {
			gaps = append(gaps, hourRange{StartHour: cursor, EndHour: c.StartHour})
		}
		if c.EndHour > cursor {
			cursor = c.EndHour
		}
		if cursor >= endHour {
			break
		}
	}
	if cursor < endHour {
		gaps = append(gaps, hourRange{StartHour: cursor, EndHour: endHour})
	}
	return gaps
}

func mergeHourCoverageTx(ctx context.Context, tx *sql.Tx, additions []hourRange) error {
	for _, add := range additions {
		if add.EndHour <= add.StartHour {
			continue
		}
		rows, err := tx.QueryContext(ctx, `
			SELECT start_hour_ms, end_hour_ms
			FROM model_usage_rollup_coverage
			WHERE end_hour_ms >= ? AND start_hour_ms <= ?
			ORDER BY start_hour_ms`, add.StartHour, add.EndHour)
		if err != nil {
			return err
		}
		mergedStart := add.StartHour
		mergedEnd := add.EndHour
		var toDelete []int64
		for rows.Next() {
			var s, e int64
			if scanErr := rows.Scan(&s, &e); scanErr != nil {
				_ = rows.Close()
				return scanErr
			}
			toDelete = append(toDelete, s)
			if s < mergedStart {
				mergedStart = s
			}
			if e > mergedEnd {
				mergedEnd = e
			}
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return err
		}
		_ = rows.Close()

		for _, oldStart := range toDelete {
			if _, err := tx.ExecContext(ctx, `DELETE FROM model_usage_rollup_coverage WHERE start_hour_ms = ?`, oldStart); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO model_usage_rollup_coverage (start_hour_ms, end_hour_ms)
			VALUES (?, ?)
			ON CONFLICT(start_hour_ms) DO UPDATE SET end_hour_ms = MAX(end_hour_ms, excluded.end_hour_ms)`,
			mergedStart, mergedEnd); err != nil {
			return err
		}
	}
	return nil
}

func probeGapDataBoundsConn(ctx context.Context, conn *sql.Conn, startHour, endHour int64) (minTS, maxTS int64, hasData, hasScanner bool, snapRev int64, err error) {
	snap, err := beginProjectionReadSnapshot(ctx, conn)
	if err != nil {
		return 0, 0, false, false, 0, err
	}
	defer snap.close()

	capReport, err := inspectRollupCapabilitiesQueryer(ctx, conn)
	if err != nil {
		return 0, 0, false, false, 0, err
	}
	if !capReport.allReady {
		return 0, 0, false, false, 0, errRollupCapabilitiesNotReady
	}
	snapRev = capReport.meta.changeRev

	endInclusive := endHour - 1
	var rMin, rMax, pMin, pMax sql.NullInt64
	if err = conn.QueryRowContext(ctx, `
		SELECT
			(SELECT timestamp_ms FROM model_usage_records WHERE timestamp_ms BETWEEN ? AND ? ORDER BY timestamp_ms ASC LIMIT 1),
			(SELECT timestamp_ms FROM model_usage_records WHERE timestamp_ms BETWEEN ? AND ? ORDER BY timestamp_ms DESC LIMIT 1),
			(SELECT timestamp_ms FROM model_usage_prompt_events WHERE timestamp_ms BETWEEN ? AND ? ORDER BY timestamp_ms ASC LIMIT 1),
			(SELECT timestamp_ms FROM model_usage_prompt_events WHERE timestamp_ms BETWEEN ? AND ? ORDER BY timestamp_ms DESC LIMIT 1)`,
		startHour, endInclusive, startHour, endInclusive,
		startHour, endInclusive, startHour, endInclusive,
	).Scan(&rMin, &rMax, &pMin, &pMax); err != nil {
		return 0, 0, false, false, 0, err
	}
	if rMin.Valid {
		hasData = true
		minTS = rMin.Int64
		maxTS = rMax.Int64
	}
	if pMin.Valid {
		if !hasData || pMin.Int64 < minTS {
			minTS = pMin.Int64
		}
		if !hasData || pMax.Int64 > maxTS {
			maxTS = pMax.Int64
		}
		hasData = true
	}
	if !hasData {
		return 0, 0, false, false, snapRev, nil
	}

	padFrom := maxInt64(0, startHour-scannerAfterProxyWindowMS)
	padTo := endInclusive + scannerAfterProxyWindowMS
	if padTo < endInclusive {
		padTo = math.MaxInt64
	}
	var scanFlag int
	scanErr := conn.QueryRowContext(ctx, `
		SELECT 1 FROM model_usage_records INDEXED BY idx_model_usage_timestamp
		WHERE timestamp_ms BETWEEN ? AND ?
			AND source_kind IN ('session_jsonl', 'session_json')
			AND model != ''
		LIMIT 1`, padFrom, padTo).Scan(&scanFlag)
	if scanErr == nil {
		hasScanner = true
	} else if scanErr != sql.ErrNoRows {
		return 0, 0, false, false, 0, scanErr
	}
	return minTS, maxTS, true, hasScanner, snapRev, nil
}

func (s *UsageStore) commitEmptyCoverage(ctx context.Context, gap hourRange, snapRev int64) error {
	if gap.EndHour <= gap.StartHour {
		return nil
	}
	coord := getRollupCoordinator(s)
	err := s.runImmediateTx(ctx, func(tx *sql.Tx) error {
		curCap, capErr := inspectRollupCapabilitiesQueryer(ctx, tx)
		if capErr != nil {
			return capErr
		}
		if !curCap.allReady {
			return errRollupCapabilitiesNotReady
		}
		rows, qErr := tx.QueryContext(ctx, `
			SELECT hour_ms FROM model_usage_rollup_dirty_hours
			WHERE hour_ms >= ? AND hour_ms < ? AND dirty_rev > ?
			ORDER BY hour_ms`, gap.StartHour, gap.EndHour, snapRev)
		if qErr != nil {
			return qErr
		}
		raced := make(map[int64]bool)
		for rows.Next() {
			var h int64
			if scanErr := rows.Scan(&h); scanErr != nil {
				_ = rows.Close()
				return scanErr
			}
			raced[h] = true
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return err
		}
		_ = rows.Close()

		if len(raced) == 0 {
			if _, delErr := tx.ExecContext(ctx, `
				DELETE FROM model_usage_rollup_dirty_hours
				WHERE hour_ms >= ? AND hour_ms < ? AND dirty_rev <= ?`,
				gap.StartHour, gap.EndHour, snapRev); delErr != nil {
				return delErr
			}
			return mergeHourCoverageTx(ctx, tx, []hourRange{gap})
		}

		var safe []hourRange
		curStart := gap.StartHour
		racedList := make([]int64, 0, len(raced))
		for h := range raced {
			racedList = append(racedList, h)
		}
		sort.Slice(racedList, func(i, j int) bool { return racedList[i] < racedList[j] })
		for _, rh := range racedList {
			if rh > curStart {
				safe = append(safe, hourRange{StartHour: curStart, EndHour: rh})
			}
			curStart = rh + rollupHourMS
		}
		if curStart < gap.EndHour {
			safe = append(safe, hourRange{StartHour: curStart, EndHour: gap.EndHour})
		}
		for _, sr := range safe {
			if _, delErr := tx.ExecContext(ctx, `
				DELETE FROM model_usage_rollup_dirty_hours
				WHERE hour_ms >= ? AND hour_ms < ? AND dirty_rev <= ?`,
				sr.StartHour, sr.EndHour, snapRev); delErr != nil {
				return delErr
			}
		}
		return mergeHourCoverageTx(ctx, tx, safe)
	})
	if err != nil {
		if ro, _ := isSQLiteReadOnlyOrBusy(err); ro {
			coord.mu.Lock()
			coord.readOnly = true
			coord.mu.Unlock()
		}
		return err
	}
	return nil
}
