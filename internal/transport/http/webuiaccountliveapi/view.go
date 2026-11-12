package webuiaccountliveapi

import (
	"encoding/json"
	"sort"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/core/usageledger"
)

// buildCapabilityMap 复刻 Node 的 buildProviderNativeCapabilityMap：
// 只收录声明了 nativeBoundary 的 Provider，值是该边界对象本身。
func buildCapabilityMap(catalog *providers.Catalog) map[string]json.RawMessage {
	out := make(map[string]json.RawMessage)
	if catalog == nil {
		return out
	}
	for _, definition := range catalog.List() {
		if definition.NativeBoundary == nil {
			continue
		}
		payload, err := json.Marshal(struct {
			Provider string `json:"provider"`
			*providers.NativeCapability
		}{Provider: definition.ID, NativeCapability: definition.NativeBoundary})
		if err != nil {
			continue
		}
		out[definition.ID] = json.RawMessage(payload)
	}
	return out
}

// tokenUsageView 与 Node 账号行的 tokenUsage 同形。
//
// 成本字段恒为 null：Go 账本只存 token 事实，没有逐次调用的 cost_usd；
// 把未知成本写成 0 会让页面显示「花了 0 元」。
type tokenUsageView struct {
	Day    uint64                `json:"day"`
	Week   uint64                `json:"week"`
	Month  uint64                `json:"month"`
	Total  uint64                `json:"total"`
	Models []tokenUsageModelView `json:"models"`
}

type tokenUsageModelView struct {
	Model        string   `json:"model"`
	Day          uint64   `json:"day"`
	Week         uint64   `json:"week"`
	Month        uint64   `json:"month"`
	Total        uint64   `json:"total"`
	DayCostUSD   *float64 `json:"dayCostUsd"`
	WeekCostUSD  *float64 `json:"weekCostUsd"`
	MonthCostUSD *float64 `json:"monthCostUsd"`
	TotalCostUSD *float64 `json:"totalCostUsd"`
}

// newTokenUsageView 过滤全零模型并按总量倒序——与 Node 的
// normalizeAccountTokenUsageValue 同一展示口径。
func newTokenUsageView(usage usageledger.AccountTokenUsage) *tokenUsageView {
	models := make([]tokenUsageModelView, 0, len(usage.Models))
	for _, model := range usage.Models {
		if model.Model == "" || (model.Day == 0 && model.Week == 0 && model.Month == 0 && model.Total == 0) {
			continue
		}
		models = append(models, tokenUsageModelView{
			Model: model.Model, Day: model.Day, Week: model.Week,
			Month: model.Month, Total: model.Total,
		})
	}
	sort.SliceStable(models, func(left, right int) bool {
		if models[left].Total != models[right].Total {
			return models[left].Total > models[right].Total
		}
		return models[left].Model < models[right].Model
	})
	return &tokenUsageView{
		Day: usage.Day, Week: usage.Week, Month: usage.Month, Total: usage.Total,
		Models: models,
	}
}
