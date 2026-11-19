package distributiondata

import (
	"context"
	"database/sql"
	"fmt"
)

// verifyLedgerDaily validates a repaired derived table against its preserved facts,
// not against potentially stale pre-repair aggregates. Unknown extension columns
// retain the ordinary strict preservation check rather than being silently lost.
func verifyLedgerDaily(ctx context.Context, db *sql.DB) (TableCheck, error) {
	names := []string{
		"day_ms", "account_ref", "provider_id", "model_id", "quota_bucket", "calls",
		"input_tokens", "output_tokens", "cached_input_tokens",
		"cache_write_input_tokens", "reasoning_tokens", "total_tokens",
	}
	known := make(map[string]bool, len(names))
	for _, name := range names {
		known[name] = true
	}
	beforeColumns, err := columns(ctx, db, "before", "usage_ledger_daily")
	if err != nil {
		return TableCheck{}, err
	}
	for _, name := range beforeColumns {
		if !known[name] {
			if _, err := compareTable(ctx, db, "before", "usage_ledger_daily", "main", "usage_ledger_daily"); err != nil {
				return TableCheck{}, err
			}
			break
		}
	}
	check := TableCheck{
		Source: "main.usage_ledger",
		Target: "main.usage_ledger_daily",
		Check:  "derived_aggregate_bidirectional_except_with_multiplicity",
	}
	const aggregate = `SELECT
		occurred_at_ms / 86400000 * 86400000 AS day_ms,
		account_ref, provider_id, model_id, quota_bucket, COUNT(*) AS calls,
		COALESCE(SUM(input_tokens), 0) AS input_tokens,
		COALESCE(SUM(output_tokens), 0) AS output_tokens,
		COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
		COALESCE(SUM(cache_write_input_tokens), 0) AS cache_write_input_tokens,
		COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
		COALESCE(SUM(total_tokens), 0) AS total_tokens
		FROM main.usage_ledger GROUP BY 1, 2, 3, 4, 5`
	if err := equalQueries(ctx, db, aggregate, selectTable("main", "usage_ledger_daily", names), names); err != nil {
		return check, fmt.Errorf("distributiondata: usage_ledger_daily does not match ledger facts: %w", err)
	}
	err = db.QueryRowContext(ctx, "SELECT COUNT(*) FROM main.usage_ledger_daily").Scan(&check.Rows)
	return check, err
}
