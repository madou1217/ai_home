package sessionread

import (
	"context"
	"database/sql"
	"errors"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

func openReadOnlySQLite(ctx context.Context, dbPath string) (*sql.DB, bool, error) {
	cleaned := strings.TrimSpace(dbPath)
	if cleaned == "" {
		return nil, false, nil
	}
	info, err := os.Stat(cleaned)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, false, nil
		}
		return nil, false, err
	}
	if !info.Mode().IsRegular() {
		return nil, false, nil
	}

	dsn := buildReadOnlySQLiteDSN(cleaned)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, false, err
	}
	db.SetMaxOpenConns(4)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, false, err
	}
	return db, true, nil
}

func buildReadOnlySQLiteDSN(dbPath string) string {
	fileURL := sqlitefile.URL(filepath.Clean(dbPath))
	query := url.Values{}
	query.Set("mode", "ro")
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "query_only(1)")
	fileURL.RawQuery = query.Encode()
	return fileURL.String()
}

func sqliteTableExists(ctx context.Context, db *sql.DB, tableName string) bool {
	if db == nil || strings.TrimSpace(tableName) == "" {
		return false
	}
	var marker int
	err := db.QueryRowContext(
		ctx,
		`SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ? LIMIT 1`,
		tableName,
	).Scan(&marker)
	return err == nil && marker == 1
}

func getSQLiteTableColumns(ctx context.Context, db *sql.DB, tableName string) map[string]bool {
	cols := make(map[string]bool)
	if db == nil || !isSafeSQLiteIdent(tableName) {
		return cols
	}
	rows, err := db.QueryContext(ctx, "PRAGMA table_info("+tableName+")")
	if err != nil {
		return cols
	}
	defer rows.Close()

	for rows.Next() {
		var cid int
		var name, colType string
		var notNull int
		var dflt sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &colType, &notNull, &dflt, &pk); err != nil {
			continue
		}
		if trimmed := strings.TrimSpace(name); trimmed != "" {
			cols[trimmed] = true
		}
	}
	return cols
}

func isSafeSQLiteIdent(name string) bool {
	if name == "" {
		return false
	}
	for i := 0; i < len(name); i++ {
		c := name[i]
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_') {
			return false
		}
	}
	return true
}

func isNoSuchTableErr(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(strings.ToLower(err.Error()), "no such table")
}
