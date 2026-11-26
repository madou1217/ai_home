package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/businessdb"
)

const (
	journalModeRetryLimit = 8
	journalModeRetryBase  = 5 * time.Millisecond
	journalModeRetryMax   = 100 * time.Millisecond
)

// initialize 校验数据库身份、按实际结构能力增量补齐对象并启用 WAL。
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

	if err := dropRetiredTables(ctx, connection); err != nil {
		return err
	}
	if err := ensureConnectionSchema(ctx, connection); err != nil {
		return err
	}
	if err := validateConnection(ctx, connection); err != nil {
		return err
	}
	return enableWAL(ctx, connection)
}

// inspectDatabaseIdentity 读取 SQLite application_id 与非系统对象数量（不读取任何版本号）。
func inspectDatabaseIdentity(ctx context.Context, connection *sql.Conn) (int, int, error) {
	var applicationID int
	if err := connection.QueryRowContext(ctx, "PRAGMA application_id").Scan(&applicationID); err != nil {
		return 0, 0, fmt.Errorf("读取账号数据库 application_id 失败: %w", err)
	}
	var objectCount int
	const countObjectsSQL = `
		SELECT COUNT(*)
		FROM sqlite_schema
		WHERE name NOT LIKE 'sqlite_%'
		  AND type IN ('table', 'index', 'view', 'trigger')`
	if err := connection.QueryRowContext(ctx, countObjectsSQL).Scan(&objectCount); err != nil {
		return 0, 0, fmt.Errorf("检查账号数据库对象失败: %w", err)
	}
	return applicationID, objectCount, nil
}

// verifyCompatibilityBootstrapObjects 确认 application_id=0 的非空库仅包含允许的兼容投影对象。
func verifyCompatibilityBootstrapObjects(ctx context.Context, connection *sql.Conn) error {
	rows, err := connection.QueryContext(
		ctx,
		"SELECT type, tbl_name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'",
	)
	if err != nil {
		return fmt.Errorf("读取兼容引导对象失败: %w", err)
	}
	defer func() {
		_ = rows.Close()
	}()
	for rows.Next() {
		var kind, table string
		if err := rows.Scan(&kind, &table); err != nil {
			return fmt.Errorf("解析兼容引导对象失败: %w", err)
		}
		if (kind != "table" && kind != "index") || !businessdb.IsCompatibilityTable(table) {
			return ErrIncompatibleDatabase
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("遍历兼容引导对象失败: %w", err)
	}
	return rows.Close()
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
