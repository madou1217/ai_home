package translation

import (
	"context"
	"sort"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelalias"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
)

// AccountOverviewLister 提供本地账号概览只读端口。
type AccountOverviewLister interface {
	ListAccountOverviews(ctx context.Context) ([]accountapp.AccountOverview, error)
}

// AccountModelLister 提供全部账号的模型目录只读端口。
type AccountModelLister interface {
	ListAllAccountModels(ctx context.Context) (accountapp.AccountModelCatalog, error)
}

// ModelAliasLister 提供模型别名记录只读端口。
type ModelAliasLister interface {
	ListModelAliases(ctx context.Context) ([]modelalias.Record, int64, error)
}

// RoutingExclusionReader 提供不参与通用路由的账号排除集合。
type RoutingExclusionReader interface {
	LoadRoutingExclusions(ctx context.Context) (map[string]bool, error)
}

// EligibilityChecker 提供账号与模型二元组的运行态调度资格判定。
type EligibilityChecker interface {
	CheckEligibility(ctx context.Context, route runtimecore.ModelRoute) (runtimecore.Eligibility, error)
}

// CatalogDependencies 聚合构建翻译模型目录所需的全部只读依赖。
type CatalogDependencies struct {
	Accounts      AccountOverviewLister
	AccountModels AccountModelLister
	Aliases       ModelAliasLister
	Exclusions    RoutingExclusionReader
	Runtime       EligibilityChecker
	Providers     *providers.Catalog
	Modalities    *modelsdev.Index
	DatabasePath  string
}

// ModelEntry 描述翻译可选模型目录中的一条模型项。
type ModelEntry struct {
	ID                    string `json:"id"`
	Provider              string `json:"provider"`
	ProviderLabel         string `json:"providerLabel"`
	Source                string `json:"source"`
	Origin                string `json:"origin"`
	AvailableAccountCount int    `json:"availableAccountCount"`
}

// ModelCatalog 描述翻译可用模型目录及其自动推荐默认值。
type ModelCatalog struct {
	Models          []ModelEntry `json:"models"`
	DefaultModel    string       `json:"defaultModel"`
	DefaultProvider string       `json:"defaultProvider"`
}

// InferModelFamilyProvider 按命名空间前缀与模型家族猜测默认供应商。
func InferModelFamilyProvider(modelID string) string {
	normalized := strings.ToLower(strings.TrimSpace(modelID))
	if normalized == "" {
		return ""
	}
	if strings.HasPrefix(normalized, "cline-pass/") {
		return "cline"
	}
	if strings.HasPrefix(normalized, "opencode-go/") ||
		strings.HasPrefix(normalized, "opencode/") ||
		strings.HasPrefix(normalized, "opencode-") {
		return "opencode"
	}
	if strings.HasPrefix(normalized, "agy") || strings.HasPrefix(normalized, "antigravity") {
		return "agy"
	}
	if strings.HasPrefix(normalized, "kiro") || strings.HasPrefix(normalized, "kr/") {
		return "kiro"
	}
	if strings.HasPrefix(normalized, "gemini") {
		return "agy"
	}
	if strings.HasPrefix(normalized, "grok") {
		return "grok"
	}
	if strings.HasPrefix(normalized, "glm") || strings.HasPrefix(normalized, "zcode") {
		return "zcode"
	}
	if strings.HasPrefix(normalized, "claude") || strings.HasPrefix(normalized, "anthropic") {
		return "claude"
	}
	if strings.HasPrefix(normalized, "gpt") ||
		strings.HasPrefix(normalized, "o1") ||
		strings.HasPrefix(normalized, "o3") ||
		strings.HasPrefix(normalized, "o4") {
		return "codex"
	}
	return ""
}

// TranslationDefaultScore 计算翻译默认模型推荐得分：优先非思考、快响应 flash 模型，抑制生图模型。
func TranslationDefaultScore(modelID string) int {
	id := strings.ToLower(strings.TrimSpace(modelID))
	score := 0
	if strings.Contains(id, "thinking") {
		score -= 200
	}
	if strings.Contains(id, "pro") {
		score -= 50
	}
	if strings.Contains(id, "image") {
		score -= 500
	}
	if strings.Contains(id, "flash") {
		score += 100
	}
	if strings.Contains(id, "lite") {
		score += 10
	}
	switch id {
	case "gemini-2.5-flash":
		score += 30
	case "gemini-3-flash":
		score += 20
	}
	return score
}

func providerDisplayLabel(catalog *providers.Catalog, providerID string) string {
	normalized := strings.ToLower(strings.TrimSpace(providerID))
	if normalized == "" {
		return "别名"
	}
	if catalog != nil {
		if def, ok := catalog.Get(normalized); ok && strings.TrimSpace(def.Presentation.Label) != "" {
			return strings.TrimSpace(def.Presentation.Label)
		}
	}
	return normalized
}

func modelGeneratesImages(modalities *modelsdev.Index, providerID string, modelID string) bool {
	if modalities != nil {
		if m, found := modalities.LookupOrInferModalities(providerID, modelID); found {
			for _, out := range m.Output() {
				if strings.EqualFold(out, "image") {
					return true
				}
			}
			return false
		}
	}
	lower := strings.ToLower(strings.TrimSpace(modelID))
	return strings.Contains(lower, "gpt-image") ||
		strings.Contains(lower, "dall-e") ||
		strings.Contains(lower, "grok-imagine") ||
		strings.HasSuffix(lower, "-image") ||
		strings.Contains(lower, "-image-")
}

type accountSettingsIndex struct {
	accountDisabled map[string]bool
	legacyDisabled  map[string]bool
}

func buildSettingsIndex(ctx context.Context, dbPath string) accountSettingsIndex {
	idx := accountSettingsIndex{
		accountDisabled: map[string]bool{},
		legacyDisabled:  map[string]bool{},
	}
	if strings.TrimSpace(dbPath) == "" {
		return idx
	}
	loaded, err := modelcatalogsettings.Load(ctx, dbPath)
	if err != nil {
		return idx
	}
	for _, rec := range loaded.AccountModels {
		if !rec.Enabled {
			idx.accountDisabled[strings.TrimSpace(rec.AccountRef)+"\x00"+strings.ToLower(strings.TrimSpace(rec.ID))] = true
		}
	}
	for _, rec := range loaded.LegacyModels {
		if !rec.Enabled {
			idx.legacyDisabled[strings.ToLower(strings.TrimSpace(rec.Provider))+"\x00"+strings.ToLower(strings.TrimSpace(rec.ID))] = true
		}
	}
	return idx
}

func (idx accountSettingsIndex) isDisabled(accountRef string, providerID string, modelID string) bool {
	lowerModel := strings.ToLower(strings.TrimSpace(modelID))
	if idx.accountDisabled[strings.TrimSpace(accountRef)+"\x00"+lowerModel] {
		return true
	}
	return idx.legacyDisabled[strings.ToLower(strings.TrimSpace(providerID))+"\x00"+lowerModel]
}

// BuildTranslationModelCatalog 装配翻译页可选模型目录与可用账号计数。
func BuildTranslationModelCatalog(
	ctx context.Context,
	deps CatalogDependencies,
	saved *Settings,
) (ModelCatalog, error) {
	exclusions := map[string]bool{}
	if deps.Exclusions != nil {
		if loaded, err := deps.Exclusions.LoadRoutingExclusions(ctx); err == nil && loaded != nil {
			exclusions = loaded
		}
	}
	settingsIdx := buildSettingsIndex(ctx, deps.DatabasePath)

	enabledAccounts := make(map[string]accountapp.AccountOverview)
	accountsByProvider := make(map[string][]accountcore.AccountRef)
	if deps.Accounts != nil {
		overviews, err := deps.Accounts.ListAccountOverviews(ctx)
		if err != nil {
			return ModelCatalog{}, err
		}
		for _, overview := range overviews {
			acc := overview.Account()
			if !acc.IsValid() || !acc.Enabled() || !overview.HasCredential() {
				continue
			}
			ref := acc.Ref().String()
			if exclusions[ref] {
				continue
			}
			enabledAccounts[ref] = overview
			provider := strings.ToLower(strings.TrimSpace(acc.ProviderID()))
			accountsByProvider[provider] = append(accountsByProvider[provider], acc.Ref())
		}
	}

	isAccountModelAvailable := func(accountRef accountcore.AccountRef, providerID string, modelID string) bool {
		ref := accountRef.String()
		if _, ok := enabledAccounts[ref]; !ok {
			return false
		}
		if settingsIdx.isDisabled(ref, providerID, modelID) {
			return false
		}
		if deps.Runtime != nil {
			route, err := runtimecore.NewModelRoute(accountRef, modelID)
			if err != nil {
				return false
			}
			elig, err := deps.Runtime.CheckEligibility(ctx, route)
			if err != nil || !elig.Eligible() {
				return false
			}
		}
		return true
	}

	type candidateEntry struct {
		entry    ModelEntry
		accounts map[string]struct{}
	}
	candidatesByID := make(map[string]*candidateEntry)
	bestAccountCounts := make(map[string]int)

	considerCandidate := func(entry ModelEntry, availableCount int) {
		prev, exists := candidatesByID[entry.ID]
		if !exists || availableCount > bestAccountCounts[entry.ID] {
			entry.AvailableAccountCount = availableCount
			candidatesByID[entry.ID] = &candidateEntry{entry: entry}
			bestAccountCounts[entry.ID] = availableCount
		}
		_ = prev
	}

	// 按 (provider, modelID) 聚合能力索引条目，统计每个元组下的可用账号数。
	type pairKey struct {
		provider string
		modelID  string
	}
	pairCounts := make(map[pairKey]map[string]struct{})
	pairOrder := make([]pairKey, 0)

	if deps.AccountModels != nil {
		catalog, err := deps.AccountModels.ListAllAccountModels(ctx)
		if err != nil {
			return ModelCatalog{}, err
		}
		for _, set := range catalog.Sets {
			ref := set.AccountRef.String()
			if _, ok := enabledAccounts[ref]; !ok {
				continue
			}
			provider := strings.ToLower(strings.TrimSpace(set.ProviderID))
			for _, m := range set.Models {
				if !m.IsValid() || !m.Effective() {
					continue
				}
				modelID := strings.TrimSpace(m.ModelID().String())
				if modelID == "" || modelGeneratesImages(deps.Modalities, provider, modelID) {
					continue
				}
				if settingsIdx.isDisabled(ref, provider, modelID) {
					continue
				}
				effectiveProvider := provider
				if effectiveProvider == "" {
					effectiveProvider = InferModelFamilyProvider(modelID)
				}
				if effectiveProvider == "" {
					continue
				}
				key := pairKey{provider: effectiveProvider, modelID: modelID}
				accs, exists := pairCounts[key]
				if !exists {
					accs = make(map[string]struct{})
					pairCounts[key] = accs
					pairOrder = append(pairOrder, key)
				}
				if isAccountModelAvailable(set.AccountRef, effectiveProvider, modelID) {
					accs[ref] = struct{}{}
				}
			}
		}
	}

	for _, key := range pairOrder {
		avail := len(pairCounts[key])
		considerCandidate(ModelEntry{
			ID:            key.modelID,
			Provider:      key.provider,
			ProviderLabel: providerDisplayLabel(deps.Providers, key.provider),
			Source:        "capability",
		}, avail)
	}

	if deps.Aliases != nil {
		records, _, err := deps.Aliases.ListModelAliases(ctx)
		if err == nil {
			for _, record := range records {
				if !record.IsEnabled() {
					continue
				}
				aliasID := strings.TrimSpace(record.Alias)
				if aliasID == "" {
					continue
				}
				if _, exists := candidatesByID[aliasID]; exists {
					continue
				}
				provider := strings.ToLower(strings.TrimSpace(record.ResolvedTargetProvider()))
				if provider == "" {
					provider = strings.ToLower(strings.TrimSpace(record.ScopeProvider()))
				}
				if provider == "" {
					provider = InferModelFamilyProvider(record.Target)
				}
				if provider == "" {
					provider = InferModelFamilyProvider(aliasID)
				}
				if modelGeneratesImages(deps.Modalities, provider, aliasID) {
					continue
				}
				avail := 0
				if provider != "" {
					targetModel := strings.TrimSpace(record.Target)
					if targetModel == "" {
						targetModel = aliasID
					}
					for _, ref := range accountsByProvider[provider] {
						if isAccountModelAvailable(ref, provider, targetModel) {
							avail++
						}
					}
				}
				considerCandidate(ModelEntry{
					ID:            aliasID,
					Provider:      provider,
					ProviderLabel: providerDisplayLabel(deps.Providers, provider),
					Source:        "alias",
				}, avail)
			}
		}
	}

	if saved != nil && strings.TrimSpace(saved.Model) != "" && strings.TrimSpace(saved.Provider) != "" {
		savedModel := strings.TrimSpace(saved.Model)
		savedProvider := strings.ToLower(strings.TrimSpace(saved.Provider))
		if _, exists := candidatesByID[savedModel]; !exists && !modelGeneratesImages(deps.Modalities, savedProvider, savedModel) {
			avail := 0
			for _, ref := range accountsByProvider[savedProvider] {
				if isAccountModelAvailable(ref, savedProvider, savedModel) {
					avail++
				}
			}
			considerCandidate(ModelEntry{
				ID:            savedModel,
				Provider:      savedProvider,
				ProviderLabel: providerDisplayLabel(deps.Providers, savedProvider),
				Source:        "saved",
				Origin:        "translation-settings",
			}, avail)
		}
	}

	models := make([]ModelEntry, 0, len(candidatesByID))
	for _, item := range candidatesByID {
		models = append(models, item.entry)
	}
	sort.Slice(models, func(left, right int) bool {
		if models[right].AvailableAccountCount != models[left].AvailableAccountCount {
			return models[right].AvailableAccountCount < models[left].AvailableAccountCount
		}
		scoreDiff := TranslationDefaultScore(models[right].ID) - TranslationDefaultScore(models[left].ID)
		if scoreDiff != 0 {
			return scoreDiff < 0
		}
		return models[left].ID < models[right].ID
	})

	var preferred *ModelEntry
	for i := range models {
		if models[i].AvailableAccountCount > 0 {
			preferred = &models[i]
			break
		}
	}
	if preferred == nil && len(models) > 0 {
		preferred = &models[0]
	}
	defaultModel, defaultProvider := "", ""
	if preferred != nil {
		defaultModel = preferred.ID
		defaultProvider = preferred.Provider
	}

	return ModelCatalog{
		Models:          models,
		DefaultModel:    defaultModel,
		DefaultProvider: defaultProvider,
	}, nil
}

// ResolveTranslationFallbackCatalog 将已保存的偏好模型优先作为默认推荐（前提是它仍在目录中）。
func ResolveTranslationFallbackCatalog(catalog ModelCatalog, settings *Settings) ModelCatalog {
	if settings == nil {
		return catalog
	}
	model := strings.TrimSpace(settings.Model)
	provider := strings.ToLower(strings.TrimSpace(settings.Provider))
	if model == "" {
		return catalog
	}
	usable := false
	for _, item := range catalog.Models {
		if strings.TrimSpace(item.ID) == model &&
			(provider == "" || strings.ToLower(strings.TrimSpace(item.Provider)) == provider) {
			usable = true
			break
		}
	}
	if !usable {
		return catalog
	}
	out := catalog
	out.DefaultModel = model
	out.DefaultProvider = provider
	return out
}

// ResolveRequestModel 解析请求体与目录，拆出目标模型和上游 Provider。
func ResolveRequestModel(bodyModel string, bodyProvider string, fallbackCatalog ModelCatalog) (string, string, error) {
	model := strings.TrimSpace(bodyModel)
	provider := strings.ToLower(strings.TrimSpace(bodyProvider))

	exactInCatalog := func(id string) bool {
		for _, item := range fallbackCatalog.Models {
			if strings.TrimSpace(item.ID) == id {
				return true
			}
		}
		return false
	}

	if model != "" && provider != "" &&
		len(model) > len(provider)+1 &&
		strings.EqualFold(model[:len(provider)+1], provider+"/") &&
		!exactInCatalog(model) {
		model = model[len(provider)+1:]
	}

	if model != "" && provider == "" && strings.Contains(model, "/") && !exactInCatalog(model) {
		if prefix, rest, ok := strings.Cut(model, "/"); ok {
			for _, item := range fallbackCatalog.Models {
				if item.Provider == prefix {
					provider = prefix
					model = rest
					break
				}
			}
		}
	}

	if model == "" {
		model = fallbackCatalog.DefaultModel
		if provider == "" {
			provider = fallbackCatalog.DefaultProvider
		}
	}
	if model == "" {
		return "", "", &ConfigError{
			StatusCode: 409,
			Code:       "translation_model_unavailable",
			Detail:     "当前没有可用作翻译的模型",
		}
	}
	return model, provider, nil
}
