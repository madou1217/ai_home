package sqliteaccount

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/businessdb"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	_ "modernc.org/sqlite"
)

const (
	// DatabaseFileName 是 AIH 单一业务数据库的固定文件名。
	DatabaseFileName = businessdb.FileName
	databaseFileMode = 0o600
	databaseDirMode  = 0o700
)

// OpenOptions 是打开账号 SQLite Adapter 所需的依赖。
type OpenOptions struct {
	// AIHomeDir 是 AIH 数据根目录；数据库固定创建为该目录下的 aih.db。
	AIHomeDir string
	// Catalog 是当前进程唯一的 Provider 合同注册表。
	Catalog *providers.Catalog
	// WatchModelSettings keeps routing snapshots current for a long-lived server.
	// Command-owned stores reconcile once on open; they must not keep a background
	// writer (and its diagnostics) attached to the foreground provider terminal.
	WatchModelSettings bool
	// ModelSettingsLogf receives background watcher diagnostics when provided.
	// A nil sink is silent; server hosts opt in explicitly.
	ModelSettingsLogf func(string, ...any)
}

// Store 是账号应用端口的 SQLite 实现。
type Store struct {
	modelSettingsDigest [32]byte // guarded by routingWrites
	modelSettingsWatch  *modelSettingsWatch
	modelSettingsLogf   func(string, ...any)
	db                  *sql.DB
	catalog             *providers.Catalog
	credentials         credentialRegistry
	profiles            profileRegistry
	routes              *routingIndex
	// routingWrites 串行化会同时改变 SQLite 路由事实和内存物化索引的管理写操作。
	//
	// 该锁不参与账号征召或 /v1/models 读取，只保证事务提交顺序与索引发布顺序一致。
	routingWrites sync.Mutex
	// mappingWrites 串行化上游错误映射组的写事务。
	//
	// 映射组更新是「读当前版本 → CAS 更新 → 重写规则」的多语句事务。SQLite 的
	// deferred 事务在并发写升级时容易返回 BUSY 而不是干净的版本冲突；进程内先
	// 串行化，冲突判定就只剩版本比较，行为可预期。跨进程仍由 WHERE version=? 兜底。
	mappingWrites sync.Mutex
	// ruleWrites 串行化账号规则的写事务。
	//
	// 同一账号的规则与组挂载要在「先删后插」的事务里保持一致；进程内串行化让两条
	// 账号写路径不会交错，跨进程仍由 SQLite 事务兜底。
	ruleWrites sync.Mutex
	// quotaPruneAtMS 是上一次额度采样清理的时刻，限频用，不需要严格精确。
	quotaPruneAtMS atomic.Int64
}

// Open 创建或校验 aih.db，并返回可并发使用的账号 Store。
func Open(ctx context.Context, options OpenOptions) (*Store, error) {
	store, err := openSchemaStore(ctx, options)
	if err != nil {
		return nil, err
	}
	store.modelSettingsLogf = options.ModelSettingsLogf
	db := store.db
	// 用户可见的 CLI 编号一直记录在 Node 台账 account_cli_aliases；Go 自增序列表
	// 与它是两套编号。每次打开账号库都把两份收敛，保证 `aih ls`、`aih <id>`
	// 和 WebUI 看到的是同一个数字。缺台账（全新安装）时是空操作。
	if aliases := readNodeCLIAliases(ctx, options.AIHomeDir); len(aliases) > 0 {
		if err := store.reconcileNodeCLIAliases(ctx, aliases); err != nil {
			_ = db.Close()
			return nil, err
		}
	}
	// 启动自愈：清理历史遗留的孤儿凭据（无 accounts 行）。级联只在
	// foreign_keys=ON 的连接上生效，不能假设旧库/外部写入都守住了这条约束。
	if _, err := store.DeleteOrphanCredentials(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	// Take over settings-owned model policies before publishing the first routes.
	// Canonical enabled/default state is never reseeded from legacy projections.
	if err := store.migrateModelSettings(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
	routes, err := store.loadRoutingIndex(ctx)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	store.routes = routes
	if options.WatchModelSettings {
		if err := store.startModelSettingsWatch(options.AIHomeDir); err != nil {
			_ = db.Close()
			return nil, err
		}
	}
	return store, nil
}

// DatabasePath 返回指定 AIH 数据目录对应的唯一数据库路径。
func DatabasePath(aiHomeDir string) (string, error) {
	value := strings.TrimSpace(aiHomeDir)
	if value == "" {
		return "", ErrInvalidOpenOptions
	}
	absoluteDir, err := filepath.Abs(value)
	if err != nil {
		return "", ErrInvalidOpenOptions
	}
	return filepath.Join(absoluteDir, DatabaseFileName), nil
}

// Close 释放 SQLite 连接池。
func (store *Store) Close() error {
	if store == nil || store.db == nil {
		return nil
	}
	store.modelSettingsWatch.close()
	return store.db.Close()
}

// prepareDatabasePath 创建私有数据目录和数据库文件。
func prepareDatabasePath(options OpenOptions) (string, error) {
	if options.Catalog == nil {
		return "", ErrInvalidOpenOptions
	}
	databasePath, err := DatabasePath(options.AIHomeDir)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(filepath.Dir(databasePath), databaseDirMode); err != nil {
		return "", fmt.Errorf("创建账号数据库目录失败: %w", err)
	}
	file, err := os.OpenFile(databasePath, os.O_CREATE|os.O_RDWR, databaseFileMode)
	if err != nil {
		return "", fmt.Errorf("创建账号数据库文件失败: %w", err)
	}
	if err := file.Close(); err != nil {
		return "", fmt.Errorf("关闭账号数据库预创建文件失败: %w", err)
	}
	if err := os.Chmod(databasePath, databaseFileMode); err != nil {
		return "", fmt.Errorf("设置账号数据库权限失败: %w", err)
	}
	return databasePath, nil
}

// buildDatabaseDSN 为每个连接固定启用外键、超时和安全 schema 设置。
func buildDatabaseDSN(databasePath string) string {
	fileURL := sqlitefile.URL(databasePath)
	query := fileURL.Query()
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "foreign_keys(ON)")
	query.Add("_pragma", "synchronous(NORMAL)")
	query.Add("_pragma", "trusted_schema(OFF)")
	// 页缓存：默认 2MB 连账本索引（约 4MB）都装不下。实测 8MB 已饱和——
	// 覆盖索引扫描 36ms、日汇总 <0.2ms，16/32/64MB 都没有更快；池上限 4 条连接，
	// 所以取 8MB（最坏 32MB），把省下的内存留给进程其它部分。
	query.Add("_pragma", "cache_size(-8192)")
	// WAL 下 deferred 事务「先读后写」会在并发写者提交后升级失败，返回
	// SQLITE_BUSY_SNAPSHOT；busy_timeout 对这类错误**不重试**，5 秒窗口形同虚设
	// （真机日志里高频的 database is locked 正是它）。统一 BEGIN IMMEDIATE：
	// 事务一开始就排进写锁队列，由 busy_timeout 正常等待。
	// 只读事务不受影响：驱动按 sql.TxOptions.ReadOnly 选择普通 BEGIN。
	query.Add("_txlock", "immediate")
	fileURL.RawQuery = query.Encode()
	return fileURL.String()
}
