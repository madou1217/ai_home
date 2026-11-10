package appstate

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

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
	_, err = db.ExecContext(ctx,
		"INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
		key, value, updatedAt)
	return err
}

// OpenWritable 以 rwc + busy_timeout 打开 app-state.db。
func OpenWritable(ctx context.Context, databasePath string) (*sql.DB, error) {
	fileURL := &url.URL{Scheme: "file", Path: filepath.ToSlash(databasePath)}
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
	db, err := openWritableImmediate(ctx, databasePath)
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

func openWritableImmediate(ctx context.Context, databasePath string) (*sql.DB, error) {
	fileURL := &url.URL{Scheme: "file", Path: filepath.ToSlash(databasePath)}
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
