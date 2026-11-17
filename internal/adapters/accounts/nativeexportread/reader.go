// Package nativeexportread owns the public export's existing compatibility
// projection. It never merges canonical-only accounts or creates a schema.
package nativeexportread

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/businessdb"
)

var ErrSource = errors.New("public_export_source_invalid")

// Record is the legacy export view, not an inferred canonical credential.
type Record struct {
	Provider     string         `json:"provider"`
	AccountRef   string         `json:"accountRef"`
	CLIAccountID string         `json:"cliAccountId"`
	Status       string         `json:"status"`
	Env          map[string]any `json:"env"`
	NativeAuth   map[string]any `json:"nativeAuth"`
}

// Read uses one read transaction for schema, identity, status and credential
// rows. Errors and malformed objects are not interpreted as an empty export.
func Read(ctx context.Context, home string, catalog *providers.Catalog) ([]Record, error) {
	result := []Record{}
	path, err := appstate.DatabasePath(home)
	if err != nil || ctx == nil || catalog == nil {
		return nil, ErrSource
	}
	if err := businessdb.CheckReady(ctx, path); err != nil {
		return nil, ErrSource
	}
	info, err := os.Stat(path)
	if errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err != nil || !info.Mode().IsRegular() {
		return nil, ErrSource
	}
	db, err := appstate.OpenReadOnly(ctx, path)
	if err != nil {
		return nil, ErrSource
	}
	defer db.Close()
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, ErrSource
	}
	defer tx.Rollback()
	for _, name := range []string{"account_refs", "account_cli_aliases", "account_state", "compat_account_credentials"} {
		var kind string
		if err := tx.QueryRowContext(ctx, "SELECT type FROM sqlite_master WHERE name = ?", name).Scan(&kind); err != nil || kind != "table" {
			return nil, ErrSource
		}
	}
	rows, err := tx.QueryContext(ctx, `SELECT r.account_ref, r.provider,
    COALESCE(CAST(a.cli_account_id AS TEXT), ''), COALESCE(s.status, 'up'),
    COALESCE(c.env_json, '{}'), COALESCE(c.native_auth_json, '{}')
    FROM account_refs r
    LEFT JOIN account_cli_aliases a ON a.account_ref = r.account_ref
    LEFT JOIN account_state s ON s.account_ref = r.account_ref
    LEFT JOIN compat_account_credentials c ON c.account_ref = r.account_ref
    ORDER BY r.account_ref`)
	if err != nil {
		return nil, ErrSource
	}
	defer rows.Close()
	totalBytes := 0
	for rows.Next() {
		var row Record
		var env, auth string
		if err := rows.Scan(&row.AccountRef, &row.Provider, &row.CLIAccountID, &row.Status, &env, &auth); err != nil {
			return nil, ErrSource
		}
		totalBytes += len(env) + len(auth)
		if totalBytes > 64*1024*1024 {
			return nil, ErrSource
		}
		if _, err := accountcore.ParseAccountRef(row.AccountRef); err != nil {
			return nil, ErrSource
		}
		if !catalog.Contains(row.Provider) || row.Provider != strings.ToLower(strings.TrimSpace(row.Provider)) {
			return nil, ErrSource
		}
		if row.CLIAccountID != "" && !digits(row.CLIAccountID) {
			return nil, ErrSource
		}
		if row.Status != "down" {
			row.Status = "up"
		}
		row.Env, err = object(env)
		if err != nil {
			return nil, ErrSource
		}
		row.NativeAuth, err = object(auth)
		if err != nil {
			return nil, ErrSource
		}
		result = append(result, row)
	}
	if rows.Err() != nil {
		return nil, ErrSource
	}
	if err := rows.Close(); err != nil {
		return nil, ErrSource
	}
	if err := tx.Commit(); err != nil {
		return nil, ErrSource
	}
	return result, nil
}

func object(text string) (map[string]any, error) {
	value := map[string]any{}
	decoder := json.NewDecoder(bytes.NewBufferString(text))
	if err := decoder.Decode(&value); err != nil {
		return nil, ErrSource
	}
	if decoder.Decode(new(any)) != io.EOF {
		return nil, ErrSource
	}
	if value == nil {
		return nil, ErrSource
	}
	return value, nil
}

func digits(value string) bool {
	if value == "" {
		return false
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}
