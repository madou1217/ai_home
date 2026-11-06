package kirodb

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// DatabaseSnapshot 是一次一致性快照及其中的凭据槽。
//
// Database 是 VACUUM INTO 产出的完整 SQLite 字节（含 auth_kv、会话与设置），
// 供 native_auth_json 的 database 字段使用；Auth 从同一份快照读取，保证
// 采纳后的 auth 与 database 描述的是同一时刻的凭据，不会出现「新 token + 旧库」。
type DatabaseSnapshot struct {
	Database  []byte
	Auth      Auth
	AuthFound bool
}

// ReadSnapshot 用 VACUUM INTO 生成 data.sqlite3 的一致性副本。
//
// 与直接复制文件不同，VACUUM INTO 会包含已提交但尚未 checkpoint 的 WAL 页面，
// 也不会读到 CLI 正在写入的半成品页。源库以只读方式打开，不改动投影。
// 任何 I/O、schema 或空结果错误都返回 ErrInvalidDatabase，调用方必须 fail-closed。
func ReadSnapshot(ctx context.Context, databasePath string) (DatabaseSnapshot, error) {
	if ctx == nil || strings.TrimSpace(databasePath) == "" {
		return DatabaseSnapshot{}, ErrInvalidDatabase
	}
	exists, err := regularFileExists(databasePath)
	if err != nil || !exists {
		return DatabaseSnapshot{}, ErrInvalidDatabase
	}
	tempDir, err := os.MkdirTemp("", "aih-kiro-snapshot-")
	if err != nil {
		return DatabaseSnapshot{}, ErrInvalidDatabase
	}
	defer func() {
		_ = os.RemoveAll(tempDir)
	}()
	targetPath := filepath.Join(tempDir, "data.sqlite3")

	database, err := openSnapshotSource(databasePath)
	if err != nil {
		return DatabaseSnapshot{}, ErrInvalidDatabase
	}
	defer func() {
		_ = database.Close()
	}()
	if _, err := database.ExecContext(ctx, "VACUUM INTO ?", targetPath); err != nil {
		return DatabaseSnapshot{}, ErrInvalidDatabase
	}
	if err := os.Chmod(targetPath, 0o600); err != nil {
		return DatabaseSnapshot{}, ErrInvalidDatabase
	}
	document, err := os.ReadFile(targetPath)
	if err != nil || len(document) == 0 {
		return DatabaseSnapshot{}, ErrInvalidDatabase
	}
	auth, found, err := ReadAuth(ctx, targetPath)
	if err != nil {
		return DatabaseSnapshot{}, err
	}
	return DatabaseSnapshot{Database: document, Auth: auth, AuthFound: found}, nil
}

// openSnapshotSource 以只读方式打开源库。
//
// 不复用 openReadOnly 的 query_only：VACUUM INTO 需要 SQLite 读取并写出副本，
// Node 的参考实现同样只用 readOnly，不设置 query_only。
func openSnapshotSource(databasePath string) (*sql.DB, error) {
	fileURL := &url.URL{Scheme: "file", Path: filepath.ToSlash(databasePath)}
	query := fileURL.Query()
	query.Add("mode", "ro")
	query.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", busyTimeoutMillis))
	fileURL.RawQuery = query.Encode()
	database, err := sql.Open("sqlite", fileURL.String())
	if err != nil {
		return nil, ErrInvalidDatabase
	}
	database.SetMaxOpenConns(1)
	database.SetMaxIdleConns(1)
	return database, nil
}
