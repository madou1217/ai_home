package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"

	"github.com/madou1217/ai_home/internal/adapters/businessdb"
)

// InitializeSchema creates or upgrades the canonical schema without opening a
// runtime account store. Offline preparation must not reconcile CLI aliases,
// delete orphan credentials, or load runtime routing state.
func InitializeSchema(ctx context.Context, options OpenOptions) error {
	store, err := openSchemaStore(ctx, options)
	if err != nil {
		return err
	}
	return store.Close()
}

func openSchemaStore(ctx context.Context, options OpenOptions) (*Store, error) {
	databasePath, err := DatabasePath(options.AIHomeDir)
	if err != nil {
		return nil, err
	}
	if err := businessdb.CheckReady(ctx, databasePath); err != nil {
		return nil, err
	}
	databasePath, err = prepareDatabasePath(options)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", buildDatabaseDSN(databasePath))
	if err != nil {
		return nil, fmt.Errorf("打开账号数据库失败: %w", err)
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	store := &Store{
		db:          db,
		catalog:     options.Catalog,
		credentials: newCredentialRegistry(),
		profiles:    newProfileRegistry(),
	}
	if err := store.initialize(ctx); err != nil {
		return nil, errors.Join(err, db.Close())
	}
	if err := os.Chmod(databasePath, databaseFileMode); err != nil {
		return nil, errors.Join(fmt.Errorf("收紧账号数据库权限失败: %w", err), db.Close())
	}
	return store, nil
}
