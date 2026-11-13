package webuitoolkitenvapi

import (
	"context"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// ConnectionSource 读取 ssh_connections 原文（与 webuisshapi 同一份数据）。
type ConnectionSource interface {
	ReadConnections(ctx context.Context) (string, bool, error)
}

type appStateConnections struct {
	databasePath string
}

func (source appStateConnections) ReadConnections(ctx context.Context) (string, bool, error) {
	if source.databasePath == "" {
		return "", false, nil
	}
	return appstate.ReadKV(ctx, source.databasePath, "ssh_connections")
}

// openConnectionSource 按 AIH 数据根目录打开只读连接表。
func openConnectionSource(aiHomeDir string) (ConnectionSource, error) {
	path, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil, err
	}
	return appStateConnections{databasePath: path}, nil
}
