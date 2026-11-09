package webuisshapi

import (
	"context"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	connectionsKey = "ssh_connections"
	workspacesKey  = "ssh_workspaces"
)

// Source 只读 app-state.db 的 SSH 连接表。
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

// ReadConnections 返回 ssh_connections 的原始 JSON；没有记录时 found=false。
func (source *Source) ReadConnections(ctx context.Context) (string, bool, error) {
	if source == nil {
		return "", false, nil
	}
	return appstate.ReadKV(ctx, source.databasePath, connectionsKey)
}

// ReadWorkspaces 返回 ssh_workspaces 的原始 JSON；没有记录时 found=false。
func (source *Source) ReadWorkspaces(ctx context.Context) (string, bool, error) {
	if source == nil {
		return "", false, nil
	}
	return appstate.ReadKV(ctx, source.databasePath, workspacesKey)
}
