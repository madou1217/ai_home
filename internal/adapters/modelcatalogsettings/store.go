package modelcatalogsettings

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// ErrMissingDatabasePath 表示调用方没有给出 app-state.db 路径。
//
// 写路径必须显式失败：空路径交给 sqlite 会静默建出一个无关的库，设置看似保存成功
// 但下次 Load 读不到。
var ErrMissingDatabasePath = errors.New("缺少 app-state.db 路径")

// Load 读取并规范化 model-catalog-settings。
//
// 键缺失、库不存在、JSON 损坏都返回空设置而不是错误，与 Node readModelCatalogSettings
// 的宽松读取一致；真正的 IO 失败仍然返回错误。
func Load(ctx context.Context, databasePath string) (Settings, error) {
	path := strings.TrimSpace(databasePath)
	if path == "" {
		return Normalize(nil), nil
	}
	value, found, err := appstate.ReadKV(ctx, path, DatabaseKey)
	if err != nil {
		return Settings{}, err
	}
	if !found {
		return Normalize(nil), nil
	}
	return Normalize(value), nil
}

// Save 规范化 document、以当前时间刷新 updatedAt 后整份写回，并返回实际落盘的形状。
//
// 与 Node saveModelCatalogSettings 一致：写入的是归一化结果而不是调用方原文，
// 所以坏记录不会被持久化，旧版本号也会被改写成 SettingsVersion。
func Save(ctx context.Context, databasePath string, document any) (Settings, error) {
	path := strings.TrimSpace(databasePath)
	if path == "" {
		return Settings{}, ErrMissingDatabasePath
	}
	nowMS := time.Now().UnixMilli()
	settings := normalizeAt(document, nowMS)
	settings.UpdatedAtMS = nowMS
	payload, err := json.Marshal(settings)
	if err != nil {
		return Settings{}, err
	}
	if err := appstate.WriteKV(ctx, path, DatabaseKey, string(payload), nowMS); err != nil {
		return Settings{}, err
	}
	return settings, nil
}
