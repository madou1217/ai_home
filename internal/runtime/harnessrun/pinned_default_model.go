package harnessrun

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/madou1217/ai_home/application/modelcatalogsettings"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/webuimodelssnapshot"
)

const (
	harnessModelsSnapshotKey  = webuimodelssnapshot.CacheKey
	harnessCatalogSettingsKey = modelcatalogsettings.DatabaseKey
)

// resolvePinnedHarnessDefaultModel 复刻 Node pinned-default-model.js：
// 钉选账号、但没指定模型时，按「该账号配置的默认模型 → 该账号目录第一条」
// 解析出一个该账号确实能路由的模型。
//
// 池级目录第一条常常是 auto 之类的入口，钉选后路由不到；直接用它会得到
// 启动即 503。目录来自服务端持久化的 WebUI 模型快照（byAccount）。
// 读不到、为空或形状不认识时返回空串，适配器维持原有回落。
func resolvePinnedHarnessDefaultModel(
	ctx context.Context,
	aiHomeDir string,
	accountRef string,
) string {
	accountRef = strings.TrimSpace(accountRef)
	if accountRef == "" || strings.TrimSpace(aiHomeDir) == "" {
		return ""
	}
	models := readSnapshotAccountModels(ctx, aiHomeDir, accountRef)
	if len(models) == 0 {
		return ""
	}
	configured := readConfiguredDefaultModel(ctx, aiHomeDir, accountRef)
	if configured != "" && containsString(models, configured) {
		return configured
	}
	return models[0]
}

func readSnapshotAccountModels(ctx context.Context, aiHomeDir string, accountRef string) []string {
	raw, found, err := readHarnessAppStateJSON(ctx, aiHomeDir, harnessModelsSnapshotKey)
	if err != nil || !found {
		return nil
	}
	var snapshot struct {
		ByAccount map[string]json.RawMessage `json:"byAccount"`
	}
	if err := json.Unmarshal(raw, &snapshot); err != nil {
		return nil
	}
	value := snapshot.ByAccount[accountRef]
	if len(value) == 0 {
		return nil
	}
	var items []string
	if err := json.Unmarshal(value, &items); err != nil {
		return nil
	}
	models := make([]string, 0, len(items))
	for _, item := range items {
		if text := strings.TrimSpace(item); text != "" {
			models = append(models, text)
		}
	}
	return models
}

// readConfiguredDefaultModel 在 model-catalog-settings 里找该账号的默认模型。
//
// 与 Node 一致：accountModels（以及带 accountRef 的新式 models 条目）中
// defaultModel=true 且 enabled!==false 的第一条。
func readConfiguredDefaultModel(ctx context.Context, aiHomeDir string, accountRef string) string {
	raw, found, err := readHarnessAppStateJSON(ctx, aiHomeDir, harnessCatalogSettingsKey)
	if err != nil || !found {
		return ""
	}
	var settings struct {
		AccountModels []map[string]any `json:"accountModels"`
		Models        []map[string]any `json:"models"`
	}
	if err := json.Unmarshal(raw, &settings); err != nil {
		return ""
	}
	records := append([]map[string]any{}, settings.AccountModels...)
	records = append(records, settings.Models...)
	for _, record := range records {
		if record == nil {
			continue
		}
		if normalizeTextValue(record["accountRef"]) != accountRef {
			continue
		}
		if record["defaultModel"] != true && record["default"] != true {
			continue
		}
		if record["enabled"] == false {
			continue
		}
		if id := normalizeTextValue(record["id"]); id != "" {
			return id
		}
	}
	return ""
}

func readHarnessAppStateJSON(ctx context.Context, aiHomeDir string, key string) ([]byte, bool, error) {
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil, false, err
	}
	raw, found, err := appstate.ReadKV(ctx, databasePath, key)
	if err != nil || !found || strings.TrimSpace(raw) == "" {
		return nil, false, err
	}
	return []byte(raw), true, nil
}
