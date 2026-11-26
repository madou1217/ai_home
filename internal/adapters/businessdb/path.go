// Package businessdb owns the location of AIH business data.
// Provider-native and Codex history/state/log databases are outside this boundary.
package businessdb

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
)

const FileName = "aih.db"

// Path returns the single canonical business database path.
func Path(root string) string { return filepath.Join(root, FileName) }

// CheckReady accepts the canonical business database. AIH has exactly one
// business database; there is no legacy database to migrate, gate or fall back to.
func CheckReady(ctx context.Context, path string) error {
	if ctx == nil || strings.TrimSpace(path) == "" {
		return errors.New("aih_database_path_required")
	}
	return nil
}

// IsCompatibilityTable permits first-install Node configuration before the Go
// account schema initializes. Unknown databases are never adopted as AIH.
func IsCompatibilityTable(name string) bool {
	switch name {
	case "app_kv", "cli_account_id_sequences", "model_aliases", "codex_reset_credits", "codex_reset_operations", "aih_storage_migrations":
		return true
	}
	for _, prefix := range []string{"model_usage_", "chat_runtime_", "image_studio_", "plugin_", "clipboard_"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}
