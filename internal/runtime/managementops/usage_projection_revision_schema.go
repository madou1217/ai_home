package managementops

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

type projectionRevisionTriggerSpec struct {
	name          string
	table         string
	sql           string
	normalizedSQL string
}

var (
	projectionRevisionTriggerSpecs = []projectionRevisionTriggerSpec{
		{
			name:  "trg_mup_rev_records_insert",
			table: "model_usage_records",
			sql: `CREATE TRIGGER IF NOT EXISTS trg_mup_rev_records_insert
		AFTER INSERT ON model_usage_records
		BEGIN
			UPDATE model_usage_projection_revision
			SET rev = rev + 1, records_rev = records_rev + 1
			WHERE id = 1;
		END`,
		},
		{
			name:  "trg_mup_rev_records_update",
			table: "model_usage_records",
			sql: `CREATE TRIGGER IF NOT EXISTS trg_mup_rev_records_update
		AFTER UPDATE ON model_usage_records
		BEGIN
			UPDATE model_usage_projection_revision
			SET rev = rev + 1, records_rev = records_rev + 1
			WHERE id = 1;
		END`,
		},
		{
			name:  "trg_mup_rev_records_delete",
			table: "model_usage_records",
			sql: `CREATE TRIGGER IF NOT EXISTS trg_mup_rev_records_delete
		AFTER DELETE ON model_usage_records
		BEGIN
			UPDATE model_usage_projection_revision
			SET rev = rev + 1, records_rev = records_rev + 1
			WHERE id = 1;
		END`,
		},
		{
			name:  "trg_mup_rev_prompts_insert",
			table: "model_usage_prompt_events",
			sql: `CREATE TRIGGER IF NOT EXISTS trg_mup_rev_prompts_insert
		AFTER INSERT ON model_usage_prompt_events
		BEGIN
			UPDATE model_usage_projection_revision
			SET rev = rev + 1, prompts_rev = prompts_rev + 1
			WHERE id = 1;
		END`,
		},
		{
			name:  "trg_mup_rev_prompts_update",
			table: "model_usage_prompt_events",
			sql: `CREATE TRIGGER IF NOT EXISTS trg_mup_rev_prompts_update
		AFTER UPDATE ON model_usage_prompt_events
		BEGIN
			UPDATE model_usage_projection_revision
			SET rev = rev + 1, prompts_rev = prompts_rev + 1
			WHERE id = 1;
		END`,
		},
		{
			name:  "trg_mup_rev_prompts_delete",
			table: "model_usage_prompt_events",
			sql: `CREATE TRIGGER IF NOT EXISTS trg_mup_rev_prompts_delete
		AFTER DELETE ON model_usage_prompt_events
		BEGIN
			UPDATE model_usage_projection_revision
			SET rev = rev + 1, prompts_rev = prompts_rev + 1
			WHERE id = 1;
		END`,
		},
		{
			name:  "trg_mup_rev_sessions_insert",
			table: "model_usage_sessions",
			sql: `CREATE TRIGGER IF NOT EXISTS trg_mup_rev_sessions_insert
		AFTER INSERT ON model_usage_sessions
		BEGIN
			UPDATE model_usage_projection_revision
			SET rev = rev + 1, sessions_rev = sessions_rev + 1
			WHERE id = 1;
		END`,
		},
		{
			name:  "trg_mup_rev_sessions_update",
			table: "model_usage_sessions",
			sql: `CREATE TRIGGER IF NOT EXISTS trg_mup_rev_sessions_update
		AFTER UPDATE ON model_usage_sessions
		WHEN new.provider IS NOT old.provider
			OR new.session_id IS NOT old.session_id
			OR new.project IS NOT old.project
			OR new.cwd IS NOT old.cwd
			OR new.git_branch IS NOT old.git_branch
			OR new.started_at_ms IS NOT old.started_at_ms
			OR new.updated_at_ms IS NOT old.updated_at_ms
			OR new.prompt_count IS NOT old.prompt_count
		BEGIN
			UPDATE model_usage_projection_revision
			SET rev = rev + 1, sessions_rev = sessions_rev + 1
			WHERE id = 1;
		END`,
		},
		{
			name:  "trg_mup_rev_sessions_delete",
			table: "model_usage_sessions",
			sql: `CREATE TRIGGER IF NOT EXISTS trg_mup_rev_sessions_delete
		AFTER DELETE ON model_usage_sessions
		BEGIN
			UPDATE model_usage_projection_revision
			SET rev = rev + 1, sessions_rev = sessions_rev + 1
			WHERE id = 1;
		END`,
		},
		{
			name:  "trg_mup_rev_file_state_insert",
			table: "model_usage_file_state",
			sql: `CREATE TRIGGER IF NOT EXISTS trg_mup_rev_file_state_insert
		AFTER INSERT ON model_usage_file_state
		WHEN new.scan_context LIKE '%codexForkSession%'
		BEGIN
			UPDATE model_usage_projection_revision
			SET rev = rev + 1, file_state_rev = file_state_rev + 1
			WHERE id = 1;
		END`,
		},
		{
			name:  "trg_mup_rev_file_state_update",
			table: "model_usage_file_state",
			sql: `CREATE TRIGGER IF NOT EXISTS trg_mup_rev_file_state_update
		AFTER UPDATE ON model_usage_file_state
		WHEN new.scan_context IS NOT old.scan_context
			AND (new.scan_context LIKE '%codexForkSession%' OR old.scan_context LIKE '%codexForkSession%')
		BEGIN
			UPDATE model_usage_projection_revision
			SET rev = rev + 1, file_state_rev = file_state_rev + 1
			WHERE id = 1;
		END`,
		},
		{
			name:  "trg_mup_rev_file_state_delete",
			table: "model_usage_file_state",
			sql: `CREATE TRIGGER IF NOT EXISTS trg_mup_rev_file_state_delete
		AFTER DELETE ON model_usage_file_state
		WHEN old.scan_context LIKE '%codexForkSession%'
		BEGIN
			UPDATE model_usage_projection_revision
			SET rev = rev + 1, file_state_rev = file_state_rev + 1
			WHERE id = 1;
		END`,
		},
		{
			name:  "trg_mup_rev_pricing_insert",
			table: "model_usage_pricing",
			sql: `CREATE TRIGGER IF NOT EXISTS trg_mup_rev_pricing_insert
		AFTER INSERT ON model_usage_pricing
		BEGIN
			UPDATE model_usage_projection_revision
			SET rev = rev + 1, pricing_rev = pricing_rev + 1
			WHERE id = 1;
		END`,
		},
		{
			name:  "trg_mup_rev_pricing_update",
			table: "model_usage_pricing",
			sql: `CREATE TRIGGER IF NOT EXISTS trg_mup_rev_pricing_update
		AFTER UPDATE ON model_usage_pricing
		BEGIN
			UPDATE model_usage_projection_revision
			SET rev = rev + 1, pricing_rev = pricing_rev + 1
			WHERE id = 1;
		END`,
		},
		{
			name:  "trg_mup_rev_pricing_delete",
			table: "model_usage_pricing",
			sql: `CREATE TRIGGER IF NOT EXISTS trg_mup_rev_pricing_delete
		AFTER DELETE ON model_usage_pricing
		BEGIN
			UPDATE model_usage_projection_revision
			SET rev = rev + 1, pricing_rev = pricing_rev + 1
			WHERE id = 1;
		END`,
		},
		{
			name:  "trg_mup_rev_appkv_insert",
			table: "app_kv",
			sql: `CREATE TRIGGER IF NOT EXISTS trg_mup_rev_appkv_insert
		AFTER INSERT ON app_kv
		WHEN new.key IN ('active:model_usage_pricing', 'model-catalog-settings')
		BEGIN
			UPDATE model_usage_projection_revision
			SET rev = rev + 1, pricing_rev = pricing_rev + 1
			WHERE id = 1;
		END`,
		},
		{
			name:  "trg_mup_rev_appkv_update",
			table: "app_kv",
			sql: `CREATE TRIGGER IF NOT EXISTS trg_mup_rev_appkv_update
		AFTER UPDATE ON app_kv
		WHEN (new.key IN ('active:model_usage_pricing', 'model-catalog-settings')
				OR old.key IN ('active:model_usage_pricing', 'model-catalog-settings'))
			AND (new.value IS NOT old.value OR new.key IS NOT old.key OR new.updated_at IS NOT old.updated_at)
		BEGIN
			UPDATE model_usage_projection_revision
			SET rev = rev + 1, pricing_rev = pricing_rev + 1
			WHERE id = 1;
		END`,
		},
		{
			name:  "trg_mup_rev_appkv_delete",
			table: "app_kv",
			sql: `CREATE TRIGGER IF NOT EXISTS trg_mup_rev_appkv_delete
		AFTER DELETE ON app_kv
		WHEN old.key IN ('active:model_usage_pricing', 'model-catalog-settings')
		BEGIN
			UPDATE model_usage_projection_revision
			SET rev = rev + 1, pricing_rev = pricing_rev + 1
			WHERE id = 1;
		END`,
		},
	}

	projectionRevisionTriggerByName map[string]projectionRevisionTriggerSpec
	projectionRevisionTriggerSelect string
	projectionRevisionTriggerArgs   []any
)

func init() {
	projectionRevisionTriggerByName = make(map[string]projectionRevisionTriggerSpec, len(projectionRevisionTriggerSpecs))
	placeholders := make([]string, 0, len(projectionRevisionTriggerSpecs))
	projectionRevisionTriggerArgs = make([]any, 0, len(projectionRevisionTriggerSpecs))
	for i := range projectionRevisionTriggerSpecs {
		spec := &projectionRevisionTriggerSpecs[i]
		spec.normalizedSQL = normalizeTriggerSQL(spec.sql)
		projectionRevisionTriggerByName[spec.name] = *spec
		placeholders = append(placeholders, "?")
		projectionRevisionTriggerArgs = append(projectionRevisionTriggerArgs, spec.name)
	}
	projectionRevisionTriggerSelect = `SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger' AND name IN (` + strings.Join(placeholders, ",") + `)`
}

func normalizeTriggerSQL(raw string) string {
	// Compare our canonical DDL conservatively. Case-folding or normalizing
	// literal contents could bless a trigger whose WHEN predicate no longer fires.
	collapsed := strings.TrimSpace(raw)
	collapsed = strings.TrimSpace(strings.TrimSuffix(collapsed, ";"))
	const prefixWithINE = "CREATE TRIGGER IF NOT EXISTS "
	const prefixNoINE = "CREATE TRIGGER "
	if strings.HasPrefix(collapsed, prefixWithINE) {
		collapsed = prefixNoINE + strings.TrimPrefix(collapsed, prefixWithINE)
	}
	return collapsed
}

// ProjectionRevisionSchemaStatements returns the DDL and seed statements for the
// persistent single-row revision counter and table triggers. Parent/global schema
// migrations can embed these statements directly.
func ProjectionRevisionSchemaStatements() []string {
	stmts := make([]string, 0, 2+len(projectionRevisionTriggerSpecs))
	stmts = append(stmts,
		`CREATE TABLE IF NOT EXISTS model_usage_projection_revision (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			db_epoch INTEGER NOT NULL DEFAULT 1,
			rev INTEGER NOT NULL DEFAULT 1,
			records_rev INTEGER NOT NULL DEFAULT 1,
			prompts_rev INTEGER NOT NULL DEFAULT 1,
			sessions_rev INTEGER NOT NULL DEFAULT 1,
			file_state_rev INTEGER NOT NULL DEFAULT 1,
			pricing_rev INTEGER NOT NULL DEFAULT 1
		)`,
		`INSERT OR IGNORE INTO model_usage_projection_revision (
			id, db_epoch, rev, records_rev, prompts_rev, sessions_rev, file_state_rev, pricing_rev
		) VALUES (1, 1, 1, 1, 1, 1, 1, 1)`,
	)
	for _, spec := range projectionRevisionTriggerSpecs {
		stmts = append(stmts, spec.sql)
	}
	return stmts
}

// EnsureProjectionRevisionSchema idempotently ensures the persistent revision
// table, db_epoch column, counter seed row, and all 18 required triggers exist
// without scanning data tables.
func EnsureProjectionRevisionSchema(ctx context.Context, db *sql.DB) error {
	_, err := ensureProjectionRevisionSchemaWithRepair(ctx, db)
	return err
}

func ensureProjectionRevisionSchemaWithRepair(ctx context.Context, db *sql.DB) (bool, error) {
	if db == nil {
		return false, nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if hasValidProjectionRevisionSchema(ctx, db) {
		return false, nil
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()

	if err := ctx.Err(); err != nil {
		return false, err
	}
	if _, execErr := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS model_usage_projection_revision (
			id INTEGER PRIMARY KEY CHECK (id = 1),
			db_epoch INTEGER NOT NULL DEFAULT 1,
			rev INTEGER NOT NULL DEFAULT 1,
			records_rev INTEGER NOT NULL DEFAULT 1,
			prompts_rev INTEGER NOT NULL DEFAULT 1,
			sessions_rev INTEGER NOT NULL DEFAULT 1,
			file_state_rev INTEGER NOT NULL DEFAULT 1,
			pricing_rev INTEGER NOT NULL DEFAULT 1
		)`); execErr != nil {
		return false, execErr
	}

	hasEpochCol, colErr := revisionTableHasEpochColumn(ctx, tx)
	if colErr != nil {
		return false, colErr
	}
	hadColumnGap := false
	if !hasEpochCol {
		if _, alterErr := tx.ExecContext(ctx, `ALTER TABLE model_usage_projection_revision ADD COLUMN db_epoch INTEGER NOT NULL DEFAULT 1`); alterErr != nil {
			return false, alterErr
		}
		hadColumnGap = true
	}

	var oldEpoch int64
	rowErr := tx.QueryRowContext(ctx, `SELECT db_epoch FROM model_usage_projection_revision WHERE id = 1`).Scan(&oldEpoch)
	rowExists := rowErr == nil
	if rowErr != nil && !errors.Is(rowErr, sql.ErrNoRows) {
		return false, rowErr
	}

	allValid, validSet, mismatched, inspErr := inspectProjectionTriggersQuerier(ctx, tx)
	if inspErr != nil {
		return false, inspErr
	}
	if rowExists && oldEpoch > 0 && !hadColumnGap && allValid {
		// Another writer repaired the schema concurrently before tx acquired the write lock.
		return true, nil
	}

	for _, name := range mismatched {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		if _, dropErr := tx.ExecContext(ctx, `DROP TRIGGER IF EXISTS `+name); dropErr != nil {
			return false, dropErr
		}
	}
	for _, spec := range projectionRevisionTriggerSpecs {
		if err := ctx.Err(); err != nil {
			return false, err
		}
		if validSet[spec.name] {
			continue
		}
		if _, trigErr := tx.ExecContext(ctx, spec.sql); trigErr != nil {
			return false, trigErr
		}
	}

	freshEpoch := nextRevisionEpochSeed(oldEpoch)
	if !rowExists {
		if _, insErr := tx.ExecContext(ctx, `
			INSERT INTO model_usage_projection_revision (
				id, db_epoch, rev, records_rev, prompts_rev, sessions_rev, file_state_rev, pricing_rev
			) VALUES (1, ?, 1, 1, 1, 1, 1, 1)`, freshEpoch); insErr != nil {
			return false, insErr
		}
	} else {
		// Any gap or trigger recreation could have dropped intermediate writes;
		// atomically bump db_epoch and all revision counters so every store/process misses stale keys.
		if _, updErr := tx.ExecContext(ctx, `
			UPDATE model_usage_projection_revision
			SET
				db_epoch = ?,
				rev = rev + 1,
				records_rev = records_rev + 1,
				prompts_rev = prompts_rev + 1,
				sessions_rev = sessions_rev + 1,
				file_state_rev = file_state_rev + 1,
				pricing_rev = pricing_rev + 1
			WHERE id = 1`, freshEpoch); updErr != nil {
			return false, updErr
		}
	}

	if err := tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

func revisionTableHasEpochColumn(ctx context.Context, q sqlQuerier) (bool, error) {
	rows, err := q.QueryContext(ctx, `PRAGMA table_info(model_usage_projection_revision)`)
	if err != nil {
		return false, err
	}
	defer func() { _ = rows.Close() }()

	for rows.Next() {
		var (
			cid     int
			colName string
			colType string
			notNull int
			dfltVal sql.NullString
			pk      int
		)
		if scanErr := rows.Scan(&cid, &colName, &colType, &notNull, &dfltVal, &pk); scanErr != nil {
			return false, scanErr
		}
		if strings.EqualFold(strings.TrimSpace(colName), "db_epoch") {
			return true, nil
		}
	}
	return false, rows.Err()
}

func inspectProjectionTriggersQuerier(
	ctx context.Context,
	q sqlQuerier,
) (allValid bool, valid map[string]bool, mismatched []string, err error) {
	rows, err := q.QueryContext(ctx, projectionRevisionTriggerSelect, projectionRevisionTriggerArgs...)
	if err != nil {
		return false, nil, nil, err
	}
	defer func() { _ = rows.Close() }()

	valid = make(map[string]bool, len(projectionRevisionTriggerSpecs))
	for rows.Next() {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return false, nil, nil, ctxErr
		}
		var (
			name    string
			tblName sql.NullString
			rawSQL  sql.NullString
		)
		if scanErr := rows.Scan(&name, &tblName, &rawSQL); scanErr != nil {
			return false, nil, nil, scanErr
		}
		spec, ok := projectionRevisionTriggerByName[name]
		if !ok {
			continue
		}
		if !strings.EqualFold(strings.TrimSpace(tblName.String), spec.table) ||
			normalizeTriggerSQL(rawSQL.String) != spec.normalizedSQL {
			mismatched = append(mismatched, name)
			continue
		}
		valid[name] = true
	}
	if rowsErr := rows.Err(); rowsErr != nil {
		return false, nil, nil, rowsErr
	}
	allValid = len(valid) == len(projectionRevisionTriggerSpecs) && len(mismatched) == 0
	return allValid, valid, mismatched, nil
}

func hasValidProjectionRevisionSchema(ctx context.Context, db *sql.DB) bool {
	var dbEpoch, rev int64
	if err := db.QueryRowContext(ctx, `
		SELECT db_epoch, rev
		FROM model_usage_projection_revision
		WHERE id = 1`).Scan(&dbEpoch, &rev); err != nil || dbEpoch <= 0 {
		return false
	}
	allValid, _, _, err := inspectProjectionTriggersQuerier(ctx, db)
	return err == nil && allValid
}
