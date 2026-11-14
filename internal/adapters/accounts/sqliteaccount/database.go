package sqliteaccount

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/madou1217/ai_home/core/providers"
	_ "modernc.org/sqlite"
)

const (
	// DatabaseFileName 是 AIH 单一业务数据库的固定文件名。
	DatabaseFileName = "aih.db"
	databaseFileMode = 0o600
	databaseDirMode  = 0o700
)

// OpenOptions 是打开账号 SQLite Adapter 所需的依赖。
type OpenOptions struct {
	// AIHomeDir 是 AIH 数据根目录；数据库固定创建为该目录下的 aih.db。
	AIHomeDir string
	// Catalog 是当前进程唯一的 Provider 合同注册表。
	Catalog *providers.Catalog
}

// Store 是账号应用端口的 SQLite 实现。
type Store struct {
	db          *sql.DB
	catalog     *providers.Catalog
	credentials credentialRegistry
	profiles    profileRegistry
	routes      *routingIndex
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
	databasePath, err := prepareDatabasePath(options)
	if err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", buildDatabaseDSN(databasePath))
	if err != nil {
		return nil, fmt.Errorf("打开账号数据库失败: %w", err)
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)

	store := &Store{
		db:          db,
		catalog:     options.Catalog,
		credentials: newCredentialRegistry(),
		profiles:    newProfileRegistry(),
	}
	if err := store.initialize(ctx); err != nil {
		_ = db.Close()
		return nil, err
	}
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
	routes, err := store.loadRoutingIndex(ctx)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	store.routes = routes
	if err := os.Chmod(databasePath, databaseFileMode); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("收紧账号数据库权限失败: %w", err)
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
	fileURL := &url.URL{Scheme: "file", Path: filepath.ToSlash(databasePath)}
	query := fileURL.Query()
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "foreign_keys(ON)")
	query.Add("_pragma", "synchronous(NORMAL)")
	query.Add("_pragma", "trusted_schema(OFF)")
	fileURL.RawQuery = query.Encode()
	return fileURL.String()
}
