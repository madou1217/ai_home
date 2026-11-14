package webuiroutingweightsapi

import (
	"regexp"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	agymodelnames "github.com/madou1217/ai_home/internal/adapters/agy/modelnames"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
)

const (
	catalogStatusComplete   = "complete"
	catalogStatusFiltered   = "filtered"
	catalogStatusUnchecked  = "unchecked"
	reasonModelNotInCatalog = "model_not_in_catalog"
)

var (
	modelVersionSeparatorPattern = regexp.MustCompile(`(\d)\.(\d)`)
	grokImageModelPattern        = regexp.MustCompile(`^grok-(?:imagine-)?image(?:[-._].+)?$`)
	geminiImageModelPattern      = regexp.MustCompile(`^(?:google/)?gemini[-_/].*image(?:[-._].*)?$`)
	nanoBananaModelPattern       = regexp.MustCompile(`nano-?banana`)
)

type catalogNarrowingResult struct {
	status          string
	excludedReasons map[string]string
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

	// 4. agy 模型级额度窗口门禁（applyModelWindowGate）。
	if provider == "agy" {
		for _, account := range pool {
			ref := strings.TrimSpace(account.AccountRef)
			if excluded[ref] != "" {
				continue
			}
			if agyModelWindowExhausted(account.UsageSnapshot, model, nowMS) {
				excluded[ref] = reasonModelNotInCatalog
				status = catalogStatusFiltered
			}
		}
	}

	return catalogNarrowingResult{
		status:          status,
		excludedReasons: excluded,
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
			policy := item.ManualPolicy()
			if policy == accountapp.ModelPolicyForceDisable {
				continue
			}
			if item.UpstreamAvailable() || policy == accountapp.ModelPolicyForceEnable {
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

// modelIdsMatch 与 Node lib/server/model-id.js 保持同一语义：精确小写或版本号分隔符（4.6 ↔ 4-6）匹配。
func modelIdsMatch(left, right string) bool {
	leftKeys := modelLookupKeys(left)
	if len(leftKeys) == 0 {
		return false
	}
	rightKeys := modelLookupKeys(right)
	for _, leftKey := range leftKeys {
		for _, rightKey := range rightKeys {
			if leftKey == rightKey {
				return true
			}
		}
	}
	return false
}

func modelLookupKeys(raw string) []string {
	exact := strings.ToLower(strings.TrimSpace(raw))
	if exact == "" {
		return nil
	}
	normalized := normalizeModelVersionSeparators(exact)
	if normalized == exact || normalized == "" {
		return []string{exact}
	}
	return []string{exact, normalized}
}

func normalizeModelVersionSeparators(value string) string {
	current := strings.TrimSpace(value)
	for {
		next := modelVersionSeparatorPattern.ReplaceAllString(current, "${1}-${2}")
		if next == current {
			return next
		}
		current = next
	}
}

// imageModelBelongsToProvider 与 Node imageModelBelongsToProvider 一致。
func imageModelBelongsToProvider(provider, model string) bool {
	normalizedProvider := strings.ToLower(strings.TrimSpace(provider))
	normalizedModel := strings.ToLower(strings.TrimSpace(model))
	if normalizedModel == "" {
		return false
	}
	switch normalizedProvider {
	case "codex":
		return normalizedModel == "gpt-image-2"
	case "grok":
		return grokImageModelPattern.MatchString(normalizedModel)
	case "agy", "gemini":
		return geminiImageModelPattern.MatchString(normalizedModel) || nanoBananaModelPattern.MatchString(normalizedModel)
	default:
		return false
	}
}

// agyModelWindowExhausted 与 Node lib/server/model-window-gates.js 一致：
// 快照需在 10 分钟新鲜度内；条目 remainingPct <= 0 且重置时间未到视为窗口耗尽。
func agyModelWindowExhausted(snapshot map[string]any, model string, nowMS int64) bool {
	if len(snapshot) == 0 {
		return false
	}
	capturedAt := int64(numberFromAny(snapshot["capturedAt"]))
	if capturedAt <= 0 || (nowMS-capturedAt) > agyMaxSnapshotAgeMS {
		return false
	}
	entry := findSnapshotModelEntry(snapshot, model)
	if entry == nil {
		return false
	}
	remaining, ok := optionalNumberFromAny(entry["remainingPct"])
	if !ok || remaining > 0 {
		return false
	}
	resetAtMS := int64(numberFromAny(entry["resetAtMs"]))
	if resetAtMS > 0 && resetAtMS <= nowMS {
		return false
	}
	return true
}

func findSnapshotModelEntry(snapshot map[string]any, model string) map[string]any {
	wanted := strings.TrimSpace(model)
	wantedCLI := agymodelnames.Resolve(wanted)
	switch rawModels := snapshot["models"].(type) {
	case []map[string]any:
		for _, entry := range rawModels {
			if snapshotModelEntryMatches(entry, wanted, wantedCLI) {
				return entry
			}
		}
	case []any:
		for _, item := range rawModels {
			entry, ok := item.(map[string]any)
			if ok && snapshotModelEntryMatches(entry, wanted, wantedCLI) {
				return entry
			}
		}
	}
	return nil
}

func snapshotModelEntryMatches(entry map[string]any, wanted, wantedCLI string) bool {
	if entry == nil {
		return false
	}
	id, _ := entry["model"].(string)
	id = strings.TrimSpace(id)
	if id == "" {
		return false
	}
	if id == wanted {
		return true
	}
	return wantedCLI != "" && agymodelnames.Resolve(id) == wantedCLI
}

func optionalNumberFromAny(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case jsonNumber:
		parsed, err := typed.Float64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

type jsonNumber interface {
	Float64() (float64, error)
}

func numberFromAny(value any) float64 {
	number, ok := optionalNumberFromAny(value)
	if !ok {
		return 0
	}
	return number
}
