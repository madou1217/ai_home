package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/modelalias"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/aliasdisplay"
)

var errLegacyAliasDisplaySource = errors.New("model_alias_legacy_display_source_required")

// migrateLegacyModelAliases is the only first-read bridge from the old table.
// A positive generation is also an empty-set tombstone: deleting all aliases
// must never authorize replaying the retained legacy source on a later start.
func (store *Store) migrateLegacyModelAliases(ctx context.Context) error {
	if store == nil || store.db == nil || ctx == nil {
		return modelalias.ErrInvalidProjection
	}
	pending, err := legacyAliasMigrationPending(ctx, store.db)
	if err != nil || !pending {
		return err
	}
	conn, err := store.db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("model_alias_legacy_connection: %w", err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return fmt.Errorf("model_alias_legacy_begin: %w", err)
	}
	defer conn.ExecContext(context.WithoutCancel(ctx), "ROLLBACK")
	// Recheck under the SQLite writer lock, including writes by other processes.
	pending, err = legacyAliasMigrationPending(ctx, conn)
	if err != nil || !pending {
		return err
	}
	records, err := store.readLegacyModelAliases(ctx, conn)
	if err != nil {
		return err
	}
	const insert = `INSERT INTO model_alias (
    id, alias, target, provider, target_provider, priority, enabled,
    description, created_at_ms, updated_at_ms, position, display_models_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	for position, row := range records {
		record := row.record
		if _, err := conn.ExecContext(ctx, insert,
			record.ID, record.Alias, record.Target, record.Provider,
			record.TargetProvider, record.Priority, record.IsEnabled(),
			record.Description, row.createdAt, row.updatedAt, position, encodeDisplayModels(record.DisplayModels),
		); err != nil {
			return fmt.Errorf("model_alias_legacy_insert: %w", err)
		}
	}
	result, err := conn.ExecContext(ctx,
		"UPDATE model_alias_meta SET generation = generation + 1 WHERE id = 1 AND generation = 0")
	if err != nil {
		return fmt.Errorf("model_alias_legacy_generation: %w", err)
	}
	if changed, err := result.RowsAffected(); err != nil || changed != 1 {
		return errors.New("model_alias_legacy_generation_changed")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if _, err := conn.ExecContext(context.WithoutCancel(ctx), "COMMIT"); err != nil {
		return fmt.Errorf("model_alias_legacy_commit: %w", err)
	}
	return nil
}

// A missing/corrupt canonical table or metadata row is an error, not an empty
// installation. Reading both facts in one statement avoids mixed generations.
func legacyAliasMigrationPending(ctx context.Context, reader generationReader) (bool, error) {
	var count, generation int64
	err := reader.QueryRowContext(ctx, `
    SELECT (SELECT count(*) FROM model_alias), generation
    FROM model_alias_meta WHERE id = 1`).Scan(&count, &generation)
	if err != nil {
		return false, fmt.Errorf("model_alias_legacy_canonical_read: %w", err)
	}
	if generation < 0 {
		return false, errors.New("model_alias_legacy_generation_invalid")
	}
	return count == 0 && generation == 0, nil
}

type legacyAliasRow struct {
	record    modelalias.Record
	createdAt int64
	updatedAt int64
}

func (store *Store) readLegacyModelAliases(ctx context.Context, conn *sql.Conn) ([]legacyAliasRow, error) {
	var kind string
	err := conn.QueryRowContext(ctx, "SELECT type FROM sqlite_master WHERE name = 'model_aliases'").Scan(&kind)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil // Proven absent source; record the empty first-read once.
	}
	if err != nil {
		return nil, fmt.Errorf("model_alias_legacy_source_read: %w", err)
	}
	if kind != "table" {
		return nil, errors.New("model_alias_legacy_source_invalid")
	}
	rows, err := conn.QueryContext(ctx, `
    SELECT id, alias, target, provider, target_provider, priority, enabled,
           description, created_at, updated_at
    FROM model_aliases ORDER BY created_at ASC, id ASC LIMIT ?`, modelalias.MaxRecords+1)
	if err != nil {
		return nil, fmt.Errorf("model_alias_legacy_source_read: %w", err)
	}
	defer rows.Close()
	records := make([]legacyAliasRow, 0)
	seen := make(map[string]struct{})
	for rows.Next() {
		var row legacyAliasRow
		var priority, enabled int64
		record := &row.record
		if err := rows.Scan(&record.ID, &record.Alias, &record.Target, &record.Provider,
			&record.TargetProvider, &priority, &enabled, &record.Description,
			&row.createdAt, &row.updatedAt); err != nil {
			return nil, fmt.Errorf("model_alias_legacy_source_row: %w", err)
		}
		record.ID = strings.TrimSpace(record.ID)
		record.Alias = strings.TrimSpace(record.Alias)
		record.Target = strings.TrimSpace(record.Target)
		record.Description = strings.TrimSpace(record.Description)
		record.Provider = strings.ToLower(strings.TrimSpace(record.Provider))
		if record.Provider != modelalias.ScopeAll && !store.catalog.Contains(record.Provider) {
			record.Provider = modelalias.ScopeAll
		}
		record.TargetProvider = strings.ToLower(strings.TrimSpace(record.TargetProvider))
		if record.TargetProvider != modelalias.TargetProviderAuto && !store.catalog.Contains(record.TargetProvider) {
			record.TargetProvider = modelalias.TargetProviderAuto
		}
		if !record.IsValid() || priority < math.MinInt32 || priority > math.MaxInt32 {
			return nil, modelalias.ErrInvalidAlias
		}
		record.Priority = int32(priority)
		on := enabled != 0
		record.Enabled = &on
		if _, duplicate := seen[record.ID]; duplicate {
			return nil, modelalias.ErrInvalidProjection
		}
		seen[record.ID] = struct{}{}
		// The same pinned models.dev SDK and display policy formerly used by
		// Node are generated into a validated build-time Go snapshot. Preserve
		// legacy wildcard visibility without restoring a Node seed writer.
		if strings.HasSuffix(record.Alias, "*") {
			display, err := aliasdisplay.List(record.Alias, time.Now().UTC())
			if err != nil {
				return nil, fmt.Errorf("%w: %w", errLegacyAliasDisplaySource, err)
			}
			record.DisplayModels = display
		}
		records = append(records, row)
		if len(records) > modelalias.MaxRecords {
			return nil, modelalias.ErrInvalidProjection
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("model_alias_legacy_source_rows: %w", err)
	}
	return records, nil
}
