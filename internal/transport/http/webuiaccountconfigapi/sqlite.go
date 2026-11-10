package webuiaccountconfigapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// dumpKeyValueSQLite 把一份 SQLite 里所有 key/value 形态的表导出为 {table: {key: value}}；
// 其它表只给行数。只读打开，不修改源文件。与 Node dumpKeyValueSqlite 同口径。
func dumpKeyValueSQLite(databasePath string) (any, error) {
	ctx := context.Background()
	db, err := appstate.OpenReadOnly(ctx, databasePath)
	if err != nil {
		return nil, err
	}
	defer func() { _ = db.Close() }()

	tables, err := listSQLiteTables(ctx, db)
	if err != nil {
		return nil, err
	}
	output := make(map[string]any, len(tables))
	for _, table := range tables {
		columns, err := listTableColumns(ctx, db, table)
		if err != nil {
			return nil, err
		}
		count, err := countTableRows(ctx, db, table)
		if err != nil {
			return nil, err
		}
		hasKey := containsString(columns, "key")
		hasValue := containsString(columns, "value")
		if !hasKey || !hasValue {
			output[table] = map[string]any{"<rows>": count}
			continue
		}
		entries, err := dumpTableEntries(ctx, db, table)
		if err != nil {
			return nil, err
		}
		output[table] = entries
	}
	return output, nil
}

func listSQLiteTables(ctx context.Context, db *sql.DB) ([]string, error) {
	rows, err := db.QueryContext(ctx, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	tables := make([]string, 0, 8)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		if name == "" || strings.HasPrefix(name, "sqlite_") {
			continue
		}
		tables = append(tables, name)
	}
	return tables, rows.Err()
}

func listTableColumns(ctx context.Context, db *sql.DB, table string) ([]string, error) {
	rows, err := db.QueryContext(ctx, "PRAGMA table_info("+quoteIdentifier(table)+")")
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	columns := make([]string, 0, 8)
	for rows.Next() {
		var (
			cid        int64
			name       string
			columnType string
			notNull    int64
			defaultVal any
			primaryKey int64
		)
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultVal, &primaryKey); err != nil {
			return nil, err
		}
		columns = append(columns, name)
	}
	return columns, rows.Err()
}

func countTableRows(ctx context.Context, db *sql.DB, table string) (int64, error) {
	var count int64
	err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM "+quoteIdentifier(table)).Scan(&count)
	return count, err
}

func dumpTableEntries(ctx context.Context, db *sql.DB, table string) (map[string]any, error) {
	query := "SELECT key, value FROM " + quoteIdentifier(table) + fmt.Sprintf(" LIMIT %d", sqliteRowsLimit)
	rows, err := db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	entries := make(map[string]any, 8)
	for rows.Next() {
		var key any
		var value any
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		entries[sqliteKeyString(key)] = parseMaybeJSON(value)
	}
	return entries, rows.Err()
}

func sqliteKeyString(value any) string {
	if value == nil {
		return "null"
	}
	switch typed := value.(type) {
	case []byte:
		return string(typed)
	case string:
		return typed
	default:
		return fmt.Sprint(value)
	}
}

// parseMaybeJSON 复刻 Node：字符串/BLOB 若以 [ { " 开头就尝试 JSON 解析，失败保留原值。
func parseMaybeJSON(value any) any {
	switch typed := value.(type) {
	case []byte:
		return parseJSONString(string(typed))
	case string:
		return parseJSONString(typed)
	default:
		return value
	}
}

func parseJSONString(value string) any {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return value
	}
	if trimmed[0] != '[' && trimmed[0] != '{' && trimmed[0] != '"' {
		return value
	}
	var parsed any
	if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil {
		return value
	}
	return parsed
}

func quoteIdentifier(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

func containsString(list []string, target string) bool {
	for _, item := range list {
		if item == target {
			return true
		}
	}
	return false
}

// decodeSQLiteBase64 解码 nativeAuth.database，写入临时文件后导出；错误以
// {"<error>": "..."} 形式返回（与 Node 一致）。
func decodeSQLiteBase64(encoded string) any {
	decoded := decodeBase64Lenient(encoded)
	if len(decoded) == 0 {
		return nil
	}
	if len(decoded) > maxSQLiteBytes {
		return map[string]any{"<error>": "数据库过大（" + formatInt(len(decoded)) + " 字节），未解码"}
	}
	directory, err := os.MkdirTemp("", "aih-account-config-")
	if err != nil {
		return map[string]any{"<error>": "数据库解码失败：" + err.Error()}
	}
	defer func() { _ = os.RemoveAll(directory) }()
	file := directory + string(os.PathSeparator) + "view.sqlite3"
	if err := os.WriteFile(file, decoded, 0o600); err != nil {
		return map[string]any{"<error>": "数据库解码失败：" + err.Error()}
	}
	dumped, err := dumpKeyValueSQLite(file)
	if err != nil {
		return map[string]any{"<error>": "数据库解码失败：" + err.Error()}
	}
	return dumped
}
