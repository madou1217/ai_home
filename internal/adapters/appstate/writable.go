package appstate

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/businessdb"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"

	_ "modernc.org/sqlite"
)

// Execer 是 *sql.DB、*sql.Conn 与 *sql.Tx 共有的写入能力。
type Execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// WriteRawKV 用调用方已有的连接或事务 upsert 一行 app_kv。
//
// 与 ReadRawKV 配对：写入语义（冲突更新与 updated_at）只在这里定义，
// 持有自有事务的调用方不需要再抄一遍 upsert 语句。
func WriteRawKV(
	ctx context.Context,
	execer Execer,
	key string,
	value string,
	updatedAt int64,
) error {
	if execer == nil || strings.TrimSpace(key) == "" {
		return nil
	}
	_, err := execer.ExecContext(ctx,
		"INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
		key, value, updatedAt)
	return err
}

// DeleteRawKV 用调用方已有的连接或事务删除一行 app_kv。
//
// 返回是否真的删除了记录，供需要区分「删掉了」与「本来就不存在」的调用方使用。
func DeleteRawKV(ctx context.Context, execer Execer, key string) (bool, error) {
	if execer == nil || strings.TrimSpace(key) == "" {
		return false, nil
	}
	result, err := execer.ExecContext(ctx, "DELETE FROM app_kv WHERE key = ?", key)
	if err != nil {
		return false, err
	}
	changes, err := result.RowsAffected()
	return changes > 0, err
}

// WriteKV 以单事务 upsert 一行 app_kv。写入口应尽量收敛：只有明确迁移到 Go 的
// 设置键才走这里，Node 仍在写的键不要双写。
func WriteKV(ctx context.Context, databasePath string, key string, value string, updatedAt int64) error {
	db, err := OpenWritable(ctx, databasePath)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"); err != nil {
		return err
	}
	return WriteRawKV(ctx, db, key, value, updatedAt)
}

// DeleteKV 删除一行 app_kv；键不存在视为成功。
func DeleteKV(ctx context.Context, databasePath string, key string) error {
	db, err := OpenWritable(ctx, databasePath)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"); err != nil {
		return err
	}
	_, err = DeleteRawKV(ctx, db, key)
	return err
}

// OpenWritable 以 rwc + busy_timeout 打开 app-state.db。
func OpenWritable(ctx context.Context, databasePath string) (*sql.DB, error) {
	if err := businessdb.CheckReady(ctx, databasePath); err != nil {
		return nil, err
	}
	fileURL := sqlitefile.URL(databasePath)
	query := fileURL.Query()
	query.Set("mode", "rwc")
	query.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", busyTimeoutMS))
	fileURL.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", fileURL.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

// UpdateKV 在 BEGIN IMMEDIATE 事务里读改写一行 app_kv；mutate 返回新值。
// 用于共享键（例如 config:server）的局部字段更新：与其它写者的立即事务串行化，
// 不会把对方刚写的字段覆盖回旧值。
func UpdateKV(ctx context.Context, databasePath string, key string, mutate func(current string, found bool) (string, error)) error {
	db, err := OpenWritableImmediate(ctx, databasePath)
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	if _, err := db.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"); err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	value := ""
	found := false
	if err := tx.QueryRowContext(ctx, "SELECT value FROM app_kv WHERE key = ?", key).Scan(&value); err == nil {
		found = true
	} else if !strings.Contains(strings.ToLower(err.Error()), "no rows") {
		return err
	}
	next, err := mutate(value, found)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		"INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
		key, next, time.Now().UnixMilli()); err != nil {
		return err
	}
	return tx.Commit()
}

// OpenWritableImmediate opens a writer whose transactions acquire the SQLite
// write reservation before reading, avoiding deferred read-to-write upgrades.
func OpenWritableImmediate(ctx context.Context, databasePath string) (*sql.DB, error) {
	if err := businessdb.CheckReady(ctx, databasePath); err != nil {
		return nil, err
	}
	fileURL := sqlitefile.URL(databasePath)
	query := fileURL.Query()
	query.Set("mode", "rwc")
	query.Set("_txlock", "immediate")
	query.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", busyTimeoutMS))
	fileURL.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", fileURL.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}
