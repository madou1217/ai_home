// Package businessdb owns the location and cutover gate of AIH business data.
// Provider-native and Codex history/state/log databases are outside this boundary.
package businessdb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	_ "modernc.org/sqlite"
)

const (
	FileName       = "aih.db"
	LegacyFileName = "app-state.db"
	MigrationID    = "app-state-to-aih-v1"
	ReceiptTable   = "aih_storage_migrations"
	SealTable      = "aih_legacy_seal"
)

var ErrMigrationRequired = errors.New("aih_database_migration_required: run aih-db-unify offline before starting consumers")

func Path(root string) string { return filepath.Join(root, FileName) }

// CheckReady refuses a split store. It never migrates, creates or falls back to
// the legacy database. A retained legacy file must have an atomic cutover seal.
func CheckReady(ctx context.Context, path string) error {
	if filepath.Base(path) == LegacyFileName {
		return ErrMigrationRequired
	}
	if filepath.Base(path) != FileName {
		return nil
	} // Explicit isolated/non-business stores.
	legacy := filepath.Join(filepath.Dir(path), LegacyFileName)
	info, err := os.Lstat(legacy)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("%w: legacy is not a regular file", ErrMigrationRequired)
	}
	receipt, err := readReceipt(ctx, path, ReceiptTable)
	if err != nil || receipt == "" {
		return ErrMigrationRequired
	}
	seal, err := readReceipt(ctx, legacy, SealTable)
	if err != nil || seal != receipt {
		return ErrMigrationRequired
	}
	return nil
}

func readReceipt(ctx context.Context, path, table string) (string, error) {
	u := sqlitefile.URL(path)
	q := u.Query()
	q.Set("mode", "ro")
	q.Add("_pragma", "busy_timeout(5000)")
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return "", err
	}
	defer db.Close()
	var receipt string
	err = db.QueryRowContext(ctx, `SELECT receipt FROM `+table+` WHERE migration_id = ?`, MigrationID).Scan(&receipt)
	return receipt, err
}

// CompatibilityTable separates old native projections from Go's canonical
// credential/quota schema. It does not merge incompatible credential formats.
func CompatibilityTable(name string) string {
	switch name {
	case "account_credentials", "account_quota_detector_state", "account_quota_reset_events", "account_quota_window_samples":
		return "compat_" + name
	default:
		return name
	}
}

// IsCompatibilityTable permits first-install Node configuration before the Go
// account schema initializes. Unknown databases are never adopted as AIH.
func IsCompatibilityTable(name string) bool {
	switch name {
	case "app_kv", "account_refs", "account_cli_aliases", "account_state", "cli_account_id_sequences", "model_aliases", "native_account_outcomes", "codex_reset_credits", "codex_reset_operations", ReceiptTable:
		return true
	}
	for _, prefix := range []string{"compat_account_", "model_usage_", "chat_runtime_", "image_studio_", "plugin_"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}
