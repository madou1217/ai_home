package sqliteaccount

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// BackupCompatibilityRecord is a projection of canonical readback, never an
// identity import. Versions bind the payload to the snapshot that produced it.
// Callers compose it from the canonical exporter, not the original backup wire.
type BackupCompatibilityRecord struct {
	AccountRef, Provider, CLIAccountID    string
	CredentialUpdatedAt, ProfileUpdatedAt int64
	EnvJSON, NativeAuthJSON               json.RawMessage
}

var errBackupProjection = errors.New("backup_core_projection_rejected")

// ProjectBackupCompatibility writes the retained four-table compatibility view
// in one transaction. It never changes canonical accounts, profiles or routing.
// A failed commit can have an unknown outcome; callers must not retry blindly.
func (store *Store) ProjectBackupCompatibility(ctx context.Context, records []BackupCompatibilityRecord) (int, error) {
	if store == nil || store.db == nil || len(records) > 5000 {
		return 0, errBackupProjection
	}
	if len(records) == 0 {
		return 0, ctx.Err()
	}
	connection, err := store.db.Conn(ctx)
	if err != nil {
		return 0, err
	}
	defer connection.Close()
	if _, err = connection.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return 0, err
	}
	defer connection.ExecContext(context.WithoutCancel(ctx), "ROLLBACK")
	if err = ensureBackupProjectionSchema(ctx, connection); err != nil {
		return 0, err
	}
	now := time.Now().UnixMilli()
	seen := make(map[string]BackupCompatibilityRecord, len(records))
	for _, record := range records {
		if _, err = accountcore.ParseAccountRef(record.AccountRef); err != nil {
			return 0, errBackupProjection
		}
		if previous, exists := seen[record.AccountRef]; exists {
			if previous.Provider != record.Provider || previous.CLIAccountID != record.CLIAccountID || previous.CredentialUpdatedAt != record.CredentialUpdatedAt || previous.ProfileUpdatedAt != record.ProfileUpdatedAt || !bytes.Equal(previous.EnvJSON, record.EnvJSON) || !bytes.Equal(previous.NativeAuthJSON, record.NativeAuthJSON) {
				return 0, errBackupProjection
			}
		}
		seen[record.AccountRef] = record
		alias, parseErr := strconv.ParseInt(record.CLIAccountID, 10, 64)
		if parseErr != nil || alias <= 0 || record.CLIAccountID != strconv.FormatInt(alias, 10) || record.CredentialUpdatedAt <= 0 {
			return 0, errBackupProjection
		}
		var env map[string]string
		var native map[string]any
		if json.Unmarshal(record.EnvJSON, &env) != nil || env == nil || json.Unmarshal(record.NativeAuthJSON, &native) != nil || native == nil {
			return 0, errBackupProjection
		}
		var provider string
		var actualAlias, credentialVersion int64
		var enabled bool
		err = connection.QueryRowContext(ctx, `SELECT a.provider_id,a.cli_account_id,a.enabled,c.updated_at_ms
			FROM accounts a JOIN account_credentials c ON c.account_ref=a.account_ref WHERE a.account_ref=?`, record.AccountRef).
			Scan(&provider, &actualAlias, &enabled, &credentialVersion)
		if err != nil || provider != record.Provider || actualAlias != alias || credentialVersion != record.CredentialUpdatedAt {
			return 0, errBackupProjection
		}
		// Preserve the original meaningful-version contract: current exporter
		// supplies a profile version only for profile-derived portable auth.
		if record.ProfileUpdatedAt > 0 {
			var profileVersion int64
			err = connection.QueryRowContext(ctx, "SELECT updated_at_ms FROM account_profiles WHERE account_ref=?", record.AccountRef).Scan(&profileVersion)
			if err != nil || profileVersion != record.ProfileUpdatedAt {
				return 0, errBackupProjection
			}
		}
		var existingProvider, occupiedRef string
		err = connection.QueryRowContext(ctx, "SELECT provider FROM account_refs WHERE account_ref=?", record.AccountRef).Scan(&existingProvider)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return 0, err
		}
		if err == nil && existingProvider != record.Provider {
			return 0, errBackupProjection
		}
		err = connection.QueryRowContext(ctx, "SELECT account_ref FROM account_cli_aliases WHERE provider=? AND cli_account_id=?", record.Provider, record.CLIAccountID).Scan(&occupiedRef)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return 0, err
		}
		if err == nil && occupiedRef != record.AccountRef {
			return 0, errBackupProjection
		}

		queries := []struct {
			sql  string
			args []any
		}{
			{`INSERT INTO account_refs(account_ref,provider,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(account_ref) DO UPDATE SET updated_at=excluded.updated_at`, []any{record.AccountRef, record.Provider, now, now}},
			{`INSERT INTO account_cli_aliases(account_ref,provider,cli_account_id,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(account_ref) DO UPDATE SET cli_account_id=excluded.cli_account_id,updated_at=excluded.updated_at`, []any{record.AccountRef, record.Provider, record.CLIAccountID, now, now}},
			{`INSERT INTO compat_account_credentials(account_ref,env_json,native_auth_json,env_updated_at,native_auth_updated_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(account_ref) DO UPDATE SET env_json=excluded.env_json,native_auth_json=excluded.native_auth_json,env_updated_at=excluded.env_updated_at,native_auth_updated_at=excluded.native_auth_updated_at,updated_at=excluded.updated_at`, []any{record.AccountRef, string(record.EnvJSON), string(record.NativeAuthJSON), now, now, now}},
			{`INSERT INTO account_state(account_ref,provider,status,configured,api_key_mode,updated_at) VALUES(?,?,?,1,?,?) ON CONFLICT(account_ref) DO UPDATE SET status=excluded.status,configured=1,api_key_mode=excluded.api_key_mode,updated_at=excluded.updated_at`, []any{record.AccountRef, record.Provider, map[bool]string{true: "up", false: "down"}[enabled], len(native) == 0, now}},
		}
		for _, query := range queries {
			if _, err = connection.ExecContext(ctx, query.sql, query.args...); err != nil {
				return 0, err
			}
		}
	}
	if ctx.Err() != nil {
		return 0, ctx.Err()
	}
	if _, err = connection.ExecContext(ctx, "COMMIT"); err != nil {
		return 0, err
	}
	return len(records), nil
}

type backupProjectionColumn struct {
	name, kind       string
	notNull, primary int
	defaultValue     *string
}

type backupProjectionTable struct {
	name, sql string
	columns   []backupProjectionColumn
	indexes   []string
}

func backupDefault(value string) *string { return &value }

// These are the existing Node compatibility schemas. Existing incompatible
// tables are rejected, never rebuilt or truncated to make projection succeed.
func backupProjectionTables() []backupProjectionTable {
	return []backupProjectionTable{
		{"account_refs", `CREATE TABLE account_refs(account_ref TEXT PRIMARY KEY,provider TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)`, []backupProjectionColumn{
			{"account_ref", "TEXT", 0, 1, nil}, {"provider", "TEXT", 1, 0, nil}, {"created_at", "INTEGER", 1, 0, nil}, {"updated_at", "INTEGER", 1, 0, nil},
		}, []string{`CREATE INDEX IF NOT EXISTS idx_account_refs_provider ON account_refs(provider,updated_at)`}},
		{"account_cli_aliases", `CREATE TABLE account_cli_aliases(account_ref TEXT PRIMARY KEY,provider TEXT NOT NULL,cli_account_id TEXT NOT NULL CHECK(cli_account_id<>'' AND cli_account_id NOT GLOB '*[^0-9]*'),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(provider,cli_account_id),FOREIGN KEY(account_ref) REFERENCES account_refs(account_ref) ON DELETE CASCADE)`, []backupProjectionColumn{
			{"account_ref", "TEXT", 0, 1, nil}, {"provider", "TEXT", 1, 0, nil}, {"cli_account_id", "TEXT", 1, 0, nil}, {"created_at", "INTEGER", 1, 0, nil}, {"updated_at", "INTEGER", 1, 0, nil},
		}, []string{`CREATE INDEX IF NOT EXISTS idx_account_cli_aliases_provider_id ON account_cli_aliases(provider,cli_account_id,updated_at)`}},
		{"compat_account_credentials", `CREATE TABLE compat_account_credentials(account_ref TEXT PRIMARY KEY,env_json TEXT NOT NULL DEFAULT '{}',native_auth_json TEXT NOT NULL DEFAULT '{}',env_updated_at INTEGER NOT NULL DEFAULT 0,native_auth_updated_at INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,FOREIGN KEY(account_ref) REFERENCES account_refs(account_ref) ON DELETE CASCADE)`, []backupProjectionColumn{
			{"account_ref", "TEXT", 0, 1, nil}, {"env_json", "TEXT", 1, 0, backupDefault("'{}'")}, {"native_auth_json", "TEXT", 1, 0, backupDefault("'{}'")}, {"env_updated_at", "INTEGER", 1, 0, backupDefault("0")}, {"native_auth_updated_at", "INTEGER", 1, 0, backupDefault("0")}, {"updated_at", "INTEGER", 1, 0, nil},
		}, nil},
		{"account_state", `CREATE TABLE account_state(account_ref TEXT PRIMARY KEY,provider TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'up',configured INTEGER NOT NULL DEFAULT 0,api_key_mode INTEGER NOT NULL DEFAULT 0,auth_mode TEXT,runtime_state TEXT,remaining_pct REAL,display_name TEXT,updated_at INTEGER NOT NULL,FOREIGN KEY(account_ref) REFERENCES account_refs(account_ref) ON DELETE CASCADE)`, []backupProjectionColumn{
			{"account_ref", "TEXT", 0, 1, nil}, {"provider", "TEXT", 1, 0, nil}, {"status", "TEXT", 1, 0, backupDefault("'up'")}, {"configured", "INTEGER", 1, 0, backupDefault("0")}, {"api_key_mode", "INTEGER", 1, 0, backupDefault("0")}, {"auth_mode", "TEXT", 0, 0, nil}, {"runtime_state", "TEXT", 0, 0, nil}, {"remaining_pct", "REAL", 0, 0, nil}, {"display_name", "TEXT", 0, 0, nil}, {"updated_at", "INTEGER", 1, 0, nil},
		}, []string{`CREATE INDEX IF NOT EXISTS idx_account_state_provider_active ON account_state(provider,configured,api_key_mode,remaining_pct,account_ref)`, `CREATE INDEX IF NOT EXISTS idx_account_state_provider_updated ON account_state(provider,updated_at,account_ref)`}},
	}
}

func ensureBackupProjectionSchema(ctx context.Context, conn *sql.Conn) error {
	for _, table := range backupProjectionTables() {
		var kind, sourceSQL string
		err := conn.QueryRowContext(ctx, "SELECT type,sql FROM sqlite_master WHERE name=?", table.name).Scan(&kind, &sourceSQL)
		if errors.Is(err, sql.ErrNoRows) {
			if _, err = conn.ExecContext(ctx, table.sql); err != nil {
				return err
			}
		} else if err != nil {
			return err
		} else if kind != "table" {
			return errBackupProjection
		}
		if sourceSQL == "" {
			sourceSQL = table.sql
		}
		expectedDDL, expectedErr := normalizeBackupDDL(table.sql)
		actualDDL, actualErr := normalizeBackupDDL(sourceSQL)
		if expectedErr != nil || actualErr != nil || actualDDL != expectedDDL {
			return errBackupProjection
		}
		if err = backupProjectionUniqueIndexes(ctx, conn, table.name); err != nil {
			return err
		}
		rows, err := conn.QueryContext(ctx, "PRAGMA table_info("+table.name+")")
		if err != nil {
			return err
		}
		index := 0
		valid := true
		for rows.Next() {
			var cid, required, pk int
			var name, dataType string
			var defaultValue sql.NullString
			if err = rows.Scan(&cid, &name, &dataType, &required, &defaultValue, &pk); err != nil {
				rows.Close()
				return err
			}
			if index >= len(table.columns) {
				valid = false
				continue
			}
			expected := table.columns[index]
			if cid != index || name != expected.name || !strings.EqualFold(dataType, expected.kind) || required != expected.notNull || pk != expected.primary || defaultValue.Valid != (expected.defaultValue != nil) || defaultValue.Valid && defaultValue.String != *expected.defaultValue {
				valid = false
			}
			index++
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if !valid || index != len(table.columns) {
			return errBackupProjection
		}
		var triggers int
		if err = conn.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='trigger' AND tbl_name=?", table.name).Scan(&triggers); err != nil {
			return err
		}
		if triggers != 0 {
			return errBackupProjection
		}
		if err = backupProjectionForeignKeys(ctx, conn, table.name); err != nil {
			return err
		}

		for _, indexSQL := range table.indexes {
			if _, err = conn.ExecContext(ctx, indexSQL); err != nil {
				return err
			}
			expected, normErr := normalizeBackupDDL(indexSQL)
			if normErr != nil {
				return normErr
			}
			// The known index name follows CREATE INDEX IF NOT EXISTS.
			name := strings.Fields(indexSQL)[5]
			var actualSQL string
			if err = conn.QueryRowContext(ctx, "SELECT sql FROM sqlite_master WHERE type='index' AND name=? AND tbl_name=?", name, table.name).Scan(&actualSQL); err != nil {
				return err
			}
			actual, normErr := normalizeBackupDDL(actualSQL)
			if normErr != nil || actual != expected {
				return errBackupProjection
			}
		}
	}
	return nil
}

func backupProjectionForeignKeys(ctx context.Context, conn *sql.Conn, table string) error {
	rows, err := conn.QueryContext(ctx, "PRAGMA foreign_key_list("+table+")")
	if err != nil {
		return err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var id, seq int
		var target, from, to, update, remove, match string
		if err = rows.Scan(&id, &seq, &target, &from, &to, &update, &remove, &match); err != nil {
			return err
		}
		count++
		if id != 0 || seq != 0 || target != "account_refs" || from != "account_ref" || to != "account_ref" || remove != "CASCADE" || update != "NO ACTION" {
			return errBackupProjection
		}
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if table == "account_refs" && count != 0 || table != "account_refs" && count != 1 {
		return errBackupProjection
	}
	return nil
}

// Normalize only insignificant SQL spelling for a closed DDL allowlist. String
// literals are preserved byte-for-byte; comments, extra constraints, conflict
// policies, generated columns and suffixes cannot normalize into an allowed DDL.
func normalizeBackupDDL(input string) (string, error) {
	runes := []rune(strings.TrimSpace(input))
	var out strings.Builder
	for index := 0; index < len(runes); index++ {
		current := runes[index]
		if unicode.IsSpace(current) {
			continue
		}
		if current == '\'' {
			out.WriteRune(current)
			closed := false
			for index++; index < len(runes); index++ {
				value := runes[index]
				out.WriteRune(value)
				if value == '\'' {
					if index+1 < len(runes) && runes[index+1] == '\'' {
						index++
						out.WriteRune(runes[index])
						continue
					}
					closed = true
					break
				}
			}
			if !closed {
				return "", errBackupProjection
			}
			continue
		}
		if current == '"' || current == '`' || current == '[' {
			end := current
			if current == '[' {
				end = ']'
			}
			begin := index + 1
			for index++; index < len(runes) && runes[index] != end; index++ {
				value := runes[index]
				if !(value >= 'a' && value <= 'z' || value >= 'A' && value <= 'Z' || value >= '0' && value <= '9' || value == '_') {
					return "", errBackupProjection
				}
				out.WriteRune(unicode.ToLower(value))
			}
			if index >= len(runes) || index == begin {
				return "", errBackupProjection
			}
			continue
		}
		out.WriteRune(unicode.ToLower(current))
	}
	value := strings.TrimSuffix(out.String(), ";")
	value = strings.Replace(value, "createtableifnotexists", "createtable", 1)
	value = strings.Replace(value, "createindexifnotexists", "createindex", 1)
	return value, nil
}

func backupProjectionUniqueIndexes(ctx context.Context, conn *sql.Conn, table string) error {
	rows, err := conn.QueryContext(ctx, "PRAGMA index_list("+table+")")
	if err != nil {
		return err
	}
	type index struct {
		name, origin string
		partial      int
	}
	var indexes []index
	for rows.Next() {
		var seq, unique, partial int
		var name, origin string
		if err = rows.Scan(&seq, &name, &unique, &origin, &partial); err != nil {
			rows.Close()
			return err
		}
		if unique == 1 {
			indexes = append(indexes, index{name, origin, partial})
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	pkFound, aliasFound := false, false
	for _, entry := range indexes {
		if entry.partial != 0 {
			return errBackupProjection
		}
		query := "PRAGMA index_info(" + fmt.Sprintf("'%s'", strings.ReplaceAll(entry.name, "'", "''")) + ")"
		columns, readErr := conn.QueryContext(ctx, query)
		if readErr != nil {
			return readErr
		}
		var names []string
		for columns.Next() {
			var seq, cid int
			var name sql.NullString
			if err = columns.Scan(&seq, &cid, &name); err != nil {
				columns.Close()
				return err
			}
			names = append(names, name.String)
		}
		err = columns.Err()
		columns.Close()
		if err != nil {
			return err
		}
		if entry.origin == "pk" && len(names) == 1 && names[0] == "account_ref" && !pkFound {
			pkFound = true
			continue
		}
		if table == "account_cli_aliases" && entry.origin == "u" && len(names) == 2 && names[0] == "provider" && names[1] == "cli_account_id" && !aliasFound {
			aliasFound = true
			continue
		}
		return errBackupProjection
	}
	if !pkFound || table == "account_cli_aliases" && !aliasFound {
		return errBackupProjection
	}
	return nil
}
