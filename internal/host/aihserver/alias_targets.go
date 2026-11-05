package aihserver

import (
	"sort"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// groupAliasTargets 把可路由模型按 Provider 聚成「别名目标候选」。
//
// 与 Node 的 /v0/webui/model-aliases/targets 同义：列出每个 Provider 当前真正能接的
// 模型，供前端下拉选择。排序固定（Provider 名升序、模型名升序），否则每次刷新顺序都变，
// 前端列表会跳。
func groupAliasTargets(models []accountapp.RoutableModel) map[string][]string {
	grouped := make(map[string]map[string]struct{})
	for _, model := range models {
		if !model.IsValid() {
			continue
		}
		provider := model.ProviderID()
		modelID := model.ModelID().String()
		if provider == "" || modelID == "" {
			continue
		}
		if grouped[provider] == nil {
			grouped[provider] = make(map[string]struct{})
		}
		grouped[provider][modelID] = struct{}{}
	}
	targets := make(map[string][]string, len(grouped))
	for provider, set := range grouped {
		if len(set) == 0 {
			continue
		}
		models := make([]string, 0, len(set))
		for modelID := range set {
			models = append(models, modelID)
		}
		sort.Strings(models)
		targets[provider] = models
	}
	return targets
}
