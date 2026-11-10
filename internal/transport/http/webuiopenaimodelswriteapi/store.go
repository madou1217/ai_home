package webuiopenaimodelswriteapi

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
)

// ErrStoreUnavailable 表示数据源没有可用的数据库路径。
var ErrStoreUnavailable = errors.New("模型目录设置数据源不可用")

// DatabaseStore 把 app-state.db 路径绑定成 Store。
type DatabaseStore struct {
	DatabasePath string
}

// UpdateSettings 在 BEGIN IMMEDIATE 事务里读改写 model-catalog-settings。
//
// appstate.UpdateKV 以 _txlock=immediate 打开连接并在事务内回调 mutate，
// 因此与 Node 的其它写者串行化；mutate 返回错误时整笔回滚。
// 落盘前统一刷新 version 与 updatedAt，与 modelcatalogsettings.Save 口径一致。
func (store DatabaseStore) UpdateSettings(
	ctx context.Context,
	mutate func(current modelcatalogsettings.Settings) (modelcatalogsettings.Settings, error),
) (modelcatalogsettings.Settings, error) {
	if strings.TrimSpace(store.DatabasePath) == "" {
		return modelcatalogsettings.Settings{}, ErrStoreUnavailable
	}
	var saved modelcatalogsettings.Settings
	err := appstate.UpdateKV(ctx, store.DatabasePath, modelcatalogsettings.DatabaseKey, func(current string, _ bool) (string, error) {
		next, err := mutate(modelcatalogsettings.Normalize(current))
		if err != nil {
			return "", err
		}
		next.Version = modelcatalogsettings.SettingsVersion
		next.UpdatedAtMS = time.Now().UnixMilli()
		payload, err := json.Marshal(next)
		if err != nil {
			return "", err
		}
		saved = next
		return string(payload), nil
	})
	if err != nil {
		return modelcatalogsettings.Settings{}, err
	}
	return saved, nil
}

// deleteTarget 是一次删除请求的匹配条件。
//
// 身份口径与 Node 的 removeAccountModelSetting 对齐：(accountRef, 小写模型 id)；
// provider 只作为附加过滤，缺省或记录为空都表示通配。与 Node 的差别是本包允许
// 不带 accountRef 删除 legacy 记录（Node 的删除入口要求 accountRef）。
type deleteTarget struct {
	modelKey   string
	provider   string
	accountRef string
}

// matchesAccountModel 判断一条账号模型设置是否命中。
func (target deleteTarget) matchesAccountModel(record modelcatalogsettings.AccountModel) bool {
	if strings.ToLower(strings.TrimSpace(record.ID)) != target.modelKey {
		return false
	}
	if target.accountRef != "" && record.AccountRef != target.accountRef {
		return false
	}
	if target.provider == "" || record.Provider == "" {
		return true
	}
	return record.Provider == target.provider
}

// matchesLegacyModel 判断一条无账号归属的旧版记录是否命中。
//
// 指定了 accountRef 时 legacy 记录一律不命中：它是全局记录，不该被按账号的删除带走。
func (target deleteTarget) matchesLegacyModel(record modelcatalogsettings.LegacyModel) bool {
	if target.accountRef != "" {
		return false
	}
	if strings.ToLower(strings.TrimSpace(record.ID)) != target.modelKey {
		return false
	}
	if target.provider == "" || record.Provider == "" {
		return true
	}
	return record.Provider == target.provider
}

// removeModelSettings 从设置文档里删掉全部命中记录，返回剩余文档与删除条数。
//
// 只删设置记录，不动上游发现的模型目录：删除一条自定义设置后，模型是否还能用
// 由探测结果决定，这与 Node 的删除语义一致。
func removeModelSettings(
	settings modelcatalogsettings.Settings,
	target deleteTarget,
) (modelcatalogsettings.Settings, int) {
	removed := 0
	accountModels := make([]modelcatalogsettings.AccountModel, 0, len(settings.AccountModels))
	for _, record := range settings.AccountModels {
		if target.matchesAccountModel(record) {
			removed++
			continue
		}
		accountModels = append(accountModels, record)
	}
	legacyModels := make([]modelcatalogsettings.LegacyModel, 0, len(settings.LegacyModels))
	for _, record := range settings.LegacyModels {
		if target.matchesLegacyModel(record) {
			removed++
			continue
		}
		legacyModels = append(legacyModels, record)
	}
	settings.AccountModels = accountModels
	settings.LegacyModels = legacyModels
	return settings, removed
}
