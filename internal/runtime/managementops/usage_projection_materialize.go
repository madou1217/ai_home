package managementops

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"strings"
)

// populateProjectionTables batches temporary writes in one savepoint. It works
// within an existing read snapshot and rolls back a partially loaded projection
// on cancellation or a failed batch. Parameters retain SQLite integer/float types.
func populateProjectionTables(ctx context.Context, conn *sql.Conn, projection *UsageProjectionContext) (resultErr error) {
	// Cancellation may be reported after SQLite has already created the savepoint.
	// Install cleanup before executing it; if transaction cleanup is uncertain,
	// discard the connection instead of returning a manual transaction to the pool.
	defer func() {
		if resultErr == nil {
			return
		}
		cleanupCtx := context.WithoutCancel(ctx)
		_, rollbackErr := conn.ExecContext(cleanupCtx, `ROLLBACK TO usage_read_materialize`)
		_, releaseErr := conn.ExecContext(cleanupCtx, `RELEASE usage_read_materialize`)
		if rollbackErr != nil || releaseErr != nil {
			resultErr = errors.Join(resultErr, rollbackErr, releaseErr)
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
	}()
	if _, err := conn.ExecContext(ctx, `SAVEPOINT usage_read_materialize`); err != nil {
		return err
	}
	for _, statement := range []string{
		`CREATE TEMP TABLE IF NOT EXISTS model_usage_read_fork_contexts (
			source_hash TEXT PRIMARY KEY, replay_pending INTEGER NOT NULL,
			boundary_offset INTEGER NOT NULL, session_id TEXT NOT NULL,
			cwd TEXT NOT NULL, project TEXT NOT NULL)`,
		`CREATE TEMP TABLE IF NOT EXISTS model_usage_read_attributions (
			scanner_id INTEGER PRIMARY KEY, proxy_id INTEGER NOT NULL UNIQUE,
			model TEXT NOT NULL, account_provider TEXT NOT NULL,
			account_ref TEXT NOT NULL, cost_usd REAL NOT NULL)`,
		`DELETE FROM temp.model_usage_read_fork_contexts`,
		`DELETE FROM temp.model_usage_read_attributions`,
	} {
		if _, err := conn.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("准备临时读投影表失败: %w", err)
		}
	}
	if projection != nil {
		if err := insertProjectionBatches(ctx, conn,
			`INSERT INTO temp.model_usage_read_fork_contexts (source_hash,replay_pending,boundary_offset,session_id,cwd,project) VALUES `,
			len(projection.ForkDescriptors), func(i int) [6]any {
				fork := projection.ForkDescriptors[i]
				pending := 0
				if fork.ReplayPending {
					pending = 1
				}
				return [6]any{fork.SourceHash, pending, fork.BoundaryOffset, fork.SessionID, fork.CWD, fork.Project}
			}); err != nil {
			return err
		}
		if err := insertProjectionBatches(ctx, conn,
			`INSERT INTO temp.model_usage_read_attributions (scanner_id,proxy_id,model,account_provider,account_ref,cost_usd) VALUES `,
			len(projection.Attributions), func(i int) [6]any {
				a := projection.Attributions[i]
				return [6]any{a.ScannerID, a.ProxyID, a.Model, a.AccountProvider, a.AccountRef, a.CostUSD}
			}); err != nil {
			return err
		}
	}
	_, resultErr = conn.ExecContext(ctx, `RELEASE usage_read_materialize`)
	return resultErr
}

// 128 rows keep each statement below SQLite's historical 999-variable limit.
// Reusing a prepared full batch avoids reparsing a large VALUES list per chunk.
func insertProjectionBatches(ctx context.Context, conn *sql.Conn, prefix string, count int, rowAt func(int) [6]any) error {
	const batchRows = 128
	if count == 0 {
		return nil
	}
	var statement *sql.Stmt
	defer func() {
		if statement != nil {
			_ = statement.Close()
		}
	}()
	for offset := 0; offset < count; offset += batchRows {
		rows := min(batchRows, count-offset)
		query := prefix + strings.TrimSuffix(strings.Repeat("(?,?,?,?,?,?),", rows), ",")
		args := make([]any, 0, rows*6)
		for i := offset; i < offset+rows; i++ {
			values := rowAt(i)
			args = append(args, values[:]...)
		}
		if rows == batchRows {
			if statement == nil {
				var err error
				statement, err = conn.PrepareContext(ctx, query)
				if err != nil {
					return err
				}
			}
			if _, err := statement.ExecContext(ctx, args...); err != nil {
				return err
			}
		} else if _, err := conn.ExecContext(ctx, query, args...); err != nil {
			return err
		}
	}
	return nil
}
