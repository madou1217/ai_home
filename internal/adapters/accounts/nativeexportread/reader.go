// Package nativeexportread 从 Go 权威库（aih.db）读取公开导出所需的账号记录。
package nativeexportread

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/businessdb"
)

var ErrSource = errors.New("public_export_source_invalid")

// Record 是一次导出记录；Env/NativeAuth 由 canonical 凭据文档拆分而来。
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
	path := filepath.Join(strings.TrimSpace(home), "aih.db")
	if ctx == nil || catalog == nil {
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
	rows, err := tx.QueryContext(ctx, `SELECT a.account_ref, a.provider_id,
    CAST(a.cli_account_id AS TEXT),
    CASE WHEN a.enabled = 1 THEN 'up' ELSE 'down' END,
    COALESCE(c.credential_json, '{}')
    FROM accounts AS a
    LEFT JOIN account_credentials AS c ON c.account_ref = a.account_ref
    ORDER BY a.account_ref`)
	if err != nil {
		return nil, ErrSource
	}
	defer rows.Close()
	totalBytes := 0
	for rows.Next() {
		var row Record
		var credential string
		if err := rows.Scan(&row.AccountRef, &row.Provider, &row.CLIAccountID, &row.Status, &credential); err != nil {
			return nil, ErrSource
		}
		totalBytes += len(credential)
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
		document, err := object(credential)
		if err != nil {
			return nil, ErrSource
		}
		nativeAuth := map[string]any{}
		env := make(map[string]any, len(document))
		for key, value := range document {
			if key == "native_auth_json" || key == "nativeAuth" {
				switch typed := value.(type) {
				case map[string]any:
					nativeAuth = typed
				case string:
					parsed, parseErr := object(typed)
					if parseErr != nil {
						return nil, ErrSource
					}
					nativeAuth = parsed
				}
				continue
			}
			env[key] = value
		}
		row.Env = env
		row.NativeAuth = nativeAuth
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
