package webuiserverconfigapi

import (
	"context"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const serverConfigKey = "config:server"

// Source 只读 app-state.db 的 server 配置。
type Source struct {
	databasePath string
}

// OpenSource 创建只读数据源。
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
