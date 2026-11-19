package webuiclaudepreflightapi

import (
	"context"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// Source 读写 app-state 的首屏检查策略。
type Source struct {
	databasePath string
}

// OpenSource 创建数据源。
func OpenSource(aiHomeDir string) (*Source, error) {
	path, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil, err
	}
	return &Source{databasePath: path}, nil
}

// ReadClaudePreflight 返回原始 JSON；没有记录时 found=false。
func (source *Source) ReadClaudePreflight(ctx context.Context) (string, bool, error) {
	if source == nil {
		return "", false, nil
	}
	return appstate.ReadKV(ctx, source.databasePath, "config:claude-preflight")
}

// WriteClaudePreflight 整份 upsert 策略记录。
func (source *Source) WriteClaudePreflight(ctx context.Context, value string) error {
	if source == nil {
		return nil
	}
	return appstate.WriteKV(ctx, source.databasePath, "config:claude-preflight", value, time.Now().UnixMilli())
}
