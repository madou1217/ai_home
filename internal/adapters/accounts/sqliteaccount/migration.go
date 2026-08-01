package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

const (
	journalModeRetryLimit = 8
	journalModeRetryBase  = 5 * time.Millisecond
	journalModeRetryMax   = 100 * time.Millisecond
)

var expectedSchemaColumns = map[string][]string{
	"accounts": {
		"account_ref",
		"provider_id",
		"cli_account_id",
		"enabled",
		"created_at_ms",
		"updated_at_ms",
	},
	"account_credentials": {
		"account_ref",
		"credential_ref",
		"auth_kind",
		"auth_mode",
		"format_version",
		"credential_json",
		"updated_at_ms",
	},
	"account_profiles": {
		"account_ref",
		"display_name",
		"email",
		"subscription_kind",
		"subscription_raw",
		"format_version",
		"profile_json",
		"updated_at_ms",
	},
	"account_models": {
		"account_ref",
		"model_id",
		"upstream_available",
		"manual_policy",
		"updated_at_ms",
	},
	"account_usage": {
		"account_ref",
		"limit_id",
		"limit_name",
		"bucket",
		"kind",
		"scope",
		"scope_key",
		"remaining_bps",
		"availability",
		"window_seconds",
		"reset_at_ms",
		"source",
		"captured_at_ms",
	},
	"account_defaults": {
		"provider_id",
		"account_ref",
		"updated_at_ms",
	},
}

// initialize 校验数据库身份、执行首次 migration 并启用 WAL。
func (store *Store) initialize(ctx context.Context) error {
	if err := store.db.PingContext(ctx); err != nil {
		return fmt.Errorf("连接账号数据库失败: %w", err)
	}
	connection, err := store.db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("获取账号数据库连接失败: %w", err)
	}
	defer func() {
		_ = connection.Close()
	}()

	if err := migrateConnection(ctx, connection); err != nil {
		return err
	}
	if err := validateConnection(ctx, connection); err != nil {
		return err
	}
	return enableWAL(ctx, connection)
}

// inspectDatabase 读取 SQLite 身份、版本和非系统对象数量。
func inspectDatabase(ctx context.Context, connection *sql.Conn) (int, int, int, error) {
	var applicationID int
	if err := connection.QueryRowContext(ctx, "PRAGMA application_id").Scan(&applicationID); err != nil {
		return 0, 0, 0, fmt.Errorf("读取账号数据库 application_id 失败: %w", err)
	}
	var schemaVersion int
	if err := connection.QueryRowContext(ctx, "PRAGMA user_version").Scan(&schemaVersion); err != nil {
		return 0, 0, 0, fmt.Errorf("读取账号数据库 user_version 失败: %w", err)
	}
	var objectCount int
	const countObjectsSQL = `
		SELECT COUNT(*)
		FROM sqlite_schema
		WHERE name NOT LIKE 'sqlite_%'
		  AND type IN ('table', 'index', 'view', 'trigger')`
	if err := connection.QueryRowContext(ctx, countObjectsSQL).Scan(&objectCount); err != nil {
		return 0, 0, 0, fmt.Errorf("检查账号数据库对象失败: %w", err)
	}
	return applicationID, schemaVersion, objectCount, nil
}

// migrateConnection 在立即事务中创建最新结构或逐版执行前向 migration。
func migrateConnection(ctx context.Context, connection *sql.Conn) (resultErr error) {
	if _, err := connection.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return fmt.Errorf("开始账号数据库 migration 失败: %w", err)
	}
	defer func() {
		if resultErr != nil {
			_, _ = connection.ExecContext(context.WithoutCancel(ctx), "ROLLBACK")
		}
	}()

	applicationID, schemaVersion, objectCount, err := inspectDatabase(ctx, connection)
	if err != nil {
		return err
	}
	if applicationID == ApplicationID && schemaVersion == SchemaVersion {
		return commitMigration(ctx, connection)
	}
	if applicationID == ApplicationID && schemaVersion == 1 {
		if _, err := connection.ExecContext(ctx, SchemaV2); err != nil {
			return fmt.Errorf("迁移账号数据库到 v2 失败: %w", err)
		}
		if _, err := connection.ExecContext(ctx, SchemaV3); err != nil {
			return fmt.Errorf("迁移账号数据库到 v3 失败: %w", err)
		}
		if _, err := connection.ExecContext(ctx, SchemaV4); err != nil {
			return fmt.Errorf("迁移账号数据库到 v4 失败: %w", err)
		}
		if _, err := connection.ExecContext(ctx, SchemaV5); err != nil {
			return fmt.Errorf("迁移账号数据库到 v5 失败: %w", err)
		}
		return commitMigration(ctx, connection)
	}
	if applicationID == ApplicationID && schemaVersion == 2 {
		if _, err := connection.ExecContext(ctx, SchemaV3); err != nil {
			return fmt.Errorf("迁移账号数据库到 v3 失败: %w", err)
		}
		if _, err := connection.ExecContext(ctx, SchemaV4); err != nil {
			return fmt.Errorf("迁移账号数据库到 v4 失败: %w", err)
		}
		if _, err := connection.ExecContext(ctx, SchemaV5); err != nil {
			return fmt.Errorf("迁移账号数据库到 v5 失败: %w", err)
		}
		return commitMigration(ctx, connection)
	}
	if applicationID == ApplicationID && schemaVersion == 3 {
		if _, err := connection.ExecContext(ctx, SchemaV4); err != nil {
			return fmt.Errorf("迁移账号数据库到 v4 失败: %w", err)
		}
		if _, err := connection.ExecContext(ctx, SchemaV5); err != nil {
			return fmt.Errorf("迁移账号数据库到 v5 失败: %w", err)
		}
		return commitMigration(ctx, connection)
	}
	if applicationID == ApplicationID && schemaVersion == 4 {
		if _, err := connection.ExecContext(ctx, SchemaV5); err != nil {
			return fmt.Errorf("迁移账号数据库到 v5 失败: %w", err)
		}
		return commitMigration(ctx, connection)
	}
	if applicationID != 0 || schemaVersion != 0 || objectCount != 0 {
		return ErrIncompatibleDatabase
	}
	if _, err := connection.ExecContext(ctx, SchemaV1); err != nil {
		return fmt.Errorf("创建账号数据库 v1 失败: %w", err)
	}
	if _, err := connection.ExecContext(ctx, SchemaV2); err != nil {
		return fmt.Errorf("创建账号数据库 v2 失败: %w", err)
	}
	if _, err := connection.ExecContext(ctx, SchemaV3); err != nil {
		return fmt.Errorf("创建账号数据库 v3 失败: %w", err)
	}
	if _, err := connection.ExecContext(ctx, SchemaV4); err != nil {
		return fmt.Errorf("创建账号数据库 v4 失败: %w", err)
	}
	if _, err := connection.ExecContext(ctx, SchemaV5); err != nil {
		return fmt.Errorf("创建账号数据库 v5 失败: %w", err)
	}
	return commitMigration(ctx, connection)
}

// commitMigration 提交 migration 事务并统一错误语义。
func commitMigration(ctx context.Context, connection *sql.Conn) error {
	if _, err := connection.ExecContext(ctx, "COMMIT"); err != nil {
		return fmt.Errorf("提交账号数据库 migration 失败: %w", err)
	}
	return nil
}

// enableWAL 幂等启用持久 WAL，并处理并发进程初始化时的短暂 SQLite 锁竞争。
func enableWAL(ctx context.Context, connection *sql.Conn) error {
	var lastErr error
	for attempt := range journalModeRetryLimit {
		var journalMode string
		err := connection.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&journalMode)
		if err == nil && strings.EqualFold(journalMode, "wal") {
			return nil
		}
		if err == nil {
			err = connection.QueryRowContext(ctx, "PRAGMA journal_mode=WAL").Scan(&journalMode)
			if err == nil && strings.EqualFold(journalMode, "wal") {
				return nil
			}
			if err == nil {
				return fmt.Errorf(
					"%w: journal_mode=%s",
					ErrIncompatibleDatabase,
					journalMode,
				)
			}
		}
		if !isBusyError(err) {
			return fmt.Errorf("启用账号数据库 WAL 失败: %w", err)
		}
		lastErr = err
		if attempt == journalModeRetryLimit-1 {
			break
		}
		if err := waitForJournalModeRetry(ctx, attempt); err != nil {
			return fmt.Errorf("启用账号数据库 WAL 失败: %w", err)
		}
	}
	return fmt.Errorf("启用账号数据库 WAL 失败: %w", lastErr)
}

// waitForJournalModeRetry 使用有上限的指数退避，避免并发启动时忙等。
func waitForJournalModeRetry(ctx context.Context, attempt int) error {
	delay := journalModeRetryBase << attempt
	if delay > journalModeRetryMax {
		delay = journalModeRetryMax
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// validateConnection 确保连接级外键和最新表、索引结构完整。
func validateConnection(ctx context.Context, connection *sql.Conn) error {
	applicationID, schemaVersion, _, err := inspectDatabase(ctx, connection)
	if err != nil {
		return err
	}
	if applicationID != ApplicationID || schemaVersion != SchemaVersion {
		return ErrIncompatibleDatabase
	}
	var foreignKeysEnabled int
	if err := connection.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&foreignKeysEnabled); err != nil {
		return fmt.Errorf("读取账号数据库外键设置失败: %w", err)
	}
	if foreignKeysEnabled != 1 {
		return fmt.Errorf("%w: foreign_keys=off", ErrIncompatibleDatabase)
	}
	for tableName, expectedColumns := range expectedSchemaColumns {
		columns, err := readTableColumns(ctx, connection, tableName)
		if err != nil {
			return err
		}
		if !equalStrings(columns, expectedColumns) {
			return fmt.Errorf("%w: table=%s", ErrIncompatibleDatabase, tableName)
		}
	}
	for _, indexName := range []string{
		"idx_accounts_routing",
		"idx_account_credentials_credential_ref",
		"idx_account_models_effective",
	} {
		var indexCount int
		const indexSQL = `
			SELECT COUNT(*)
			FROM sqlite_schema
			WHERE type = 'index' AND name = ?`
		if err := connection.QueryRowContext(ctx, indexSQL, indexName).Scan(&indexCount); err != nil {
			return fmt.Errorf("检查账号索引失败: %w", err)
		}
		if indexCount != 1 {
			return ErrIncompatibleDatabase
		}
	}
	var triggerCount int
	const triggerSQL = `
		SELECT COUNT(*)
		FROM sqlite_schema
		WHERE type = 'trigger' AND name = 'trg_account_defaults_clear_disabled'`
	if err := connection.QueryRowContext(ctx, triggerSQL).Scan(&triggerCount); err != nil {
		return fmt.Errorf("检查账号默认关系触发器失败: %w", err)
	}
	if triggerCount != 1 {
		return ErrIncompatibleDatabase
	}
	return nil
}

// readTableColumns 返回 STRICT 表按声明顺序排列的列名。
func readTableColumns(ctx context.Context, connection *sql.Conn, tableName string) ([]string, error) {
	rows, err := connection.QueryContext(ctx, "PRAGMA table_info("+tableName+")")
	if err != nil {
		return nil, fmt.Errorf("读取账号表结构失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()

	var columns []string
	for rows.Next() {
		var columnID int
		var name, columnType string
		var notNull, primaryKey int
		var defaultValue sql.NullString
		if err := rows.Scan(
			&columnID,
			&name,
			&columnType,
			&notNull,
			&defaultValue,
			&primaryKey,
		); err != nil {
			return nil, fmt.Errorf("解析账号表结构失败: %w", err)
		}
		columns = append(columns, name)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历账号表结构失败: %w", err)
	}
	if len(columns) == 0 {
		return nil, ErrIncompatibleDatabase
	}
	return columns, nil
}

// equalStrings 判断两个有序字符串切片是否完全一致。
func equalStrings(left []string, right []string) bool {
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

// isConstraintError 判断错误是否属于 SQLite 约束冲突。
func isConstraintError(err error) bool {
	var sqliteError interface{ Code() int }
	return errors.As(err, &sqliteError) && sqliteError.Code()&0xff == 19
}

// isBusyError 判断错误是否属于 SQLite 短暂忙或锁冲突。
func isBusyError(err error) bool {
	var sqliteError interface{ Code() int }
	if !errors.As(err, &sqliteError) {
		return false
	}
	primaryCode := sqliteError.Code() & 0xff
	return primaryCode == 5 || primaryCode == 6
}

// isForeignKeyError 判断错误是否属于 SQLite 外键约束失败。
func isForeignKeyError(err error) bool {
	var sqliteError interface{ Code() int }
	return errors.As(err, &sqliteError) && sqliteError.Code() == 787
}
