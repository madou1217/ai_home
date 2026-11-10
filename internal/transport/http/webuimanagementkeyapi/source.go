package webuimanagementkeyapi

import (
	"context"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// Source 读写 app-state.db 的 config:server。
//
// 轮换必须走 UpdateServerConfig（立即事务读改写）：普通的「先读再整份写」会把并发
// 设置保存刚写的字段覆盖回旧值，Node 侧用 BEGIN IMMEDIATE 防的就是这件事。
type Source struct {
	databasePath string
}

// OpenSource 创建 app-state 数据源。
func OpenSource(aiHomeDir string) (*Source, error) {
	path, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil, err
	}
	return &Source{databasePath: path}, nil
}

// ReadServerConfig 返回 config:server 的原始 JSON；没有记录时 found=false。
func (source *Source) ReadServerConfig(ctx context.Context) (string, bool, error) {
	if source == nil {
		return "", false, nil
	}
	return appstate.ReadKV(ctx, source.databasePath, serverConfigKey)
}

// UpdateServerConfig 在立即事务里读改写 config:server。
func (source *Source) UpdateServerConfig(ctx context.Context, mutate func(current string, found bool) (string, error)) error {
	if source == nil {
		return nil
	}
	return appstate.UpdateKV(ctx, source.databasePath, serverConfigKey, mutate)
}
