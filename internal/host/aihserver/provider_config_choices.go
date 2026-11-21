package aihserver

import (
	"context"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/application/modelalias"
	"github.com/madou1217/ai_home/application/modelmetadata"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

// providerConfigChoices 把账号模型、别名与 Provider 合同的官方模型清单
// 接成关键设置的候选来源。
type providerConfigChoices struct {
	// aiHomeDir 是账号库所在的数据根。ModelIDs 直接查 account_models，
	// 不读 app_kv 的模型快照缓存（见 ModelIDs 的说明）。
	aiHomeDir string
	ladders   modelmetadata.ReasoningLadderReader
	aliases   modelalias.DisplayReader
}

func normalizeChoiceProvider(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}

// ModelIDs 返回该 Provider 当前真实可路由的模型：账号目录 + 已编译别名。
//
// 数据源是 account_models 的有效行，与网关路由的过滤条件一致。
//
// 曾经这里读 modelsnapshot.Reader（app_kv 的 cache:webui-models-snapshot.json）。
// 那是 Node 时代遗留的缓存键：Go 侧只有 reader、没有 writer，本机那份停更两天。
// 后果不是显示偏差而是判断颠倒——调用方拿 ModelIDs 与 CatalogModelIDs 求差集，
// 差出来的模型被标记为「无账号/不可用」。实测旧数据会让 203 个已失效模型被当作
// 「真实可路由」返回（codex 一家 181 个；qoder 快照称 15 个、真值是 0 个），
// 于是用户看到的可用性判断正好相反。
func (choices providerConfigChoices) ModelIDs(ctx context.Context, provider string) []string {
	normalized := normalizeChoiceProvider(provider)
	seen := map[string]struct{}{}
	add := func(id string) {
		id = strings.TrimSpace(id)
		if id != "" {
			seen[id] = struct{}{}
		}
	}
	for _, id := range readProviderRoutableModels(ctx, choices.aiHomeDir, normalized) {
		add(id)
	}
	// ListDisplayModels 只包含已通过目录编译的别名：它们能解析到账号，属于可用。
	if choices.aliases != nil {
		for _, model := range choices.aliases.ListDisplayModels() {
			if normalizeChoiceProvider(model.Provider) == normalized {
				add(model.Alias)
			}
		}
	}
	ids := make([]string, 0, len(seen))
	for id := range seen {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// readProviderRoutableModels 读取该 Provider 下所有启用账号的有效模型。
//
// 过滤条件与网关路由保持同一语义：账号启用、行未被人工停用，且上游确实
// 提供该模型（或人工强制启用）。读取失败一律返回空——宁可少给候选，
// 也不要把无法路由的模型当成可用。
func readProviderRoutableModels(ctx context.Context, aiHomeDir, provider string) []string {
	if strings.TrimSpace(aiHomeDir) == "" || provider == "" {
		return nil
	}
	databasePath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return nil
	}
	database, err := appstate.OpenReadOnly(ctx, databasePath)
	if err != nil {
		return nil
	}
	defer func() { _ = database.Close() }()
	rows, err := database.QueryContext(ctx, `
		SELECT DISTINCT m.model_id AS model_id
		  FROM account_models m
		  JOIN accounts a ON a.account_ref = m.account_ref
		 WHERE a.provider_id = ?
		   AND a.enabled = 1
		   AND m.manual_policy <> 'force_disable'
		   AND (m.manual_policy = 'force_enable' OR m.upstream_available = 1)
		 ORDER BY m.model_id`, provider)
	if err != nil {
		return nil
	}
	defer func() { _ = rows.Close() }()
	models := make([]string, 0, 64)
	for rows.Next() {
		var modelID string
		if scanErr := rows.Scan(&modelID); scanErr != nil {
			continue
		}
		if trimmed := strings.TrimSpace(modelID); trimmed != "" {
			models = append(models, trimmed)
		}
	}
	return models
}

// CatalogModelIDs 返回 Provider 合同声明的官方 CLI 支持模型。
//
// 这些模型可能当前没有账号（例如 Claude 账号只接了 DeepSeek），但仍是
// 合法的配置取值；WebUI 会把它们与可用模型合并并标记“无账号”。
func (choices providerConfigChoices) CatalogModelIDs(_ context.Context, provider string) []string {
	catalog, found := providers.OfficialModels(provider)
	if !found {
		return nil
	}
	return catalog.Models
}

// ReasoningEfforts 返回该模型目录声明的推理强度档位。
func (choices providerConfigChoices) ReasoningEfforts(provider string, model string) []string {
	if choices.ladders == nil || strings.TrimSpace(model) == "" {
		return nil
	}
	ladder, found := choices.ladders.LookupReasoningEfforts(
		normalizeChoiceProvider(provider),
		strings.TrimSpace(model),
	)
	if !found || len(ladder) == 0 {
		return nil
	}
	values := make([]string, 0, len(ladder))
	for _, effort := range ladder {
		values = append(values, string(effort))
	}
	return values
}
