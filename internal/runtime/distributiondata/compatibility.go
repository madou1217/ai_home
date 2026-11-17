package distributiondata

import (
	"context"
	"errors"
	"fmt"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// ensureCompatibilitySchema only receives a private scratch database after its
// canonical initialization and any dbunify cutover. OpenWritable does not create
// app_kv: its existing WriteKV/DeleteKV/UpdateKV adapters lazily use this exact
// DDL. Ensure just the schema, without inserting/deleting a placeholder key or
// replacing configuration. Other compatibility tables stay with their owners.
func ensureCompatibilitySchema(ctx context.Context, path string) (resultErr error) {
	db, err := appstate.OpenWritable(ctx, path)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, db.Close()) }()
	_, err = db.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)")
	if err != nil {
		return fmt.Errorf("distributiondata: ensure private compatibility schema: %w", err)
	}
	return nil
}
