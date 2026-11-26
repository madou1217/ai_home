package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// retiredTables 是 Node 时代兼容投影与历史台账的表名。
//
// 它们不再有任何读写方：账号身份、凭据、额度与运行态都以 Go 的 canonical 表为准。
// 启动迁移会先重建仍被当前功能使用、但带 account_refs 外键的表，再删除这些表。
var retiredTables = []string{
	"account_refs",
	"account_cli_aliases",
	"account_state",
	"compat_account_credentials",
	"compat_account_quota_detector_state",
	"compat_account_quota_reset_events",
	"compat_account_quota_window_samples",
	"native_account_outcomes",
}

// dropRetiredTables 删除退役表；必要时先去掉当前表的 account_refs 外键。
func dropRetiredTables(ctx context.Context, connection *sql.Conn) error {
	if connection == nil {
		return nil
	}
	if _, err := connection.ExecContext(ctx, "PRAGMA foreign_keys=OFF"); err != nil {
		return fmt.Errorf("关闭外键校验失败: %w", err)
	}
	defer connection.ExecContext(context.WithoutCancel(ctx), "PRAGMA foreign_keys=ON")
	if _, err := connection.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return fmt.Errorf("开始退役表迁移事务失败: %w", err)
	}
	defer connection.ExecContext(context.WithoutCancel(ctx), "ROLLBACK")

	for _, table := range []string{"codex_reset_credits", "codex_reset_operations"} {
		if err := rebuildTableWithoutForeignKeys(ctx, connection, table); err != nil {
			return err
		}
	}
	for _, table := range retiredTables {
		if _, err := connection.ExecContext(ctx, "DROP TABLE IF EXISTS "+quoteIdentifier(table)); err != nil {
			return fmt.Errorf("删除退役表 %s 失败: %w", table, err)
		}
	}
	if _, err := connection.ExecContext(ctx, "COMMIT"); err != nil {
		return fmt.Errorf("提交退役表迁移失败: %w", err)
	}
	return nil
}

// rebuildTableWithoutForeignKeys 在保留数据的前提下重写一张带外键的表。
//
// codex_reset_* 曾经把 account_refs 当作父表；父表删除后外键会永久悬空，
// 而这些表仍被 Codex 重置额度功能使用，因此只能就地重建、去掉外键约束。
func rebuildTableWithoutForeignKeys(ctx context.Context, connection *sql.Conn, table string) error {
	var createSQL string
	err := connection.QueryRowContext(ctx,
		"SELECT sql FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&createSQL)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("读取 %s 表结构失败: %w", table, err)
	}
	if !strings.Contains(strings.ToUpper(createSQL), "FOREIGN KEY") {
		return nil
	}
	columns, err := tableColumns(ctx, connection, table)
	if err != nil {
		return err
	}
	indexSQLs, err := tableIndexSQL(ctx, connection, table)
	if err != nil {
		return err
	}
	legacyName := table + "__retired_fk"
	if _, err := connection.ExecContext(ctx, "ALTER TABLE "+quoteIdentifier(table)+" RENAME TO "+quoteIdentifier(legacyName)); err != nil {
		return fmt.Errorf("重命名 %s 失败: %w", table, err)
	}
	newSQL := stripForeignKeys(createSQL)
	if _, err := connection.ExecContext(ctx, newSQL); err != nil {
		return fmt.Errorf("重建 %s 失败: %w", table, err)
	}
	quoted := make([]string, len(columns))
	for index, column := range columns {
		quoted[index] = quoteIdentifier(column)
	}
	if _, err := connection.ExecContext(ctx,
		"INSERT INTO "+quoteIdentifier(table)+" ("+strings.Join(quoted, ",")+") SELECT "+strings.Join(quoted, ",")+" FROM "+quoteIdentifier(legacyName)); err != nil {
		return fmt.Errorf("迁移 %s 数据失败: %w", table, err)
	}
	if _, err := connection.ExecContext(ctx, "DROP TABLE "+quoteIdentifier(legacyName)); err != nil {
		return fmt.Errorf("删除 %s 旧表失败: %w", table, err)
	}
	for _, indexSQL := range indexSQLs {
		restored := strings.ReplaceAll(indexSQL, legacyName, table)
		if _, err := connection.ExecContext(ctx, restored); err != nil && !strings.Contains(strings.ToLower(err.Error()), "already exists") {
			return fmt.Errorf("重建 %s 索引失败: %w", table, err)
		}
	}
	return nil
}

func tableColumns(ctx context.Context, connection *sql.Conn, table string) ([]string, error) {
	rows, err := connection.QueryContext(ctx, "PRAGMA table_info("+quoteIdentifier(table)+")")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := make([]string, 0, 8)
	for rows.Next() {
		var cid int
		var name, kind string
		var notNull, primary int
		var defaultValue any
		if err := rows.Scan(&cid, &name, &kind, &notNull, &defaultValue, &primary); err != nil {
			return nil, err
		}
		columns = append(columns, name)
	}
	return columns, rows.Err()
}

func tableIndexSQL(ctx context.Context, connection *sql.Conn, table string) ([]string, error) {
	rows, err := connection.QueryContext(ctx,
		"SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL", table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sqls := make([]string, 0, 4)
	for rows.Next() {
		var statement string
		if err := rows.Scan(&statement); err != nil {
			return nil, err
		}
		sqls = append(sqls, statement)
	}
	return sqls, rows.Err()
}

// stripForeignKeys 删除 CREATE TABLE 中的 FOREIGN KEY 约束并修复悬空逗号。
func stripForeignKeys(createSQL string) string {
	lines := strings.Split(createSQL, "\n")
	kept := make([]string, 0, len(lines))
	dropped := false
	for _, line := range lines {
		if strings.HasPrefix(strings.ToUpper(strings.TrimSpace(line)), "FOREIGN KEY") {
			dropped = true
			continue
		}
		kept = append(kept, line)
	}
	if dropped {
		// 最后一个字段与右括号之间的 FOREIGN KEY 被删掉后，前一个字段会留下
		// 悬空逗号；从右括号往前移除第一个行尾逗号。
		closing := -1
		for index := len(kept) - 1; index >= 0; index-- {
			if strings.TrimSpace(kept[index]) == ")" {
				closing = index
				break
			}
		}
		for index := closing - 1; index >= 0; index-- {
			trimmed := strings.TrimRight(kept[index], " \t")
			if trimmed == "" {
				continue
			}
			if strings.HasSuffix(trimmed, ",") {
				kept[index] = strings.TrimSuffix(trimmed, ",")
			}
			break
		}
	}
	return strings.Join(kept, "\n")
}

func quoteIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}
