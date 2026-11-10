package webuiusageconfigapi

import (
	"context"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const usageConfigKey = "config:usage"

// Source 只读 app-state.db 的用量配置。
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

// ReadUsageConfig 返回 config:usage 的原始 JSON；没有记录时 found=false。
func (source *Source) ReadUsageConfig(ctx context.Context) (string, bool, error) {
	if source == nil {
		return "", false, nil
	}
	return appstate.ReadKV(ctx, source.databasePath, usageConfigKey)
}

// WriteUsageConfig 以规范化后的整份配置 upsert config:usage。
func (source *Source) WriteUsageConfig(ctx context.Context, value string) error {
	if source == nil {
		return nil
	}
	return appstate.WriteKV(ctx, source.databasePath, usageConfigKey, value, time.Now().UnixMilli())
}
