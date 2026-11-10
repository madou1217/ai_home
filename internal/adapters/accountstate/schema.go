package accountstate

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// TableName 是 Node 的账号展示投影表名。
const TableName = "account_state"

// SchemaDDL 与 lib/account/state-index.js 的 createAccountStateTable 逐字一致。
//
// 列顺序也是合同的一部分：Node 的 ensureExactTableSchema 按顺序比对列名，
// 顺序不同即视为不兼容。runtime_state 是 Node 迁移期兜底列，Go 只读不写。
const SchemaDDL = `CREATE TABLE IF NOT EXISTS account_state (
      account_ref TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'up',
      configured INTEGER NOT NULL DEFAULT 0,
      api_key_mode INTEGER NOT NULL DEFAULT 0,
      auth_mode TEXT,
      runtime_state TEXT,
      remaining_pct REAL,
      display_name TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(account_ref) REFERENCES account_refs(account_ref) ON DELETE CASCADE
    )`

const indexActiveDDL = `CREATE INDEX IF NOT EXISTS idx_account_state_provider_active
      ON account_state(provider, configured, api_key_mode, remaining_pct, account_ref)`

const indexUpdatedDDL = `CREATE INDEX IF NOT EXISTS idx_account_state_provider_updated
      ON account_state(provider, updated_at, account_ref)`

// expectedColumns 是 Node ACCOUNT_STATE_COLUMNS 的副本，顺序敏感。
var expectedColumns = []string{
	"account_ref",
	"provider",
	"status",
	"configured",
	"api_key_mode",
	"auth_mode",
	"runtime_state",
	"remaining_pct",
	"display_name",
	"updated_at",
}

// ExpectedColumns 返回 Node account_state 的列合同副本。
func ExpectedColumns() []string {
	return append([]string(nil), expectedColumns...)
}

// EnsureSchema 在显式要求时创建 account_state 与其索引，DDL 与 Node 完全一致。
//
// 生产路径不调用它：表归 Node 所有，Open/OpenDatabase 只做校验。它用于测试与
// 「Go 单独拉起空数据根」的显式初始化；调用前 account_refs 台账必须已存在。
func EnsureSchema(ctx context.Context, db *sql.DB) error {
	if db == nil {
		return ErrInvalidDatabase
	}
	for _, statement := range []string{SchemaDDL, indexActiveDDL, indexUpdatedDDL} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("初始化 account_state 表失败: %w", err)
		}
	}
	return nil
}

// validateSchema 复刻 Node ensureExactTableSchema：列按顺序完全一致且主键为
// account_ref。表不存在也算结构无效——本包不会替 Node 建表。
func (store *Store) validateSchema(ctx context.Context) error {
	rows, err := store.db.QueryContext(ctx, "PRAGMA table_info("+TableName+")")
	if err != nil {
		return fmt.Errorf("读取 account_state 表结构失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()
	columns := make([]string, 0, len(expectedColumns))
	primaryKey := make([]string, 0, 1)
	for rows.Next() {
		var (
			position   int64
			name       string
			columnType string
			notNull    int64
			defaultVal any
			pkOrder    int64
		)
		if err := rows.Scan(&position, &name, &columnType, &notNull, &defaultVal, &pkOrder); err != nil {
			return fmt.Errorf("读取 account_state 列定义失败: %w", err)
		}
		columns = append(columns, name)
		if pkOrder > 0 {
			primaryKey = append(primaryKey, name)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("遍历 account_state 列定义失败: %w", err)
	}
	if len(columns) == 0 {
		return fmt.Errorf("%w: 表不存在", ErrSchemaInvalid)
	}
	if !sameStrings(columns, expectedColumns) {
		return fmt.Errorf("%w: 列为 %s，期望 %s",
			ErrSchemaInvalid, strings.Join(columns, ","), strings.Join(expectedColumns, ","))
	}
	if !sameStrings(primaryKey, []string{"account_ref"}) {
		return fmt.Errorf("%w: 主键为 %s，期望 account_ref",
			ErrSchemaInvalid, strings.Join(primaryKey, ","))
	}
	return nil
}

func sameStrings(left []string, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
