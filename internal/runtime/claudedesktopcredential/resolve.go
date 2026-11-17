// Package claudedesktopcredential owns the read-only canonical credential
// contract used by Claude Desktop. It never creates a store, changes Desktop
// configuration, starts a server or falls back to Node or environment secrets.
package claudedesktopcredential

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/businessdb"
	"github.com/madou1217/ai_home/internal/runtime/jsondocument"
)

const Command = "__claude-desktop-credential"

// Credential is the complete helper stdout contract; no management secret or
// configuration metadata may be added to this output.
type Credential struct {
	Token string `json:"token"`
}

// Resolve reads only config:server.apiKey from the canonical business database.
// appstate.ReadKV enforces mode=ro, query_only and the businessdb cutover gate.
// Public errors deliberately exclude database contents and driver diagnostics.
func Resolve(ctx context.Context, aiHomeDir string) (Credential, error) {
	failure := func(code string) (Credential, error) {
		return Credential{}, errors.New(code)
	}
	if ctx == nil || ctx.Err() != nil {
		return failure("desktop_credential_cancelled")
	}
	root := strings.TrimSpace(aiHomeDir)
	if !filepath.IsAbs(root) || strings.ContainsRune(root, 0) {
		return failure("desktop_credential_scope_invalid")
	}
	database, err := appstate.DatabasePath(root)
	if err != nil {
		return failure("desktop_credential_scope_invalid")
	}
	info, err := os.Stat(database)
	if errors.Is(err, os.ErrNotExist) {
		return failure("desktop_credential_store_missing")
	}
	if err != nil || !info.Mode().IsRegular() {
		return failure("desktop_credential_store_unavailable")
	}
	raw, found, err := appstate.ReadKV(ctx, database, "config:server")
	if err != nil {
		if errors.Is(err, businessdb.ErrMigrationRequired) {
			return failure("desktop_credential_migration_required")
		}
		return failure("desktop_credential_store_unavailable")
	}
	if !found {
		return failure("desktop_credential_config_missing")
	}
	if len(raw) > 2*1024*1024 {
		return failure("desktop_credential_config_invalid")
	}
	config, err := jsondocument.Object([]byte(raw))
	if err != nil {
		return failure("desktop_credential_config_invalid")
	}
	value, exists := config["apiKey"]
	if !exists || value == nil {
		return failure("desktop_credential_key_missing")
	}
	token, ok := value.(string)
	if !ok {
		return failure("desktop_credential_config_invalid")
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return failure("desktop_credential_key_missing")
	}
	if len(token) > 64*1024 || strings.ContainsAny(token, "\x00\r\n") {
		return failure("desktop_credential_config_invalid")
	}
	if ctx.Err() != nil {
		return failure("desktop_credential_cancelled")
	}
	return Credential{Token: token}, nil
}
