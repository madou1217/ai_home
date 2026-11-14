package webuiprojectsapi

import (
	"context"
	"database/sql"
	"fmt"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	"os"
	"strconv"
	"strings"

	_ "modernc.org/sqlite"
)

// sqliteBusyTimeoutMS 是只读连接等待写锁的上限；超时后按「读不到」处理。
const sqliteBusyTimeoutMS = 2000

// buildReadOnlySQLiteDSN 生成只读 DSN：mode=ro + query_only，防止扫描过程改写
// Provider 的原生数据库。
func buildReadOnlySQLiteDSN(databasePath string) string {
	fileURL := sqlitefile.URL(databasePath)
	query := fileURL.Query()
	query.Set("mode", "ro")
	query.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", sqliteBusyTimeoutMS))
	query.Add("_pragma", "query_only(1)")
	fileURL.RawQuery = query.Encode()
	return fileURL.String()
}

// openReadOnlySQLite 打开一个存在的只读数据库；文件不存在或打不开时 ok=false。
//
// 不能用 os.ErrNotExist 判 sqlite 的打开错误：驱动对「文件不存在」报的是
// "unable to open database file: out of memory (14)"，不是 fs.ErrNotExist。
func openReadOnlySQLite(ctx context.Context, databasePath string) (*sql.DB, bool) {
	if _, err := os.Stat(databasePath); err != nil {
		return nil, false
	}
	database, err := sql.Open("sqlite", buildReadOnlySQLiteDSN(databasePath))
	if err != nil {
		return nil, false
	}
	database.SetMaxOpenConns(1)
	database.SetMaxIdleConns(1)
	if err := database.PingContext(ctx); err != nil {
		_ = database.Close()
		return nil, false
	}
	return database, true
}

// sqliteTableColumns 返回表的列名集合；表不存在或探测失败时 ok=false。
func sqliteTableColumns(ctx context.Context, database *sql.DB, tableName string) (map[string]bool, bool) {
	rows, err := database.QueryContext(ctx, "PRAGMA table_info("+quoteSQLiteIdentifier(tableName)+")")
	if err != nil {
		return nil, false
	}
	defer func() { _ = rows.Close() }()
	columns := make(map[string]bool, 16)
	for rows.Next() {
		var (
			position   int64
			name       string
			columnType string
			notNull    int64
			defaultVal any
			primaryKey int64
		)
		if rows.Scan(&position, &name, &columnType, &notNull, &defaultVal, &primaryKey) != nil {
			continue
		}
		columns[name] = true
	}
	if rows.Err() != nil {
		return nil, false
	}
	return columns, true
}

// quoteSQLiteIdentifier 给表名加双引号；表名只来自本包的固定常量。
func quoteSQLiteIdentifier(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

// sqliteValueString 把驱动返回的 NULL / 文本 / 字节切片统一成字符串。
func sqliteValueString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case []byte:
		return string(typed)
	default:
		return fmt.Sprintf("%v", typed)
	}
}

// sqliteValueInt64 把驱动返回的整数 / 浮点 / 数字文本统一成 int64。
func sqliteValueInt64(value any) int64 {
	switch typed := value.(type) {
	case nil:
		return 0
	case int64:
		return typed
	case float64:
		return int64(typed)
	case []byte:
		return sqliteValueInt64(string(typed))
	case string:
		text := strings.TrimSpace(typed)
		if text == "" {
			return 0
		}
		numeric, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return 0
		}
		return int64(numeric)
	default:
		return 0
	}
}
