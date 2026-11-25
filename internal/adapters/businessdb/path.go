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
	case "app_kv", "account_refs", "account_cli_aliases", "account_state", "cli_account_id_sequences", "model_aliases", "native_account_outcomes", "codex_reset_credits", "codex_reset_operations", "aih_storage_migrations":
		return true
	}
	for _, prefix := range []string{"compat_account_", "model_usage_", "chat_runtime_", "image_studio_", "plugin_", "clipboard_"} {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}
	return false
}
