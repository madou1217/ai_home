package managementops

import (
	"context"
	"database/sql"
	"math"
)

func subtractHoursFromCoverageTx(ctx context.Context, tx *sql.Tx, hours map[int64]bool) error {
	if len(hours) == 0 {
		return nil
	}
	minH := int64(math.MaxInt64)
	maxH := int64(0)
	for h := range hours {
		if h < minH {
			minH = h
		}
		if h > maxH {
			maxH = h
		}
	}
	maxEnd := maxH + rollupHourMS
	if maxEnd < maxH {
		maxEnd = math.MaxInt64
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT start_hour_ms, end_hour_ms
		FROM model_usage_rollup_coverage
		WHERE end_hour_ms > ? AND start_hour_ms < ?
		ORDER BY start_hour_ms`, minH, maxEnd)
	if err != nil {
		return err
	}
	var existing []hourRange
	for rows.Next() {
		var r hourRange
		if scanErr := rows.Scan(&r.StartHour, &r.EndHour); scanErr != nil {
			_ = rows.Close()
			return scanErr
		}
		existing = append(existing, r)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	_ = rows.Close()
	if len(existing) == 0 {
		return nil
	}
	kept, removed := subtractHoursFromRanges(existing, hours)
	if len(removed) == 0 {
		return nil
	}
	for _, old := range existing {
		if _, err := tx.ExecContext(ctx, `DELETE FROM model_usage_rollup_coverage WHERE start_hour_ms = ?`, old.StartHour); err != nil {
			return err
		}
	}
	for _, k := range kept {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO model_usage_rollup_coverage (start_hour_ms, end_hour_ms)
			VALUES (?, ?)`, k.StartHour, k.EndHour); err != nil {
			return err
		}
	}
	return nil
}

func isHourMaterializedOrCoveredTx(ctx context.Context, tx *sql.Tx, h int64) (bool, error) {
	var exists int
	if err := tx.QueryRowContext(ctx, `
		SELECT CASE
			WHEN EXISTS(SELECT 1 FROM model_usage_rollup_hours WHERE hour_ms = ?)
			  OR EXISTS(SELECT 1 FROM model_usage_rollup_coverage WHERE start_hour_ms <= ? AND end_hour_ms > ?)
			THEN 1 ELSE 0 END`, h, h, h).Scan(&exists); err != nil {
		return false, err
	}
	return exists != 0, nil
}

func bumpChangeRevTx(ctx context.Context, tx *sql.Tx) (int64, error) {
	if _, err := tx.ExecContext(ctx, `
		UPDATE model_usage_rollup_meta
		SET int_val = int_val + 1
		WHERE key = 'change_rev'`); err != nil {
		return 0, err
	}
	var rev int64
	if err := tx.QueryRowContext(ctx, `
		SELECT int_val FROM model_usage_rollup_meta WHERE key = 'change_rev'`).Scan(&rev); err != nil {
		return 0, err
	}
	return rev, nil
}

func invalidateRollupHoursTx(
	ctx context.Context,
	tx *sql.Tx,
	hours []int64,
	newRev int64,
	reasonMask int,
	deleteAttributions bool,
) error {
	for _, h := range hours {
		for _, delSQL := range []string{
			`DELETE FROM model_usage_rollup_hourly_model WHERE hour_ms = ?`,
			`DELETE FROM model_usage_rollup_hourly_session WHERE hour_ms = ?`,
			`DELETE FROM model_usage_rollup_hourly_prompt WHERE hour_ms = ?`,
			`DELETE FROM model_usage_rollup_hours WHERE hour_ms = ?`,
		} {
			if _, err := tx.ExecContext(ctx, delSQL, h); err != nil {
				return err
			}
		}
		if deleteAttributions {
			if _, err := tx.ExecContext(ctx, `
				DELETE FROM model_usage_rollup_attributions
				WHERE scanner_hour_ms = ? OR proxy_hour_ms = ?`, h, h); err != nil {
				return err
			}
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO model_usage_rollup_dirty_hours (hour_ms, dirty_rev, reason_mask)
			VALUES (?, ?, ?)
			ON CONFLICT(hour_ms) DO UPDATE SET
				dirty_rev = excluded.dirty_rev,
				reason_mask = reason_mask | excluded.reason_mask`,
			h, newRev, reasonMask); err != nil {
			return err
		}
	}
	return nil
}
