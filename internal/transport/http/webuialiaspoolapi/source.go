package webuialiaspoolapi

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const aliasPoolKeyPrefix = "account:alias-pool:"

// Source 只读 app-state.db。
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

// LookupProvider 读取账号在 Node 账号台账里的 Provider。
func (source *Source) LookupProvider(ctx context.Context, accountRef string) (string, bool, error) {
	if source == nil {
		return "", false, nil
	}
	return appstate.LookupAccountProvider(ctx, source.databasePath, accountRef)
}

// ReadParticipation 读取 participates；没有记录时默认 true。
func (source *Source) ReadParticipation(ctx context.Context, accountRef string) (bool, error) {
	reference := strings.TrimSpace(accountRef)
	if source == nil || reference == "" {
		return true, nil
	}
	value, found, err := appstate.ReadKV(ctx, source.databasePath, aliasPoolKeyPrefix+reference)
	if err != nil {
		return false, err
	}
	if !found || strings.TrimSpace(value) == "" || strings.TrimSpace(value) == "null" {
		return true, nil
	}
	var config struct {
		Participates *bool `json:"participates"`
	}
	if err := json.Unmarshal([]byte(value), &config); err != nil {
		// 与 Node 的 strict 读取一致：损坏记录是错误，不静默当默认值。
		return false, err
	}
	// Node：raw.participates !== false —— 只有显式 false 才退出；非布尔值按默认参与。
	if config.Participates == nil {
		return true, nil
	}
	return *config.Participates, nil
}
