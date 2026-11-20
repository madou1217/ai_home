// Package appstate 提供 WebUI 只读模型访问唯一的 aih.db。
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

	"github.com/madou1217/ai_home/internal/adapters/businessdb"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"

	_ "modernc.org/sqlite"
)

const (
	// DatabaseFileName 是唯一业务数据库文件名。
	DatabaseFileName = "aih.db"
	busyTimeoutMS    = 5000
)

// ErrInvalidRoot 表示没有可用的 AIH 数据根目录。
var ErrInvalidRoot = errors.New("app-state 数据根目录无效")

// DatabasePath 返回 aiHomeDir 下 aih.db 的绝对路径。
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
	if err := businessdb.CheckReady(ctx, databasePath); err != nil {
		return nil, err
	}
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

// Queryer 是 *sql.DB、*sql.Conn 与 *sql.Tx 共有的单行查询能力。
//
// 它让持有自有连接或事务的调用方复用同一条 KV 读取口径，而不必另开连接
// （另开会破坏事务快照，也会绕过连接池上限）。
type Queryer interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// ReadRawKV 使用调用方已有的连接或事务读取 app_kv 原文。
//
// 表缺失或键缺失都返回 found=false（与「从未写入」同义）；其他错误原样返回，
// 由调用方按自己的语义包装。runtimes 因此不再各自知道表名和缺表处理规则。
func ReadRawKV(ctx context.Context, queryer Queryer, key string) (string, bool, error) {
	normalizedKey := strings.TrimSpace(key)
	if normalizedKey == "" || queryer == nil {
		return "", false, nil
	}
	var value string
	err := queryer.QueryRowContext(
		ctx,
		`SELECT value FROM app_kv WHERE key = ?`,
		normalizedKey,
	).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return "", false, nil
		}
		return "", false, err
	}
	return value, true, nil
}

// ReadRawKVStrict 与 ReadRawKV 相同，但只把「键不存在」当 found=false；
// app_kv 表缺失按错误返回。
//
// 用于「表必须已经存在」的场景：例如已持久化加载过的存储再次读取时缺表，
// 说明数据被外部删除或损坏，不能静默当成「从未写入」。
func ReadRawKVStrict(
	ctx context.Context,
	queryer Queryer,
	key string,
) (string, bool, error) {
	normalizedKey := strings.TrimSpace(key)
	if normalizedKey == "" || queryer == nil {
		return "", false, nil
	}
	var value string
	err := queryer.QueryRowContext(
		ctx,
		`SELECT value FROM app_kv WHERE key = ?`,
		normalizedKey,
	).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

// ReadRawKVPrefix 使用调用方已有的连接读取前缀匹配的全部记录；prefix 为空表示整表。
//
// 表缺失按空结果处理：这些调用方在「从未写入」与「表尚未创建」之间不做区分。
func ReadRawKVPrefix(
	ctx context.Context,
	queryer Queryer,
	prefix string,
) (map[string]string, error) {
	result := make(map[string]string)
	if queryer == nil {
		return result, nil
	}
	query := "SELECT key, value FROM app_kv ORDER BY key"
	arguments := []any(nil)
	if prefix != "" {
		upper := prefix[:len(prefix)-1] + string(prefix[len(prefix)-1]+1)
		query = "SELECT key, value FROM app_kv WHERE key >= ? AND key < ? ORDER BY key"
		arguments = []any{prefix, upper}
	}
	rows, err := queryer.QueryContext(ctx, query, arguments...)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return result, nil
		}
		return result, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return result, err
		}
		result[key] = value
	}
	return result, rows.Err()
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
	value, found, err := ReadRawKV(ctx, db, normalizedKey)
	if err != nil {
		return "", false, fmt.Errorf("读取 app_kv 失败: %w", err)
	}
	return value, found, nil
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
	// 无台账投影账号一律 404。
	return lookupGoAccountProviderNear(ctx, databasePath, reference)
}

// LookupNodeAccountProvider 只读 Node 台账 account_refs，不回落 Go 账号库。
//
// 与 LookupAccountProvider 的区别：后者回落 Go 账号库以兼容「账号真实写入方已经是
// Go」的读模型；这里要回答的是「Node 宿主是否拥有该账号」，所以只能在 Node 台账里
// 查找。无台账投影账号返回 found=false，调用方据此接管刷新。
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
