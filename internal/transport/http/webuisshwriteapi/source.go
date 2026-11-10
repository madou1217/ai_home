package webuisshwriteapi

import (
	"context"
	"errors"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// connectionsKey 是 Node app-state.db 里的 SSH 连接数组。
const connectionsKey = "ssh_connections"

// ErrSourceUnavailable 表示数据源没有可用的数据库路径。
var ErrSourceUnavailable = errors.New("SSH 连接数据源不可用")

// Source 提供 ssh_connections 的写入口。
//
// 只暴露「事务内读改写」这一个能力：调用方拿不到独立读 + 独立写的 API，
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
