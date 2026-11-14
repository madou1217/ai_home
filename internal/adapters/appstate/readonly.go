// Package appstate 提供 WebUI 只读模型访问 Node 的 app-state.db。
//
// 为什么单独成包：账号页、额度重置历史、别名池设置等多个读模型都需要「只读打开
// 同一份 SQLite + 校验 account_refs」，各自复制一份 DSN 与 busy_timeout 会在
// 升级驱动/改只读策略时产生多套口径。这里只保留最小的读能力，写入口仍在 Node。
package appstate

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"

	_ "modernc.org/sqlite"
)

const (
	// DatabaseFileName 是 Node app-state-store 的数据库文件名。
	DatabaseFileName = "app-state.db"
	busyTimeoutMS    = 5000
)

// ErrInvalidRoot 表示没有可用的 AIH 数据根目录。
var ErrInvalidRoot = errors.New("app-state 数据根目录无效")

// DatabasePath 返回 aiHomeDir 下 app-state.db 的绝对路径。
func DatabasePath(aiHomeDir string) (string, error) {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return "", ErrInvalidRoot
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return "", ErrInvalidRoot
	}
	return filepath.Join(absolute, DatabaseFileName), nil
}

// OpenReadOnly 以只读方式打开数据库；数据库不存在时返回 os.ErrNotExist。
func OpenReadOnly(ctx context.Context, databasePath string) (*sql.DB, error) {
	db, err := openAndPing(ctx, databasePath, false)
	if err == nil {
		return db, nil
	}
	// 有 -wal 时不能按 immutable 打开：会读不到未合并的页。
	if _, statErr := os.Stat(databasePath + "-wal"); statErr == nil {
		return nil, err
	}
	return openAndPing(ctx, databasePath, true)
}

// ReadKV 读取 app_kv 的一行。表/行不存在返回 found=false，不视为错误。
func ReadKV(ctx context.Context, databasePath string, key string) (string, bool, error) {
	normalizedKey := strings.TrimSpace(key)
	if normalizedKey == "" {
		return "", false, nil
	}
	db, present, err := openIfPresent(ctx, databasePath)
	if err != nil {
		return "", false, err
	}
	if !present {
		return "", false, nil
	}
	defer func() { _ = db.Close() }()
	var value string
	err = db.QueryRowContext(ctx, `SELECT value FROM app_kv WHERE key = ?`, normalizedKey).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return "", false, nil
		}
		return "", false, fmt.Errorf("读取 app_kv 失败: %w", err)
	}
	return value, true, nil
}

// LookupAccountProvider 从 account_refs 读取账号归属。
//
// 账号存在性以 Node 的账号台账为准：Go 的 accounts 表可能缺少已停用/未同步账号，
// 用它做校验会把真实历史或真实设置判成 404。
func LookupAccountProvider(ctx context.Context, databasePath string, accountRef string) (string, bool, error) {
	reference := strings.TrimSpace(accountRef)
	if reference == "" {
		return "", false, nil
	}
	provider, found, err := lookupAppStateAccountProvider(ctx, databasePath, reference)
	if err != nil || found {
		return provider, found, err
	}
	// 未命中 Node 台账时回落 Go 账号库：账号的真实写入方已经是 Go（浏览器登录 / 导入），
	// account_refs 只覆盖 Node 建过的账号。不回落的话，所有「按 ref 判归属」的接口
	// （模型上下文、账号配置、额度、路由规则、默认账号、窗口激活……）都会对
	// Go 独有账号一律 404。
	return lookupGoAccountProviderNear(ctx, databasePath, reference)
}

// LookupNodeAccountProvider 只读 Node 台账 account_refs，不回落 Go 账号库。
//
// 与 LookupAccountProvider 的区别：后者回落 Go 账号库以兼容「账号真实写入方已经是
// Go」的读模型；这里要回答的是「Node 宿主是否拥有该账号」，所以只能在 Node 台账里
// 查找。Go 独有账号返回 found=false，调用方据此接管刷新。
func LookupNodeAccountProvider(
	ctx context.Context,
	databasePath string,
	accountRef string,
) (string, bool, error) {
	reference := strings.TrimSpace(accountRef)
	if reference == "" {
		return "", false, nil
	}
	return lookupAppStateAccountProvider(ctx, databasePath, reference)
}

func lookupAppStateAccountProvider(
	ctx context.Context,
	databasePath string,
	reference string,
) (string, bool, error) {
	db, present, err := openIfPresent(ctx, databasePath)
	if err != nil {
		return "", false, err
	}
	if !present {
		return "", false, nil
	}
	defer func() { _ = db.Close() }()
	var provider string
	err = db.QueryRowContext(ctx,
		`SELECT provider FROM account_refs WHERE account_ref = ?`,
		reference,
	).Scan(&provider)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return "", false, nil
		}
		return "", false, fmt.Errorf("读取账号归属失败: %w", err)
	}
	return provider, true, nil
}

func openAndPing(ctx context.Context, databasePath string, immutable bool) (*sql.DB, error) {
	db, err := sql.Open("sqlite", buildReadOnlyDSN(databasePath, immutable))
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

func buildReadOnlyDSN(databasePath string, immutable bool) string {
	fileURL := sqlitefile.URL(databasePath)
	query := fileURL.Query()
	query.Set("mode", "ro")
	query.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", busyTimeoutMS))
	query.Add("_pragma", "query_only(1)")
	if immutable {
		query.Set("immutable", "1")
	}
	fileURL.RawQuery = query.Encode()
	return fileURL.String()
}

// openIfPresent 在数据库文件不存在时返回 present=false；存在但打不开才是错误。
//
// 不能用 os.ErrNotExist 判 sqlite 的打开错误：驱动对「文件不存在」报的是
// "unable to open database file: out of memory (14)"，不是 fs.ErrNotExist。
func openIfPresent(ctx context.Context, databasePath string) (*sql.DB, bool, error) {
	info, err := os.Stat(databasePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil || !info.Mode().IsRegular() {
		return nil, false, nil
	}
	db, err := OpenReadOnly(ctx, databasePath)
	if err != nil {
		return nil, false, fmt.Errorf("打开 app-state.db 失败: %w", err)
	}
	return db, true, nil
}
