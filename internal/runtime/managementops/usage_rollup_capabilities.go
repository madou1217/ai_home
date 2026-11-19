package managementops

import (
	"context"
	"database/sql"
	"strings"
)

type rollupMetaSnapshot struct {
	triggersReady bool
	hasChangeRev  bool
	hasForkRev    bool
	hasPricingRev bool
	changeRev     int64
	forkRev       int64
	pricingRev    int64
}

type sqlQueryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

func readRollupMetaQueryer(ctx context.Context, q sqlQueryer) (rollupMetaSnapshot, bool, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT key, int_val
		FROM model_usage_rollup_meta
		WHERE key IN ('triggers_ready', 'change_rev', 'fork_rev', 'pricing_rev')`)
	if err != nil {
		if isSQLiteMissingTable(err) {
			return rollupMetaSnapshot{}, false, nil
		}
		return rollupMetaSnapshot{}, false, err
	}
	defer func() { _ = rows.Close() }()

	var snap rollupMetaSnapshot
	found := false
	for rows.Next() {
		var key string
		var val int64
		if scanErr := rows.Scan(&key, &val); scanErr != nil {
			return rollupMetaSnapshot{}, false, scanErr
		}
		found = true
		switch key {
		case "triggers_ready":
			snap.triggersReady = val == 1
		case "change_rev":
			snap.hasChangeRev = true
			snap.changeRev = val
		case "fork_rev":
			snap.hasForkRev = true
			snap.forkRev = val
		case "pricing_rev":
			snap.hasPricingRev = true
			snap.pricingRev = val
		}
	}
	if err := rows.Err(); err != nil {
		return rollupMetaSnapshot{}, false, err
	}
	return snap, found, nil
}

type rollupCapabilityReport struct {
	allReady         bool
	meta             rollupMetaSnapshot
	mismatchedTables map[string]bool
	missingTables    map[string]bool
	missingIndexes   map[string]bool
	missingTriggers  map[string]bool
}

func readTableColumnSet(ctx context.Context, q sqlQueryer, tableName string) (map[string]struct{}, bool, error) {
	rows, err := q.QueryContext(ctx, "PRAGMA table_info("+tableName+")")
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = rows.Close() }()

	cols := make(map[string]struct{})
	for rows.Next() {
		var cid, notNull, pk int
		var name, colType string
		var dflt sql.NullString
		if scanErr := rows.Scan(&cid, &name, &colType, &notNull, &dflt, &pk); scanErr != nil {
			return nil, false, scanErr
		}
		cols[name] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	return cols, len(cols) > 0, nil
}

// inspectRollupCapabilitiesQueryer 按实际表、列、索引、触发器正文与数据修订做能力检查。
// 同名触发器不等于具备维护能力；正文比较必须保留 SQL 字符串字面量。
func inspectRollupCapabilitiesQueryer(ctx context.Context, q sqlQueryer) (rollupCapabilityReport, error) {
	report := rollupCapabilityReport{
		mismatchedTables: make(map[string]bool),
		missingTables:    make(map[string]bool),
		missingIndexes:   make(map[string]bool),
		missingTriggers:  make(map[string]bool),
	}

	for _, spec := range requiredRollupTables {
		cols, exists, err := readTableColumnSet(ctx, q, spec.name)
		if err != nil {
			return rollupCapabilityReport{}, err
		}
		if !exists {
			report.missingTables[spec.name] = true
			continue
		}
		for _, wantCol := range spec.columns {
			if _, ok := cols[wantCol]; !ok {
				report.mismatchedTables[spec.name] = true
				break
			}
		}
	}

	existingIndexes := make(map[string]struct{}, len(requiredRollupIndexes))
	existingTriggers := make(map[string]string, len(rollupTriggerDefs))
	smRows, err := q.QueryContext(ctx, `
		SELECT type, name, sql FROM sqlite_master
		WHERE (type = 'index' AND name LIKE 'idx_usage_rollup_%')
			OR (type = 'trigger' AND name LIKE 'trg_usage_rollup_%')`)
	if err != nil {
		return rollupCapabilityReport{}, err
	}
	for smRows.Next() {
		var kind, name string
		var rawSQL sql.NullString
		if scanErr := smRows.Scan(&kind, &name, &rawSQL); scanErr != nil {
			_ = smRows.Close()
			return rollupCapabilityReport{}, scanErr
		}
		if kind == "index" {
			existingIndexes[name] = struct{}{}
		} else if kind == "trigger" {
			existingTriggers[name] = normalizeTriggerSQL(rawSQL.String)
		}
	}
	if err := smRows.Err(); err != nil {
		_ = smRows.Close()
		return rollupCapabilityReport{}, err
	}
	_ = smRows.Close()
	for _, idx := range requiredRollupIndexes {
		if _, ok := existingIndexes[idx.name]; !ok {
			report.missingIndexes[idx.name] = true
		}
	}
	for _, trig := range rollupTriggerDefs {
		if signature, ok := existingTriggers[trig.name]; !ok || signature != normalizeTriggerSQL(trig.ddl) {
			report.missingTriggers[trig.name] = true
		}
	}

	if !report.missingTables["model_usage_rollup_meta"] && !report.mismatchedTables["model_usage_rollup_meta"] {
		meta, _, metaErr := readRollupMetaQueryer(ctx, q)
		if metaErr != nil {
			return rollupCapabilityReport{}, metaErr
		}
		report.meta = meta
	}

	report.allReady = len(report.missingTables) == 0 &&
		len(report.mismatchedTables) == 0 &&
		len(report.missingIndexes) == 0 &&
		len(report.missingTriggers) == 0 &&
		report.meta.triggersReady &&
		report.meta.hasChangeRev &&
		report.meta.hasForkRev &&
		report.meta.hasPricingRev
	return report, nil
}

func isSQLiteReadOnlyOrBusy(err error) (readOnly bool, busy bool) {
	if err == nil {
		return false, false
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "readonly") || strings.Contains(msg, "read-only") {
		return true, false
	}
	if strings.Contains(msg, "sqlite_busy") || strings.Contains(msg, "database is locked") || strings.Contains(msg, "database table is locked") {
		return false, true
	}
	return false, false
}
