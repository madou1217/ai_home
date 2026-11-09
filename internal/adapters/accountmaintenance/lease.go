// Package accountmaintenance 实现 Node account-maintenance-lock.js 的 Go 等价物。
//
// 账号维护（OAuth rekey）与普通读写共享 run/maintenance/access.sqlite 的
// OS 级 SQLite 文件锁：普通参与者持有 SHARED，维护 / 恢复持有 EXCLUSIVE。
// Go 的插件写入必须先在读租约下进入，再做 app-state.db 事务；维护期间写入
// fail closed，而不是在维护进程脚下改同一份数据。
package accountmaintenance

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/madou1217/ai_home/internal/pluginerr"
)

// 与 Node account-maintenance-gate.js / account-maintenance-lock.js 的错误码一致。
const (
	CodeBusy          = "account_maintenance_busy"
	CodeInProgress    = "account_maintenance_in_progress"
	CodeUnavailable   = "account_maintenance_unavailable"
	CodePathEscape    = "maintenance_lock_path_escape"
	CodeFileInvalid   = "maintenance_lock_file_invalid"
	CodeModeInvalid   = "maintenance_lock_mode_invalid"
	CodeSchemaInvalid = "maintenance_lock_schema_invalid"
)

const (
	defaultTimeout = time.Second
	leaseFileMode  = 0o600
	directoryMode  = 0o700
	databaseName   = "access.sqlite"
	gateName       = "oauth-rekey.lock"
)

// Lease 是一次读租约；Close 释放 SQLite SHARED 锁。
type Lease struct {
	connection *sql.Conn
	database   *sql.DB
}

// Close 回滚未提交事务并关闭连接。重复调用是安全的。
func (lease *Lease) Close() {
	if lease == nil {
		return
	}
	if lease.connection != nil {
		_, _ = lease.connection.ExecContext(context.Background(), "ROLLBACK")
		_ = lease.connection.Close()
		lease.connection = nil
	}
	if lease.database != nil {
		_ = lease.database.Close()
		lease.database = nil
	}
}

// Acquire 获取维护读租约。
//
// 顺序与 Node 一致：先看 oauth-rekey.lock 闸门，再初始化/校验协调库，最后
// BEGIN + 校验 lease 行。任何 SQLite busy 都收敛成 account_maintenance_busy。
func Acquire(ctx context.Context, aiHomeDir string) (*Lease, error) {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return nil, pluginerr.New(CodeUnavailable, "缺少 aiHomeDir")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, pluginerr.New(CodeUnavailable, "")
	}
	realRoot, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, pluginerr.New(CodeUnavailable, fmt.Sprintf("插件数据根不可用：%s", absolute))
	}
	runDirectory := filepath.Join(absolute, "run")
	maintenanceDirectory := filepath.Join(runDirectory, "maintenance")
	if err := ensurePrivateDirectory(runDirectory); err != nil {
		return nil, err
	}
	if err := ensurePrivateDirectory(maintenanceDirectory); err != nil {
		return nil, err
	}
	canonical, err := filepath.EvalSymlinks(maintenanceDirectory)
	if err != nil {
		return nil, pluginerr.New(CodeUnavailable, "")
	}
	if canonical != realRoot && !strings.HasPrefix(canonical, realRoot+string(filepath.Separator)) {
		return nil, pluginerr.New(CodePathEscape, "")
	}
	gate := filepath.Join(canonical, gateName)
	if _, err := os.Lstat(gate); err == nil {
		return nil, pluginerr.New(CodeInProgress, "")
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, pluginerr.New(CodeUnavailable, "")
	}
	file := filepath.Join(canonical, databaseName)
	for _, candidate := range []string{file, file + "-journal", file + "-wal", file + "-shm"} {
		info, err := os.Lstat(candidate)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, pluginerr.New(CodeUnavailable, "")
		}
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || linkCount(info) > 1 {
			return nil, pluginerr.New(CodeFileInvalid, "")
		}
	}
	// 先以 0600 创建，避免 SQLite 按 umask 生成 0644；已存在时保持原文件。
	if handle, err := os.OpenFile(file, os.O_CREATE|os.O_RDWR, leaseFileMode); err == nil {
		_ = handle.Close()
	}
	database, err := sql.Open("sqlite", file)
	if err != nil {
		return nil, pluginerr.New(CodeUnavailable, "")
	}
	database.SetMaxOpenConns(1)
	database.SetMaxIdleConns(1)
	connection, err := database.Conn(ctx)
	if err != nil {
		_ = database.Close()
		if isBusy(err) {
			return nil, pluginerr.New(CodeBusy, "")
		}
		return nil, pluginerr.New(CodeUnavailable, "")
	}
	lease := &Lease{connection: connection, database: database}
	closeWithError := func(err error) (*Lease, error) {
		lease.Close()
		return nil, err
	}
	if _, err := connection.ExecContext(ctx, "PRAGMA busy_timeout = 1000"); err != nil {
		return closeWithError(mapBusy(err))
	}
	if _, err := connection.ExecContext(ctx, "PRAGMA synchronous = FULL"); err != nil {
		return closeWithError(mapBusy(err))
	}
	var journalMode string
	if err := connection.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&journalMode); err != nil {
		return closeWithError(mapBusy(err))
	}
	if strings.ToLower(strings.TrimSpace(journalMode)) != "delete" {
		return closeWithError(pluginerr.New(CodeModeInvalid, ""))
	}
	if err := ensureLeaseTable(ctx, connection); err != nil {
		return closeWithError(err)
	}
	if _, err := connection.ExecContext(ctx, "BEGIN"); err != nil {
		return closeWithError(mapBusy(err))
	}
	var id int64
	if err := connection.QueryRowContext(ctx, "SELECT id FROM lease WHERE id = 1").Scan(&id); err != nil {
		return closeWithError(mapBusy(err))
	}
	if id != 1 {
		return closeWithError(pluginerr.New(CodeSchemaInvalid, ""))
	}
	_ = os.Chmod(file, leaseFileMode)
	return lease, nil
}

func ensureLeaseTable(ctx context.Context, connection *sql.Conn) error {
	present, err := hasLeaseTable(ctx, connection)
	if err != nil {
		return mapBusy(err)
	}
	if present {
		return nil
	}
	if _, err := connection.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return mapBusy(err)
	}
	committed := false
	defer func() {
		if !committed {
			_, _ = connection.ExecContext(context.Background(), "ROLLBACK")
		}
	}()
	present, err = hasLeaseTable(ctx, connection)
	if err != nil {
		return mapBusy(err)
	}
	if present {
		if _, err := connection.ExecContext(ctx, "ROLLBACK"); err != nil {
			return mapBusy(err)
		}
		return nil
	}
	var objects int
	if err := connection.QueryRowContext(ctx,
		"SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").Scan(&objects); err != nil {
		return mapBusy(err)
	}
	if objects > 0 {
		return pluginerr.New(CodeSchemaInvalid, "")
	}
	if _, err := connection.ExecContext(ctx,
		"CREATE TABLE lease(id INTEGER PRIMARY KEY); INSERT INTO lease VALUES(1)"); err != nil {
		return mapBusy(err)
	}
	if _, err := connection.ExecContext(ctx, "COMMIT"); err != nil {
		return mapBusy(err)
	}
	committed = true
	return nil
}

func hasLeaseTable(ctx context.Context, connection *sql.Conn) (bool, error) {
	var count int
	err := connection.QueryRowContext(ctx,
		"SELECT count(*) FROM sqlite_master WHERE type='table' AND name='lease'").Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

func ensurePrivateDirectory(directory string) error {
	info, err := os.Lstat(directory)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(directory, directoryMode); err != nil {
			return pluginerr.New(CodeUnavailable, fmt.Sprintf("无法创建维护目录：%s", directory))
		}
		info, err = os.Lstat(directory)
	}
	if err != nil {
		return pluginerr.New(CodeUnavailable, "")
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return pluginerr.New(CodePathEscape, fmt.Sprintf("维护目录不可信：%s", directory))
	}
	if err := os.Chmod(directory, directoryMode); err != nil {
		return pluginerr.New(CodeUnavailable, "")
	}
	return nil
}

// linkCount 读取底层 stat 的 nlink；Windows 的 FileInfo 没有该字段时返回 0，
// 与 Node 的「nlink > 1 视为硬链接风险」检查保持同等意图。
func linkCount(info os.FileInfo) uint64 {
	if info == nil {
		return 0
	}
	value := reflect.ValueOf(info.Sys())
	if value.Kind() == reflect.Pointer {
		if value.IsNil() {
			return 0
		}
		value = value.Elem()
	}
	if value.Kind() != reflect.Struct {
		return 0
	}
	field := value.FieldByName("Nlink")
	if !field.IsValid() {
		return 0
	}
	switch field.Kind() {
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr:
		return field.Uint()
	}
	return 0
}

func isBusy(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "database is locked") ||
		strings.Contains(message, "database table is locked") ||
		strings.Contains(message, "sqlite_busy")
}

func mapBusy(err error) error {
	if isBusy(err) {
		return pluginerr.New(CodeBusy, "")
	}
	if coded, ok := pluginerr.From(err); ok {
		return coded
	}
	return pluginerr.New(CodeUnavailable, err.Error())
}
