package aihserver

import (
	"context"
	"sort"
	"strings"

	"github.com/madou1217/ai_home/application/modelalias"
	"github.com/madou1217/ai_home/application/modelmetadata"
	"github.com/madou1217/ai_home/application/modelsnapshot"
	"github.com/madou1217/ai_home/core/providers"
)

// providerConfigChoices 把账号模型、别名与 Provider 合同的官方模型清单
// 接成关键设置的候选来源。
type providerConfigChoices struct {
	models  modelsnapshot.Reader
	ladders modelmetadata.ReasoningLadderReader
	aliases modelalias.DisplayReader
}

func normalizeChoiceProvider(provider string) string {
	return strings.ToLower(strings.TrimSpace(provider))
}

// ModelIDs 返回该 Provider 当前真实可路由的模型：账号目录 + 已编译别名。
func (choices providerConfigChoices) ModelIDs(ctx context.Context, provider string) []string {
	normalized := normalizeChoiceProvider(provider)
	seen := map[string]struct{}{}
	add := func(id string) {
		id = strings.TrimSpace(id)
		if id != "" {
			seen[id] = struct{}{}
		}
	}
	if choices.models != nil {
		if snapshot, err := choices.models.Read(ctx); err == nil && snapshot != nil {
			for _, id := range snapshot.ByProvider[normalized] {
				add(id)
			}
		}
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
