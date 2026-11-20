package webuiroutingweightsapi

import (
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelcatalogsettings"
	"github.com/madou1217/ai_home/application/modelmetadata"
	"github.com/madou1217/ai_home/application/usagewindow"
)

const (
	catalogStatusComplete   = "complete"
	catalogStatusFiltered   = "filtered"
	catalogStatusUnchecked  = "unchecked"
	reasonModelNotInCatalog = "model_not_in_catalog"
)

type catalogNarrowingResult struct {
	status          string
	excludedReasons map[string]string
	// facts 是逐账号的目录事实，交给 Provider 策略判定；收窄结论不再由本层短路。
	facts map[string]catalogFacts
}

// catalogFacts 是单个账号对该模型的目录事实。
type catalogFacts struct {
	// Known 表示该账号有可信且完整的模型目录。
	Known bool
	// InCatalog 表示目录里确实有这个模型。
	InCatalog bool
	// Excluded 表示显式停用或收窄已判定该 (账号,模型) 不参与调度。
	Excluded bool
	// Reason 是收窄给出的原因码。
	Reason string
}

type accountModelInventory struct {
	allByRef       map[string][]accountapp.AccountModel
	effectiveByRef map[string][]string
	incomplete     map[string]bool
}

// narrowCatalog 复刻 Node selectPoolAccountsForModel + applyModelWindowGate 的收窄语义：
//  1. WebUI / SQLite 显式停用的 (账号, 模型) 直接标记 model_not_in_catalog；
//  2. 目录完整且明确不含该模型的账号标记 model_not_in_catalog（原生生图模型与残缺目录豁免）；
//  3. 若已有部分账号确认支持该模型，则收窄至支持账号，其余未支持/未探测账号标记 model_not_in_catalog；
//     若全部账号都支持，catalog="complete"；若无账号拥有目录且无人被排除，catalog="unchecked"；
//  4. agy 对 10 分钟内新鲜快照中剩余额度 ≤0 且未重置的模型窗口标记 model_not_in_catalog。
func narrowCatalog(
	pool []PoolAccount,
	provider string,
	model string,
	catalog accountapp.AccountModelCatalog,
	hasCatalog bool,
	settings modelcatalogsettings.Settings,
	hasSettings bool,
	windowGate usagewindow.Gate,
	nowMS int64,
) catalogNarrowingResult {
	excluded := make(map[string]string)
	inventory := buildAccountModelInventory(catalog, hasCatalog)
	isImageModel := imageModelBelongsToProvider(provider, model)

	// 1. 强否定：显式停用（model-catalog-settings 或 account_models.manual_policy=force_disable）。
	for _, account := range pool {
		ref := strings.TrimSpace(account.AccountRef)
		if !isAccountModelEnabled(settings, hasSettings, inventory.allByRef[ref], provider, ref, model) {
			excluded[ref] = reasonModelNotInCatalog
		}
	}

	// 2. 强证据排除（excludeAccountsWithoutModel）：完整且非空目录里明确没有该模型。
	for _, account := range pool {
		ref := strings.TrimSpace(account.AccountRef)
		if excluded[ref] != "" {
			continue
		}
		models := inventory.effectiveByRef[ref]
		if isImageModel || inventory.incomplete[ref] || len(models) == 0 {
			continue
		}
		if !catalogHasModel(models, model) {
			excluded[ref] = reasonModelNotInCatalog
		}
	}

	// 3. 正向目录收窄与 complete / filtered / unchecked 判定。
	surviving := make([]PoolAccount, 0, len(pool))
	for _, account := range pool {
		ref := strings.TrimSpace(account.AccountRef)
		if excluded[ref] == "" {
			surviving = append(surviving, account)
		}
	}

	status := catalogStatusUnchecked
	if len(surviving) == 0 {
		status = catalogStatusFiltered
	} else {
		matchedRefs := make(map[string]bool, len(surviving))
		for _, account := range surviving {
			ref := strings.TrimSpace(account.AccountRef)
			if isImageModel || catalogHasModel(inventory.effectiveByRef[ref], model) {
				matchedRefs[ref] = true
			}
		}
		switch {
		case len(matchedRefs) > 0:
			for _, account := range surviving {
				ref := strings.TrimSpace(account.AccountRef)
				if !matchedRefs[ref] {
					excluded[ref] = reasonModelNotInCatalog
				}
			}
			if len(excluded) > 0 {
				status = catalogStatusFiltered
			} else {
				status = catalogStatusComplete
			}
		case len(excluded) > 0:
			status = catalogStatusFiltered
		default:
			status = catalogStatusUnchecked
		}
	}

	// 4. 厂商额度窗口门禁（applyModelWindowGate）：策略由 Provider 注册表提供，
	//    本层只问结果，不认识任何厂商快照字段。
	if windowGate != nil {
		for _, account := range pool {
			ref := strings.TrimSpace(account.AccountRef)
			if excluded[ref] != "" {
				continue
			}
			if windowGate.Exhausted(provider, account.UsageSnapshot, model, nowMS) {
				excluded[ref] = reasonModelNotInCatalog
				status = catalogStatusFiltered
			}
		}
	}

	facts := make(map[string]catalogFacts, len(pool))
	for _, account := range pool {
		ref := strings.TrimSpace(account.AccountRef)
		models := inventory.effectiveByRef[ref]
		known := !isImageModel && !inventory.incomplete[ref] && len(models) > 0
		facts[ref] = catalogFacts{
			Known:     known,
			InCatalog: known && catalogHasModel(models, model),
			Excluded:  strings.TrimSpace(excluded[ref]) != "",
			Reason:    excluded[ref],
		}
	}

	return catalogNarrowingResult{
		status:          status,
		excludedReasons: excluded,
		facts:           facts,
	}
}

func buildAccountModelInventory(catalog accountapp.AccountModelCatalog, hasCatalog bool) accountModelInventory {
	inventory := accountModelInventory{
		allByRef:       make(map[string][]accountapp.AccountModel),
		effectiveByRef: make(map[string][]string),
		incomplete:     make(map[string]bool),
	}
	if !hasCatalog {
		return inventory
	}
	for _, set := range catalog.Sets {
		ref := strings.TrimSpace(set.AccountRef.String())
		if ref == "" {
			continue
		}
		inventory.allByRef[ref] = set.Models
		if strings.TrimSpace(set.LastErrorCode) != "" {
			inventory.incomplete[ref] = true
		}
		effective := make([]string, 0, len(set.Models))
		for _, item := range set.Models {
			// 有效集判定与 WebUI 可选集同源，只在 application 层定义一次。
			selection := accountapp.ModelSelection{
				UpstreamAvailable: item.UpstreamAvailable(),
				ManualPolicy:      item.ManualPolicy(),
			}
			if selection.Selectable() {
				effective = append(effective, item.ModelID().String())
			}
		}
		inventory.effectiveByRef[ref] = effective
	}
	return inventory
}

// isAccountModelEnabled 按 Node model-catalog-settings-store + SQLite manual_policy 判断模型是否启用。
func isAccountModelEnabled(
	settings modelcatalogsettings.Settings,
	hasSettings bool,
	sqliteModels []accountapp.AccountModel,
	provider string,
	accountRef string,
	model string,
) bool {
	if hasSettings {
		targetModelKey := strings.ToLower(strings.TrimSpace(model))
		targetProvider := strings.ToLower(strings.TrimSpace(provider))
		for _, item := range settings.AccountModels {
			if strings.TrimSpace(item.AccountRef) != accountRef {
				continue
			}
			if targetProvider != "" && !strings.EqualFold(strings.TrimSpace(item.Provider), targetProvider) {
				continue
			}
			if strings.ToLower(strings.TrimSpace(item.ID)) == targetModelKey {
				return item.Enabled
			}
		}
		for _, item := range settings.LegacyModels {
			if targetProvider != "" && !strings.EqualFold(strings.TrimSpace(item.Provider), targetProvider) {
				continue
			}
			if strings.ToLower(strings.TrimSpace(item.ID)) == targetModelKey {
				return item.Enabled
			}
		}
	}
	for _, item := range sqliteModels {
		if modelIdsMatch(item.ModelID().String(), model) && item.ManualPolicy() == accountapp.ModelPolicyForceDisable {
			return false
		}
	}
	return true
}

func catalogHasModel(models []string, target string) bool {
	for _, modelID := range models {
		if modelIdsMatch(modelID, target) {
			return true
		}
	}
	return false
}

// modelIdsMatch 与 Node lib/server/model-id.js 同语义：只在 application/modelmetadata 定义一次。
func modelIdsMatch(left, right string) bool {
	return modelmetadata.MatchModelIDs(left, right)
}

// imageModelBelongsToProvider 与 Node imageModelBelongsToProvider 一致。
//
// 厂商形态事实只在 application/modelmetadata 定义一次，本层不做 provider 分支。
func imageModelBelongsToProvider(provider, model string) bool {
	return modelmetadata.ProviderOwnsImageModel(provider, model)
}
