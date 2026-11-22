package harnessrun

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/madou1217/ai_home/application/modelcatalogsettings"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	harnessCatalogSettingsKey = modelcatalogsettings.DatabaseKey
)

// resolvePinnedHarnessDefaultModel 复刻 Node pinned-default-model.js：
// 钉选账号、但没指定模型时，按「该账号配置的默认模型 → 该账号可用模型第一条」
// 解析出一个该账号确实能路由的模型。
//
// 池级目录第一条常常是 auto 之类的入口，钉选后路由不到；直接用它会得到
// 启动即 503。所以必须取**该账号自己的**模型。
//
// 读不到、为空时返回空串，适配器维持原有回落。
func resolvePinnedHarnessDefaultModel(
	ctx context.Context,
	aiHomeDir string,
	accountRef string,
) string {
	accountRef = strings.TrimSpace(accountRef)
	if accountRef == "" || strings.TrimSpace(aiHomeDir) == "" {
		return ""
	}
	models, err := readAccountRoutableModels(ctx, aiHomeDir, accountRef)
	if err != nil || len(models) == 0 {
		return ""
	}
	configured := readConfiguredDefaultModel(ctx, aiHomeDir, accountRef)
	if configured != "" && containsString(models, configured) {
		return configured
	}
	return models[0]
}

// readAccountRoutableModels 读取该账号当前**真正可路由**的模型，按 model_id 排序。
//
// 来源是 account_models，不是 app_kv 的 cache:webui-models-snapshot.json。
// 后者是 Node 时代遗留的缓存键：Go 侧只有 reader 没有 writer，实测停更两天，
// 且 31 个账号里有 6 个的首条模型已被上游移除（balanced-model、
// cline-pass/deepseek-v4-pro 等，实测请求返回 403/422）。拿它当默认模型会让
// 这些账号一钉选就启动失败。
//
// 过滤条件与网关路由一致：账号启用 + 行有效（inherit 需上游可用，或人工 force_enable）。
// 被人工 force_disable 的模型即使上游可用也不返回。
func readAccountRoutableModels(ctx context.Context, aiHomeDir, accountRef string) ([]string, error) {
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil, err
	}
	database, err := appstate.OpenReadOnly(ctx, databasePath)
	if err != nil {
		return nil, err
	}
	defer func() { _ = database.Close() }()
	rows, err := database.QueryContext(ctx, `
		SELECT m.model_id AS model_id
		  FROM account_models m
		  JOIN accounts a ON a.account_ref = m.account_ref
		 WHERE m.account_ref = ?
		   AND a.enabled = 1
		   AND m.manual_policy <> 'force_disable'
		   AND (m.manual_policy = 'force_enable' OR m.upstream_available = 1)
		 ORDER BY m.model_id`, accountRef)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	models := make([]string, 0, 32)
	for rows.Next() {
		var modelID string
		if scanErr := rows.Scan(&modelID); scanErr != nil {
			continue
		}
		if trimmed := strings.TrimSpace(modelID); trimmed != "" {
			models = append(models, trimmed)
		}
	}
	return models, rows.Err()
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
