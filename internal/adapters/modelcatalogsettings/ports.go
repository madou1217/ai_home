package modelcatalogsettings

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// Reader 从 aih.db 读取 model-catalog-settings 的只读端口实现。
type Reader struct {
	DatabasePath string
}

// ReadSettings 读取并归一设置文档。
func (reader Reader) ReadSettings(ctx context.Context) (Settings, error) {
	return Load(ctx, reader.DatabasePath)
}

// Store 以 aih.db 路径实现设置读写端口。
type Store struct {
	DatabasePath string
}

// Load 读取并归一当前设置。
func (store Store) Load(ctx context.Context) (Settings, error) {
	return Load(ctx, store.DatabasePath)
}

// Update 在 BEGIN IMMEDIATE 事务中原子更新设置文档。
func (store Store) Update(
	ctx context.Context,
	mutate func(current Settings) (Settings, error),
) (Settings, error) {
	path := strings.TrimSpace(store.DatabasePath)
	if path == "" {
		return Settings{}, ErrMissingDatabasePath
	}
	var saved Settings
	err := appstate.UpdateKV(ctx, path, DatabaseKey, func(current string, _ bool) (string, error) {
		next, mutateErr := mutate(Normalize(current))
		if mutateErr != nil {
			return "", mutateErr
		}
		next.Version = SettingsVersion
		next.UpdatedAtMS = time.Now().UnixMilli()
		encoded, marshalErr := json.Marshal(next)
		if marshalErr != nil {
			return "", marshalErr
		}
		saved = next
		return string(encoded), nil
	})
	if err != nil {
		return Settings{}, err
	}
	return saved, nil
}
