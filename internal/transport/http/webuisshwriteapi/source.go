package webuisshwriteapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	_ "modernc.org/sqlite"
)

const (
	// connectionsKey 是 Node app-state.db 里的 SSH 连接数组。
	connectionsKey = "ssh_connections"
	// workspacesKey 是 Node app-state.db 里的 SSH 工作区数组。
	workspacesKey = "ssh_workspaces"

	createAppKVTable = "CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"
	upsertAppKV      = "INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
	busyTimeoutMS    = 5000
)

// ErrSourceUnavailable 表示数据源没有可用的数据库路径。
var ErrSourceUnavailable = errors.New("SSH 连接数据源不可用")

// KV 是 app_kv 一行的当前值；Found=false 表示该键还不存在。
type KV struct {
	Value string
	Found bool
}

// Source 提供 ssh_connections 与 ssh_workspaces 的写入口。
//
// 只暴露「事务内读改写」能力：调用方拿不到独立读 + 独立写的 API，
// 从类型上避免并发新增互相覆盖。
type Source struct {
	databasePath string
}

// OpenSource 创建写入数据源。
func OpenSource(aiHomeDir string) (*Source, error) {
	path, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil, err
	}
	return &Source{databasePath: path}, nil
}

// UpdateConnections 在 BEGIN IMMEDIATE 事务里读改写 ssh_connections。
//
// appstate.UpdateKV 以 _txlock=immediate 打开连接并在事务内回调 mutate，
// 因此与 Node 的其它写者串行化；mutate 返回错误时整笔回滚。
func (source *Source) UpdateConnections(ctx context.Context, mutate func(current string, found bool) (string, error)) error {
	if source == nil || source.databasePath == "" {
		return ErrSourceUnavailable
	}
	return appstate.UpdateKV(ctx, source.databasePath, connectionsKey, mutate)
}

// DeleteConnectionAndWorkspaces 在同一个 BEGIN IMMEDIATE 事务里读改写
// ssh_connections 与 ssh_workspaces 两行。
//
// 删除连接必须两行一起改：任一步失败都整笔回滚，不能留下「连接没了但
// 工作区还挂着」的中间态。
func (source *Source) DeleteConnectionAndWorkspaces(ctx context.Context, mutate func(connections KV, workspaces KV) (string, string, error)) error {
	return source.withImmediateTx(ctx, func(tx *sql.Tx) error {
		connections, err := readKey(ctx, tx, connectionsKey)
		if err != nil {
			return err
		}
		workspaces, err := readKey(ctx, tx, workspacesKey)
		if err != nil {
			return err
		}
		nextConnections, nextWorkspaces, err := mutate(connections, workspaces)
		if err != nil {
			return err
		}
		updatedAt := time.Now().UnixMilli()
		if _, err := tx.ExecContext(ctx, upsertAppKV, connectionsKey, nextConnections, updatedAt); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, upsertAppKV, workspacesKey, nextWorkspaces, updatedAt); err != nil {
			return err
		}
		return nil
	})
}

// UpdateWorkspacesWithConnections 在同一个 BEGIN IMMEDIATE 事务里读取 ssh_connections 校验关联连接，
// 并原子读改写 ssh_workspaces。
func (source *Source) UpdateWorkspacesWithConnections(ctx context.Context, mutate func(connections KV, workspaces KV) (string, error)) error {
	return source.withImmediateTx(ctx, func(tx *sql.Tx) error {
		connections, err := readKey(ctx, tx, connectionsKey)
		if err != nil {
			return err
		}
		workspaces, err := readKey(ctx, tx, workspacesKey)
		if err != nil {
			return err
		}
		nextWorkspaces, err := mutate(connections, workspaces)
		if err != nil {
			return err
		}
		updatedAt := time.Now().UnixMilli()
		if _, err := tx.ExecContext(ctx, upsertAppKV, workspacesKey, nextWorkspaces, updatedAt); err != nil {
			return err
		}
		return nil
	})
}

func (source *Source) withImmediateTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	if source == nil || source.databasePath == "" {
		return ErrSourceUnavailable
	}
	db, err := sql.Open("sqlite", buildImmediateDSN(source.databasePath))
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if _, err := db.ExecContext(ctx, createAppKVTable); err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

func readKey(ctx context.Context, tx *sql.Tx, key string) (KV, error) {
	var value string
	err := tx.QueryRowContext(ctx, "SELECT value FROM app_kv WHERE key = ?", key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return KV{}, nil
	}
	if err != nil {
		return KV{}, err
	}
	return KV{Value: value, Found: true}, nil
}

func buildImmediateDSN(databasePath string) string {
	fileURL := sqlitefile.URL(databasePath)
	query := fileURL.Query()
	query.Set("mode", "rwc")
	query.Set("_txlock", "immediate")
	query.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", busyTimeoutMS))
	fileURL.RawQuery = query.Encode()
	return fileURL.String()
}
