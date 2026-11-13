package webuimodelsyncapi

import (
	"context"
	"sort"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelalias"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountrefmap"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
	"github.com/madou1217/ai_home/internal/transport/http/webuiaccountsapi"
)

// ModelModalitiesView 对齐 /v1/models 的 aih_modalities 字段。
type ModelModalitiesView struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}

// OpenAIModelItem 对齐 WebUI OpenAI 模型列表里的 data[] 条目。
type OpenAIModelItem struct {
	ID                  string              `json:"id"`
	Object              string              `json:"object"`
	Created             int64               `json:"created"`
	OwnedBy             string              `json:"owned_by"`
	AIHModalities       ModelModalitiesView `json:"aih_modalities"`
	AIHReasoningEfforts []string            `json:"aih_reasoning_efforts,omitempty"`
	Providers           []string            `json:"providers"`
	AccountRefs         []string            `json:"account_refs"`
}

// ManagedModelItem 对齐 WebUI 模型管理页的 managedData[] 条目。
type ManagedModelItem struct {
	ID                  string                              `json:"id"`
	Object              string                              `json:"object"`
	Created             int64                               `json:"created"`
	OwnedBy             string                              `json:"owned_by"`
	AIHModalities       ModelModalitiesView                 `json:"aih_modalities"`
	AIHReasoningEfforts []string                            `json:"aih_reasoning_efforts,omitempty"`
	Provider            string                              `json:"provider"`
	AccountRef          string                              `json:"accountRef"`
	Enabled             bool                                `json:"enabled"`
	Manual              bool                                `json:"manual"`
	DefaultModel        bool                                `json:"defaultModel"`
	Source              string                              `json:"source"`
	Providers           []string                            `json:"providers"`
	Description         string                              `json:"description"`
	CustomPricing       *modelcatalogsettings.CustomPricing `json:"customPricing,omitempty"`
	UpdatedAt           int64                               `json:"updatedAt"`
	Metadata            map[string]any                      `json:"metadata"`
}

// AccountSummary 对齐 WebUI 模型页与账号详情页的 accounts[] 汇总行。
type AccountSummary struct {
	Provider    string `json:"provider"`
	AccountRef  string `json:"accountRef"`
	DisplayName string `json:"displayName"`
	Email       string `json:"email"`
	APIKeyMode  bool   `json:"apiKeyMode"`
	AuthType    string `json:"authType"`
}

// AccountScope 表示账号过滤作用域；全局读取时整个字段序列化为 null。
type AccountScope struct {
	AccountRef string `json:"accountRef"`
}

// CatalogResponse 对齐 WebUI /v0/webui/openai-models 的完整响应形状。
type CatalogResponse struct {
	OK                 bool                         `json:"ok"`
	Endpoint           string                       `json:"endpoint"`
	Cached             bool                         `json:"cached"`
	UpdatedAt          int64                        `json:"updatedAt"`
	Source             string                       `json:"source"`
	Sources            int                          `json:"sources"`
	ScannedAccounts    int                          `json:"scannedAccounts"`
	FirstError         string                       `json:"firstError"`
	AccountScope       *AccountScope                `json:"accountScope"`
	Data               []OpenAIModelItem            `json:"data"`
	ManagedData        []ManagedModelItem           `json:"managedData"`
	Metadata           map[string]any               `json:"metadata"`
	Labels             map[string]map[string]string `json:"labels"`
	Accounts           []AccountSummary             `json:"accounts"`
	ByProvider         map[string][]string          `json:"byProvider"`
	ByAccountRef       map[string][]string          `json:"byAccountRef"`
	ErrorsByAccountRef map[string]string            `json:"errorsByAccountRef"`
	AccountProbedAt    map[string]int64             `json:"accountProbedAt"`
	SettingsUpdatedAt  int64                        `json:"settingsUpdatedAt"`
	CatalogGeneration  int64                        `json:"catalogGeneration"`
}

type catalogModelEntry struct {
	id         string
	provider   string
	accountRef string
	source     string
	manual     bool
	enabled    bool
	setting    *modelcatalogsettings.AccountModel
}

type modelOwnership struct {
	providers   map[string]struct{}
	accountRefs map[string]struct{}
}

func (handler *Handler) buildCatalog(ctx context.Context, scopedAccountRef string) (CatalogResponse, error) {
	now := handler.now()
	catalog, err := handler.store.ListAllAccountModels(ctx)
	if err != nil {
		return CatalogResponse{}, err
	}
	overviews, err := listAllAccountOverviews(ctx, handler.store)
	if err != nil {
		return CatalogResponse{}, err
	}
	rowsByRef := handler.loadAccountRowsMap(ctx)
	settings := handler.loadSettingsBestEffort(ctx)
	labels := handler.loadSnapshotLabelsBestEffort(ctx)
	refTable := handler.loadRefTableBestEffort(ctx)
	aliases := handler.loadAliasesBestEffort(ctx)

	modelCatalogProviders, providerSet := resolveModelCatalogProviders(handler.catalog)
	settingsLookup := indexAccountModelSettings(settings, refTable)
	legacyDisabled := indexDisabledLegacyModels(settings)

	accountsByRef := buildAccountSummariesMap(overviews, rowsByRef, settings, providerSet)
	accountSummaries := sortAccountSummaries(accountsByRef)

	byAccountRef := make(map[string][]string)
	errorsByAccountRef := make(map[string]string)
	accountProbedAt := make(map[string]int64)
	globalFirstError := ""
	sources := 0
	scannedAccounts := 0

	catalogEntries := make([]catalogModelEntry, 0)
	entryIndex := make(map[string]int)

	addEntry := func(entry catalogModelEntry) {
		key := entry.accountRef + "\x00" + strings.ToLower(entry.id)
		if idx, exists := entryIndex[key]; exists {
			prev := &catalogEntries[idx]
			if entrySourcePriority(entry.source) > entrySourcePriority(prev.source) {
				prev.source = entry.source
			}
			if entry.manual {
				prev.manual = true
			}
			if entry.setting != nil {
				prev.setting = entry.setting
				prev.enabled = entry.setting.Enabled
			}
			return
		}
		entryIndex[key] = len(catalogEntries)
		catalogEntries = append(catalogEntries, entry)
	}

	for _, set := range catalog.Sets {
		ref := set.AccountRef.String()
		if !providerSet[set.ProviderID] {
			continue
		}
		if scopedAccountRef != "" && ref != scopedAccountRef {
			continue
		}
		scannedAccounts++

		discoveredIDs := make([]string, 0, len(set.Models))
		seenDiscovered := make(map[string]struct{}, len(set.Models))
		for _, model := range set.Models {
			modelID := model.ModelID().String()
			if model.UpstreamAvailable() {
				if _, dup := seenDiscovered[modelID]; !dup {
					seenDiscovered[modelID] = struct{}{}
					discoveredIDs = append(discoveredIDs, modelID)
				}
			}

			setting := lookupAccountModelSetting(settingsLookup, ref, modelID)
			isManual := (setting != nil && setting.Manual) || (!model.UpstreamAvailable() && model.ManualPolicy() == accountapp.ModelPolicyForceEnable)
			if !model.UpstreamAvailable() && !isManual {
				continue
			}

			enabled := model.ManualPolicy() != accountapp.ModelPolicyForceDisable
			if setting != nil {
				enabled = setting.Enabled
			} else if legDisabled, hasLegacy := legacyDisabled[legacySettingKey(set.ProviderID, modelID)]; hasLegacy && legDisabled {
				enabled = false
			}
			source := "webui-probe"
			if isManual {
				source = "manual"
			}
			addEntry(catalogModelEntry{
				id:         modelID,
				provider:   set.ProviderID,
				accountRef: ref,
				source:     source,
				manual:     isManual,
				enabled:    enabled,
				setting:    setting,
			})
		}

		sort.Strings(discoveredIDs)
		if len(discoveredIDs) > 0 {
			sources++
			byAccountRef[ref] = discoveredIDs
		} else if !set.LastAttemptAt.IsZero() && strings.TrimSpace(set.LastErrorMessage) == "" && strings.TrimSpace(set.LastErrorCode) == "" {
			byAccountRef[ref] = []string{}
		}
		if !set.LastAttemptAt.IsZero() {
			accountProbedAt[ref] = set.LastAttemptAt.UnixMilli()
		}
		if errText := formatProbeError(set.LastErrorCode, set.LastErrorMessage); errText != "" {
			errorsByAccountRef[ref] = errText
			if globalFirstError == "" {
				globalFirstError = errText
			}
		}
	}

	// 补充仅存于 model-catalog-settings 中的手工模型（例如尚未触发或已从 account_models 清理的记录）。
	for i := range settings.AccountModels {
		record := &settings.AccountModels[i]
		canonicalRef := record.AccountRef
		if translated := refTable.GoRef(record.AccountRef); translated != "" {
			canonicalRef = translated
		}
		if scopedAccountRef != "" && canonicalRef != scopedAccountRef {
			continue
		}
		if record.Provider != "" && !providerSet[record.Provider] {
			continue
		}
		if !record.Manual {
			continue
		}
		addEntry(catalogModelEntry{
			id:         record.ID,
			provider:   record.Provider,
			accountRef: canonicalRef,
			source:     "manual",
			manual:     true,
			enabled:    record.Enabled,
			setting:    record,
		})
	}

	// 按 (provider, accountRef, id) 排序，保持与 Node buildManagedModelItems 一致的稳定序。
	sort.Slice(catalogEntries, func(left, right int) bool {
		if catalogEntries[left].provider != catalogEntries[right].provider {
			return catalogEntries[left].provider < catalogEntries[right].provider
		}
		if catalogEntries[left].accountRef != catalogEntries[right].accountRef {
			return catalogEntries[left].accountRef < catalogEntries[right].accountRef
		}
		return catalogEntries[left].id < catalogEntries[right].id
	})

	// 汇总每个模型 ID 的完整归属集合（providers / account_refs），必须在按 ID 去重前计算。
	ownershipByID := make(map[string]*modelOwnership)
	enabledCatalogModels := make([]catalogModelEntry, 0, len(catalogEntries))
	for _, entry := range catalogEntries {
		own := ownershipByID[entry.id]
		if own == nil {
			own = &modelOwnership{
				providers:   make(map[string]struct{}),
				accountRefs: make(map[string]struct{}),
			}
			ownershipByID[entry.id] = own
		}
		if entry.provider != "" && providerSet[entry.provider] {
			own.providers[entry.provider] = struct{}{}
		}
		if entry.accountRef != "" {
			own.accountRefs[entry.accountRef] = struct{}{}
		}
		if entry.enabled {
			enabledCatalogModels = append(enabledCatalogModels, entry)
		}
	}

	// 生成最终展示条目（data）：单账号作用域不混入全局别名；全局视图按 ID 去重并合并有效别名。
	finalEntries := make([]catalogModelEntry, 0, len(enabledCatalogModels))
	visibleByID := make(map[string]struct{}, len(enabledCatalogModels))
	for _, entry := range enabledCatalogModels {
		if _, exists := visibleByID[entry.id]; exists {
			continue
		}
		visibleByID[entry.id] = struct{}{}
		finalEntries = append(finalEntries, entry)
	}
	if scopedAccountRef == "" {
		aliasEntries := expandEnabledAliasEntries(aliases, enabledCatalogModels, legacyDisabled, now)
		for _, aliasEntry := range aliasEntries {
			if _, exists := visibleByID[aliasEntry.id]; exists {
				continue
			}
			visibleByID[aliasEntry.id] = struct{}{}
			finalEntries = append(finalEntries, aliasEntry)
		}
	}

	updatedAtMS := maxInt64(catalog.UpdatedAtMS, settings.UpdatedAtMS)
	createdSec := now.Unix()
	if updatedAtMS > 0 {
		createdSec = updatedAtMS / 1000
	}

	data := make([]OpenAIModelItem, 0, len(finalEntries))
	metadataMap := make(map[string]any, len(finalEntries))
	for _, entry := range finalEntries {
		own := ownershipByID[entry.id]
		providersList := sortedSetKeys(nil)
		accountRefsList := sortedSetKeys(nil)
		if own != nil {
			providersList = sortedSetKeys(own.providers)
			accountRefsList = sortedSetKeys(own.accountRefs)
		}
		ownedBy := resolveModelOwner(entry.provider, entry.id)
		item := OpenAIModelItem{
			ID:                  entry.id,
			Object:              "model",
			Created:             createdSec,
			OwnedBy:             ownedBy,
			AIHModalities:       resolveModalities(handler.modalities, entry.provider, entry.id),
			AIHReasoningEfforts: resolveReasoningEfforts(handler.modalities, entry.provider, entry.id),
			Providers:           providersList,
			AccountRefs:         accountRefsList,
		}
		data = append(data, item)
		if _, exists := metadataMap[entry.id]; !exists {
			if meta := resolveModelsDevMetadata(entry.provider, entry.id, now); meta != nil {
				metadataMap[entry.id] = meta
			}
		}
	}

	managedData := make([]ManagedModelItem, 0, len(catalogEntries))
	for _, entry := range catalogEntries {
		ownedBy := resolveModelOwner(entry.provider, entry.id)
		modalities := resolveModalities(handler.modalities, entry.provider, entry.id)
		efforts := resolveReasoningEfforts(handler.modalities, entry.provider, entry.id)
		var (
			defaultModel  bool
			description   string
			customPricing *modelcatalogsettings.CustomPricing
			updatedAt     int64
		)
		source := entry.source
		if entry.setting != nil {
			defaultModel = entry.setting.DefaultModel
			description = entry.setting.Description
			customPricing = entry.setting.CustomPricing
			updatedAt = entry.setting.UpdatedAtMS
			if entry.setting.Manual {
				source = "manual"
			}
		}
		providersField := []string{}
		if entry.provider != "" {
			providersField = []string{entry.provider}
		}
		meta := resolveModelsDevMetadata(entry.provider, entry.id, now)
		if meta == nil {
			meta = buildUnknownModelMetadata(entry.id, now)
		}
		managedData = append(managedData, ManagedModelItem{
			ID:                  entry.id,
			Object:              "model",
			Created:             createdSec,
			OwnedBy:             ownedBy,
			AIHModalities:       modalities,
			AIHReasoningEfforts: efforts,
			Provider:            entry.provider,
			AccountRef:          entry.accountRef,
			Enabled:             entry.enabled,
			Manual:              entry.manual,
			DefaultModel:        defaultModel,
			Source:              source,
			Providers:           providersField,
			Description:         description,
			CustomPricing:       customPricing,
			UpdatedAt:           updatedAt,
			Metadata:            meta,
		})
	}

	byProvider := buildByProviderMap(modelCatalogProviders, data, finalEntries, ownershipByID, visibleByID)

	var scope *AccountScope
	firstError := globalFirstError
	if scopedAccountRef != "" {
		scope = &AccountScope{AccountRef: scopedAccountRef}
		firstError = errorsByAccountRef[scopedAccountRef]
	}

	sourceLabel := "go-account-models"
	if scannedAccounts == 0 && len(data) == 0 && len(managedData) == 0 {
		sourceLabel = "empty"
	}

	return CatalogResponse{
		OK:                 true,
		Endpoint:           "/v1/models",
		Cached:             false,
		UpdatedAt:          updatedAtMS,
		Source:             sourceLabel,
		Sources:            sources,
		ScannedAccounts:    scannedAccounts,
		FirstError:         firstError,
		AccountScope:       scope,
		Data:               data,
		ManagedData:        managedData,
		Metadata:           metadataMap,
		Labels:             labels,
		Accounts:           accountSummaries,
		ByProvider:         byProvider,
		ByAccountRef:       byAccountRef,
		ErrorsByAccountRef: errorsByAccountRef,
		AccountProbedAt:    accountProbedAt,
		SettingsUpdatedAt:  settings.UpdatedAtMS,
		CatalogGeneration:  catalog.Generation,
	}, nil
}

func listAllAccountOverviews(ctx context.Context, store Store) ([]accountapp.AccountOverview, error) {
	var all []accountapp.AccountOverview
	var afterRef = ""
	for {
		var parsedCursor = accountapp.OverviewQuery{}
		var err error
		if afterRef == "" {
			parsedCursor, err = accountapp.NewOverviewQuery("", accountapp.MaxOverviewLimit)
		} else {
			parsedCursor, err = accountapp.NewOverviewQuery(mustParseAccountRef(afterRef), accountapp.MaxOverviewLimit)
		}
		if err != nil {
			return nil, err
		}
		page, err := store.ListAccountOverviews(ctx, parsedCursor)
		if err != nil {
			return nil, err
		}
		all = append(all, page...)
		if len(page) < accountapp.MaxOverviewLimit {
			break
		}
		afterRef = page[len(page)-1].Account().Ref().String()
	}
	return all, nil
}

func resolveModelCatalogProviders(catalog *providers.Catalog) ([]string, map[string]bool) {
	if catalog == nil {
		if built, err := providers.NewCatalog(providers.BuiltinManifest()); err == nil {
			catalog = built
		}
	}
	var ids []string
	set := make(map[string]bool)
	if catalog == nil {
		return ids, set
	}
	for _, def := range catalog.List() {
		hasCap := false
		for _, capItem := range def.Capabilities {
			if capItem == providers.CapabilityModelCatalog {
				hasCap = true
				break
			}
		}
		if hasCap {
			ids = append(ids, def.ID)
			set[def.ID] = true
		}
	}
	return ids, set
}

func buildAccountSummariesMap(
	overviews []accountapp.AccountOverview,
	rowsByRef map[string]webuiaccountsapi.Row,
	settings modelcatalogsettings.Settings,
	providerSet map[string]bool,
) map[string]AccountSummary {
	accountsByRef := make(map[string]AccountSummary, len(overviews))
	for _, overview := range overviews {
		provider := overview.Account().ProviderID()
		if !providerSet[provider] {
			continue
		}
		ref := overview.Account().Ref().String()
		row, hasRow := rowsByRef[ref]
		displayName := firstNonEmpty(overview.DisplayName(), overview.Email(), ref)
		email := strings.TrimSpace(overview.Email())
		authType := firstNonEmpty(
			normalizeAuthType(overview.AuthMode()),
			normalizeAuthType(overview.AuthKind()),
			strings.TrimSpace(overview.AuthKind()),
		)
		apiKeyMode := authType == "api-key" || authType == "auth-token"
		if hasRow {
			displayName = firstNonEmpty(row.DisplayName, row.Email, displayName)
			email = firstNonEmpty(row.Email, email)
			apiKeyMode = row.APIKeyMode
			authType = firstNonEmpty(normalizeAuthType(row.AuthMode), authType)
		}
		accountsByRef[ref] = AccountSummary{
			Provider:    provider,
			AccountRef:  ref,
			DisplayName: displayName,
			Email:       email,
			APIKeyMode:  apiKeyMode,
			AuthType:    authType,
		}
	}
	for _, record := range settings.AccountModels {
		if !record.Manual || record.AccountRef == "" {
			continue
		}
		if record.Provider != "" && !providerSet[record.Provider] {
			continue
		}
		if _, exists := accountsByRef[record.AccountRef]; exists {
			continue
		}
		accountsByRef[record.AccountRef] = AccountSummary{
			Provider:    record.Provider,
			AccountRef:  record.AccountRef,
			DisplayName: record.AccountRef,
			Email:       "",
			APIKeyMode:  false,
			AuthType:    "",
		}
	}
	return accountsByRef
}

func sortAccountSummaries(accountsByRef map[string]AccountSummary) []AccountSummary {
	out := make([]AccountSummary, 0, len(accountsByRef))
	for _, summary := range accountsByRef {
		out = append(out, summary)
	}
	sort.Slice(out, func(left, right int) bool {
		if out[left].Provider != out[right].Provider {
			return out[left].Provider < out[right].Provider
		}
		return out[left].AccountRef < out[right].AccountRef
	})
	return out
}

func expandEnabledAliasEntries(
	aliases []modelalias.Record,
	enabledCatalog []catalogModelEntry,
	legacyDisabled map[string]bool,
	now time.Time,
) []catalogModelEntry {
	if len(aliases) == 0 || len(enabledCatalog) == 0 {
		return nil
	}
	modelsByAll := make(map[string]struct{}, len(enabledCatalog))
	modelsByProvider := make(map[string]map[string]struct{})
	for _, entry := range enabledCatalog {
		modelsByAll[entry.id] = struct{}{}
		if entry.provider != "" {
			pm := modelsByProvider[entry.provider]
			if pm == nil {
				pm = make(map[string]struct{})
				modelsByProvider[entry.provider] = pm
			}
			pm[entry.id] = struct{}{}
		}
	}

	hasTarget := func(target, targetProvider string) bool {
		if targetProvider == "" || targetProvider == modelalias.TargetProviderAuto {
			_, ok := modelsByAll[target]
			return ok
		}
		_, ok := modelsByProvider[targetProvider][target]
		return ok
	}

	out := make([]catalogModelEntry, 0)
	for _, alias := range aliases {
		if alias.Enabled != nil && !*alias.Enabled {
			continue
		}
		aliasName := strings.TrimSpace(alias.Alias)
		targetName := strings.TrimSpace(alias.Target)
		if aliasName == "" || targetName == "" {
			continue
		}
		if !hasTarget(targetName, strings.TrimSpace(alias.TargetProvider)) {
			continue
		}
		provider := strings.TrimSpace(alias.Provider)
		if provider == "" || provider == modelalias.ScopeAll {
			provider = ""
		}
		if !strings.HasSuffix(aliasName, "*") {
			if legacyDisabled[legacySettingKey("", aliasName)] || (provider != "" && legacyDisabled[legacySettingKey(provider, aliasName)]) {
				continue
			}
			out = append(out, catalogModelEntry{
				id:       aliasName,
				provider: provider,
				source:   "alias",
				enabled:  true,
			})
			continue
		}
		for _, expandedID := range listWildcardAliasModels(aliasName, now) {
			if legacyDisabled[legacySettingKey("", expandedID)] || (provider != "" && legacyDisabled[legacySettingKey(provider, expandedID)]) {
				continue
			}
			out = append(out, catalogModelEntry{
				id:       expandedID,
				provider: provider,
				source:   "alias",
				enabled:  true,
			})
		}
	}
	return out
}

func buildByProviderMap(
	modelCatalogProviders []string,
	data []OpenAIModelItem,
	finalEntries []catalogModelEntry,
	ownershipByID map[string]*modelOwnership,
	visibleByID map[string]struct{},
) map[string][]string {
	grouped := make(map[string]map[string]struct{}, len(modelCatalogProviders))
	for _, provider := range modelCatalogProviders {
		grouped[provider] = make(map[string]struct{})
	}
	for _, item := range data {
		provider := resolveOpenAIProviderFromModel(item.ID, item.OwnedBy)
		if provider != "" {
			if set := grouped[provider]; set != nil {
				set[item.ID] = struct{}{}
			}
		}
	}
	for _, entry := range finalEntries {
		if entry.provider == "" {
			continue
		}
		if set := grouped[entry.provider]; set != nil {
			set[entry.id] = struct{}{}
		}
	}
	for modelID, own := range ownershipByID {
		if _, visible := visibleByID[modelID]; !visible {
			continue
		}
		for provider := range own.providers {
			if set := grouped[provider]; set != nil {
				set[modelID] = struct{}{}
			}
		}
	}
	out := make(map[string][]string, len(modelCatalogProviders))
	for _, provider := range modelCatalogProviders {
		list := sortedSetKeys(grouped[provider])
		out[provider] = list
	}
	return out
}

func indexAccountModelSettings(
	settings modelcatalogsettings.Settings,
	refTable accountrefmap.Table,
) map[string]*modelcatalogsettings.AccountModel {
	out := make(map[string]*modelcatalogsettings.AccountModel, len(settings.AccountModels))
	for i := range settings.AccountModels {
		record := &settings.AccountModels[i]
		ref := record.AccountRef
		if mapped := refTable.GoRef(ref); mapped != "" {
			ref = mapped
		}
		key := ref + "\x00" + strings.ToLower(strings.TrimSpace(record.ID))
		if _, exists := out[key]; !exists {
			out[key] = record
		}
	}
	return out
}

func lookupAccountModelSetting(
	index map[string]*modelcatalogsettings.AccountModel,
	accountRef, modelID string,
) *modelcatalogsettings.AccountModel {
	if len(index) == 0 {
		return nil
	}
	return index[accountRef+"\x00"+strings.ToLower(strings.TrimSpace(modelID))]
}

func indexDisabledLegacyModels(settings modelcatalogsettings.Settings) map[string]bool {
	out := make(map[string]bool)
	for _, record := range settings.LegacyModels {
		if !record.Enabled {
			out[legacySettingKey(record.Provider, record.ID)] = true
		}
	}
	return out
}

func legacySettingKey(provider, modelID string) string {
	return strings.ToLower(strings.TrimSpace(provider)) + "\x00" + strings.ToLower(strings.TrimSpace(modelID))
}

func entrySourcePriority(source string) int {
	switch source {
	case "manual":
		return 4
	case "webui-probe":
		return 3
	case "account":
		return 2
	case "descriptor":
		return 1
	default:
		return 0
	}
}

func formatProbeError(code, message string) string {
	msg := strings.TrimSpace(message)
	c := strings.TrimSpace(code)
	if msg != "" {
		return msg
	}
	return c
}

func normalizeAuthType(raw string) string {
	norm := strings.ReplaceAll(strings.ToLower(strings.TrimSpace(raw)), "_", "-")
	switch norm {
	case "api-key", "apikey":
		return "api-key"
	case "auth-token", "authtoken", "claude-code-token":
		return "auth-token"
	case "oauth", "oauth-browser", "oauth-device":
		return norm
	default:
		return ""
	}
}

func sortedSetKeys(set map[string]struct{}) []string {
	if len(set) == 0 {
		return []string{}
	}
	out := make([]string, 0, len(set))
	for item := range set {
		out = append(out, item)
	}
	sort.Strings(out)
	return out
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if trimmed := strings.TrimSpace(v); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}
