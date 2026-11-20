// Package webuiworkspacemodelsapi 提供兼容 WebUI /v0/webui/models 全量契约的 Go HTTP 处理器。
//
//	GET /v1/management/webui/workspace/models[?accountRef=...]
//
// 合并 SQLite account_models / account_model_probes、app-state 的
// model-catalog-settings / cache:webui-models-snapshot.json / 账号引用映射，
// 以及 models.dev 模态与上下文窗口索引；支持 ?accountRef= 对未探测冷账号执行单点探测。
package webuiworkspacemodelsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelmetadata"
	"github.com/madou1217/ai_home/application/modelprobes"
	"github.com/madou1217/ai_home/application/modelsnapshot"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accountrefmap"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
)

const (
	// Path 是 WebUI 全量模型目录管理契约路径。
	Path = "/v1/management/webui/workspace/models"

	coldProbeTimeout = 10 * time.Second
)

// ErrInvalidDependencies 表示 Handler 缺少必需依赖。
var ErrInvalidDependencies = errors.New("工作区模型目录接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// SettingsReader 读 model-catalog-settings 文档的只读端口。
//
// 由组合层注入适配器实现（aih.db 路径），本包不自己解析数据库位置。
type SettingsReader interface {
	ReadSettings(ctx context.Context) (modelcatalogsettings.Settings, error)
}

// RefTableSource 读取 Node→Go 账号引用映射表。
//
// 按请求读取而不是构造期缓存：账号导入会在运行期新增链接，缓存整表会让新账号
// 的引用翻译静默退回恒等，从而查不到按 Node ref 记录的模型设置。
type RefTableSource interface {
	LoadTable(ctx context.Context) (accountrefmap.Table, error)
}

// Store 组合账号概览与账号模型批量读端口。
type Store interface {
	ListAllAccountModels(ctx context.Context) (accountapp.AccountModelCatalog, error)
	ListAccountOverviews(ctx context.Context, query accountapp.OverviewQuery) ([]accountapp.AccountOverview, error)
}

// Dependencies 汇总工作区模型目录接口依赖。
type Dependencies struct {
	Authorizer     Authorizer
	Store          Store
	ModelRefresher accountapp.AccountModelRefresher
	MetadataIndex  modelmetadata.Catalog
	Snapshot       modelsnapshot.Reader
	Settings       SettingsReader
	Refs           RefTableSource
}

// Handler 处理 GET /v1/management/webui/workspace/models。
type Handler struct {
	authorizer    Authorizer
	store         Store
	refresher     accountapp.AccountModelRefresher
	metadataIndex modelmetadata.Catalog
	snapshot      modelsnapshot.Reader
	settings      SettingsReader
	refs          RefTableSource
}

// NewHandler 创建工作区模型目录 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer:    dependencies.Authorizer,
		store:         dependencies.Store,
		refresher:     dependencies.ModelRefresher,
		metadataIndex: dependencies.MetadataIndex,
		snapshot:      dependencies.Snapshot,
		settings:      dependencies.Settings,
		refs:          dependencies.Refs,
	}, nil
}

// ServeHTTP 处理模型目录与选择器投影读取。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	if handler == nil || handler.authorizer == nil || handler.store == nil {
		writeError(response, http.StatusServiceUnavailable, "webui_models_unavailable", "模型目录服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 GET")
		return
	}

	ctx := request.Context()
	overviews, err := loadAllOverviews(ctx, handler.store)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "get_models_failed", err.Error())
		return
	}

	resolver := handler.resolveRefs(ctx)
	settings := handler.loadSettings(ctx)
	snapshot := handler.loadSnapshot(ctx)

	catalog, err := handler.store.ListAllAccountModels(ctx)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "get_models_failed", err.Error())
		return
	}

	requestedRef := strings.TrimSpace(request.URL.Query().Get("accountRef"))
	scopeGoRef := ""
	if requestedRef != "" {
		matched, ok := resolveRequestedScopeRef(requestedRef, overviews, catalog, resolver)
		if !ok {
			writeError(response, http.StatusNotFound, "account_not_found", "未找到要读取模型缓存的账号")
			return
		}
		scopeGoRef = matched
	}

	// 冷账号首探：显式请求单账号且从未被探测过时做一次有界即时探测。
	cached := true
	if scopeGoRef != "" && handler.refresher != nil && isNeverProbed(scopeGoRef, catalog, snapshot, resolver) {
		if parsed, parseErr := accountcore.ParseAccountRef(scopeGoRef); parseErr == nil {
			probeCtx, cancel := context.WithTimeout(ctx, coldProbeTimeout)
			_, _ = handler.refresher.RefreshAccountModels(probeCtx, parsed)
			cancel()
			cached = false
			if refreshed, refErr := handler.store.ListAllAccountModels(ctx); refErr == nil {
				catalog = refreshed
			}
		}
	}

	payload := buildResponse(overviews, catalog, settings, snapshot, resolver, handler.metadataIndex, scopeGoRef, cached)
	writeJSON(response, http.StatusOK, payload)
}

func loadAllOverviews(ctx context.Context, store Store) ([]accountapp.AccountOverview, error) {
	all := make([]accountapp.AccountOverview, 0)
	var afterRef accountcore.AccountRef
	for {
		query, err := accountapp.NewOverviewQuery(afterRef, 0)
		if err != nil {
			return nil, err
		}
		batch, err := store.ListAccountOverviews(ctx, query)
		if err != nil {
			return nil, err
		}
		if len(batch) == 0 {
			break
		}
		all = append(all, batch...)
		lastRef := batch[len(batch)-1].Account().Ref()
		if lastRef == afterRef || len(batch) < query.Limit() {
			break
		}
		afterRef = lastRef
	}
	return all, nil
}

// resolveRefs 读取当前引用映射表并构造翻译器。
//
// 未接线或读表失败时按恒等回落（与「同步未启用」一致），不阻断模型目录读取。
func (handler *Handler) resolveRefs(ctx context.Context) accountrefmap.Resolver {
	if handler == nil || handler.refs == nil {
		return accountrefmap.Resolver{}
	}
	table, err := handler.refs.LoadTable(ctx)
	if err != nil {
		return accountrefmap.Resolver{}
	}
	return accountrefmap.NewResolver(true, table)
}

// loadSettings 读取注入的设置端口；未接线或读取失败时返回空设置。
func (handler *Handler) loadSettings(ctx context.Context) modelcatalogsettings.Settings {
	if handler == nil || handler.settings == nil {
		return modelcatalogsettings.Settings{}
	}
	settings, err := handler.settings.ReadSettings(ctx)
	if err != nil {
		return modelcatalogsettings.Settings{}
	}
	return settings
}

// loadSnapshot 读取注入的快照端口；未接线或读取失败时返回空快照。
func (handler *Handler) loadSnapshot(ctx context.Context) *modelsnapshot.Snapshot {
	if handler == nil || handler.snapshot == nil {
		return &modelsnapshot.Snapshot{}
	}
	snapshot, err := handler.snapshot.Read(ctx)
	if err != nil || snapshot == nil {
		return &modelsnapshot.Snapshot{}
	}
	return snapshot
}

func resolveRequestedScopeRef(
	requested string,
	overviews []accountapp.AccountOverview,
	catalog accountapp.AccountModelCatalog,
	resolver accountrefmap.Resolver,
) (string, bool) {
	candidates := []string{requested}
	if mappedGo := strings.TrimSpace(resolver.GoRef(requested)); mappedGo != "" && mappedGo != requested {
		candidates = append(candidates, mappedGo)
	}
	for _, overview := range overviews {
		ref := overview.Account().Ref().String()
		nodeRef := strings.TrimSpace(resolver.NodeRef(ref))
		for _, cand := range candidates {
			if cand == ref || (nodeRef != "" && cand == nodeRef) {
				return ref, true
			}
		}
	}
	for _, set := range catalog.Sets {
		ref := set.AccountRef.String()
		nodeRef := strings.TrimSpace(resolver.NodeRef(ref))
		for _, cand := range candidates {
			if cand == ref || (nodeRef != "" && cand == nodeRef) {
				return ref, true
			}
		}
	}
	return "", false
}

func isNeverProbed(
	goRef string,
	catalog accountapp.AccountModelCatalog,
	snapshot *modelsnapshot.Snapshot,
	resolver accountrefmap.Resolver,
) bool {
	for _, set := range catalog.Sets {
		if set.AccountRef.String() == goRef {
			if !set.LastAttemptAt.IsZero() || len(set.Models) > 0 || strings.TrimSpace(set.LastErrorMessage) != "" {
				return false
			}
		}
	}
	if snapshot != nil && snapshot.Available {
		if snapshot.AccountUpdatedAt[goRef] > 0 || len(snapshot.ByAccount[goRef]) > 0 {
			return false
		}
		if nodeRef := strings.TrimSpace(resolver.NodeRef(goRef)); nodeRef != "" {
			if snapshot.AccountUpdatedAt[nodeRef] > 0 || len(snapshot.ByAccount[nodeRef]) > 0 {
				return false
			}
		}
	}
	return true
}

func buildResponse(
	overviews []accountapp.AccountOverview,
	catalog accountapp.AccountModelCatalog,
	settings modelcatalogsettings.Settings,
	snapshot *modelsnapshot.Snapshot,
	resolver accountrefmap.Resolver,
	metadataIndex modelmetadata.Catalog,
	scopeGoRef string,
	cached bool,
) map[string]any {
	providerByRef := make(map[string]string, len(overviews)+len(catalog.Sets))
	for _, overview := range overviews {
		providerByRef[overview.Account().Ref().String()] = strings.ToLower(strings.TrimSpace(overview.Account().ProviderID()))
	}
	for _, set := range catalog.Sets {
		ref := set.AccountRef.String()
		if providerByRef[ref] == "" {
			providerByRef[ref] = strings.ToLower(strings.TrimSpace(set.ProviderID))
		}
	}

	// 按 (账号引用, 小写模型 id) 建置设置索引（同时认 Go ref 与 Node ref）。
	settingByKey := indexAccountModelSettings(settings.AccountModels, resolver)

	byAccountRef := map[string][]string{}
	selectableByAccountRef := map[string][]string{}
	errorsByAccountRef := map[string]string{}
	accountProbedAt := map[string]int64{}
	successfulProbeAt := map[string]int64{}
	modelsByProvider := map[string][]string{}
	providerModelSets := map[string]map[string]struct{}{}
	providerByUniqueModel := map[string]string{}

	addProviderModel := func(provider, modelID string) {
		p := strings.ToLower(strings.TrimSpace(provider))
		id := strings.TrimSpace(modelID)
		if p == "" || id == "" {
			return
		}
		if providerModelSets[p] == nil {
			providerModelSets[p] = make(map[string]struct{})
		}
		providerModelSets[p][id] = struct{}{}
		if providerByUniqueModel[id] == "" {
			providerByUniqueModel[id] = p
		}
	}

	scannedAccounts := 0
	successfulSources := 0
	firstError := ""

	probes := modelprobes.FromSets(catalog.Sets)
	for index, set := range catalog.Sets {
		ref := set.AccountRef.String()
		if scopeGoRef != "" && ref != scopeGoRef {
			continue
		}
		provider := strings.ToLower(strings.TrimSpace(set.ProviderID))
		if provider == "" {
			provider = providerByRef[ref]
		}
		probe := probes[index]
		if probe.Probed() {
			scannedAccounts++
			accountProbedAt[ref] = probe.ProbedAt.UnixMilli()
			// 目录非空不等于本次探测成功：失败会保留旧模型，必须看探测事实。
			if probe.Succeeded {
				successfulProbeAt[ref] = probe.ProbedAt.UnixMilli()
			}
		}
		if probe.ErrorText != "" {
			errorsByAccountRef[ref] = probe.ErrorText
			if firstError == "" {
				firstError = probe.ErrorText
			}
		}

		for _, m := range set.Models {
			id := m.ModelID().String()
			if m.UpstreamAvailable() {
				addProviderModel(provider, id)
			}
			// 可选集判定只在 application 层定义一次。
			selection := accountapp.ModelSelection{
				UpstreamAvailable: m.UpstreamAvailable(),
				ManualPolicy:      m.ManualPolicy(),
			}
			if setting, hasSetting := findAccountSetting(settingByKey, resolver, ref, id); hasSetting {
				enabled := setting.Enabled
				selection.SettingEnabled = &enabled
			}
			if selection.Selectable() {
				selectableByAccountRef[ref] = appendDistinct(selectableByAccountRef[ref], id)
				addProviderModel(provider, id)
			}
		}
		if len(probe.Discovered) > 0 {
			byAccountRef[ref] = append([]string(nil), probe.Discovered...)
			successfulSources++
		}
	}

	// 若某个账号在 snapshot 有补充信息但 catalog 暂无行，则做幂等并入。
	if snapshot != nil && snapshot.Available {
		for snapKey, snapModels := range snapshot.ByAccount {
			ref := mapAccountKeyToOutputRef(snapKey, providerByRef, resolver)
			if ref == "" || (scopeGoRef != "" && ref != scopeGoRef) {
				continue
			}
			provider := providerByRef[ref]
			if _, exists := byAccountRef[ref]; !exists && len(snapModels) > 0 {
				copied := make([]string, 0, len(snapModels))
				for _, id := range snapModels {
					if trimmed := strings.TrimSpace(id); trimmed != "" {
						copied = appendDistinct(copied, trimmed)
						addProviderModel(provider, trimmed)
						if setting, ok := findAccountSetting(settingByKey, resolver, ref, trimmed); !ok || setting.Enabled {
							selectableByAccountRef[ref] = appendDistinct(selectableByAccountRef[ref], trimmed)
						}
					}
				}
				if len(copied) > 0 {
					byAccountRef[ref] = copied
				}
			}
		}
		for snapKey, ts := range snapshot.AccountUpdatedAt {
			ref := mapAccountKeyToOutputRef(snapKey, providerByRef, resolver)
			if ref == "" || (scopeGoRef != "" && ref != scopeGoRef) || ts <= 0 {
				continue
			}
			if ts > accountProbedAt[ref] {
				accountProbedAt[ref] = ts
			}
		}
		for snapKey, errMsg := range snapshot.ErrorsByAccount {
			ref := mapAccountKeyToOutputRef(snapKey, providerByRef, resolver)
			if ref == "" || (scopeGoRef != "" && ref != scopeGoRef) || strings.TrimSpace(errMsg) == "" {
				continue
			}
			// 只比较该错误同键的可信账号探测时间（v2+），不能借用整份缓存或
			// 其它 ref 别名的时刻给旧错误续命。Go 同刻或更晚的成功压住旧/无时刻
			// 错误，更新的失败仍保留；Go 从未探测的账号继续兼容旧快照。
			snapshotProbeAt := snapshot.AccountUpdatedAt[snapKey]
			if probedAt, succeeded := successfulProbeAt[ref]; succeeded && snapshotProbeAt <= probedAt {
				continue
			}
			if errorsByAccountRef[ref] == "" {
				errorsByAccountRef[ref] = errMsg
				if firstError == "" {
					firstError = errMsg
				}
			}
		}
	}

	// 将 settings 里手工登记且启用的模型并入 selectableByAccountRef 与 models[provider]。
	for _, record := range settings.AccountModels {
		if !record.Manual || !record.Enabled {
			continue
		}
		ref := mapAccountKeyToOutputRef(record.AccountRef, providerByRef, resolver)
		if ref == "" {
			ref = strings.TrimSpace(record.AccountRef)
		}
		if ref == "" || (scopeGoRef != "" && ref != scopeGoRef) {
			continue
		}
		modelID := strings.TrimSpace(record.ID)
		if modelID == "" {
			continue
		}
		selectableByAccountRef[ref] = appendDistinct(selectableByAccountRef[ref], modelID)
		provider := strings.ToLower(strings.TrimSpace(record.Provider))
		if provider == "" {
			provider = providerByRef[ref]
		}
		addProviderModel(provider, modelID)
	}

	for ref, ids := range byAccountRef {
		sort.Strings(ids)
		byAccountRef[ref] = ids
	}
	for ref, ids := range selectableByAccountRef {
		sort.Strings(ids)
		selectableByAccountRef[ref] = ids
	}
	for provider, set := range providerModelSets {
		list := make([]string, 0, len(set))
		for id := range set {
			list = append(list, id)
		}
		sort.Strings(list)
		modelsByProvider[provider] = list
	}

	defaultByAccountRef := map[string]string{}
	for _, record := range settings.AccountModels {
		if !record.DefaultModel || !record.Enabled {
			continue
		}
		ref := mapAccountKeyToOutputRef(record.AccountRef, providerByRef, resolver)
		if ref == "" {
			ref = strings.TrimSpace(record.AccountRef)
		}
		if ref == "" || (scopeGoRef != "" && ref != scopeGoRef) {
			continue
		}
		modelID := strings.TrimSpace(record.ID)
		if modelID == "" {
			continue
		}
		if containsString(selectableByAccountRef[ref], modelID) {
			defaultByAccountRef[ref] = modelID
		}
	}

	labels := map[string]map[string]string{}
	if snapshot != nil && snapshot.Labels != nil {
		labels = snapshot.Labels
	}

	metadata := buildMetadataMap(selectableByAccountRef, providerByUniqueModel, metadataIndex)

	updatedAt := catalog.UpdatedAtMS
	if snapshot != nil && snapshot.UpdatedAtMS > updatedAt {
		updatedAt = snapshot.UpdatedAtMS
	}

	var accountScope any
	if scopeGoRef != "" {
		accountScope = map[string]string{"accountRef": scopeGoRef}
	}
	var firstErrorVal any
	if firstError != "" {
		firstErrorVal = firstError
	}

	return map[string]any{
		"ok":                     true,
		"cached":                 cached,
		"updatedAt":              updatedAt,
		"source":                 "account_models",
		"sources":                successfulSources,
		"scannedAccounts":        scannedAccounts,
		"firstError":             firstErrorVal,
		"accountScope":           accountScope,
		"models":                 modelsByProvider,
		"byAccountRef":           byAccountRef,
		"selectableByAccountRef": selectableByAccountRef,
		"defaultByAccountRef":    defaultByAccountRef,
		"errorsByAccountRef":     errorsByAccountRef,
		"accountProbedAt":        accountProbedAt,
		"labels":                 labels,
		"metadata":               metadata,
	}
}

func buildMetadataMap(
	selectableByAccountRef map[string][]string,
	providerByModel map[string]string,
	index modelmetadata.Catalog,
) map[string]any {
	out := map[string]any{}
	if index == nil {
		return out
	}
	for _, ids := range selectableByAccountRef {
		for _, id := range ids {
			if _, exists := out[id]; exists {
				continue
			}
			provider := providerByModel[id]
			entry := map[string]any{
				"id":                    id,
				"metadataSchemaVersion": 1,
				"metadataSource":        index.SourceID(),
			}
			resolved := false
			if modalities, ok := index.LookupModalities(provider, id); ok {
				entry["modalities"] = map[string]any{
					"input":  modalities.Input(),
					"output": modalities.Output(),
				}
				resolved = true
			}
			if ctxLimit, ok := index.LookupContextWindow(provider, id); ok && ctxLimit > 0 {
				entry["limit"] = map[string]any{"context": ctxLimit}
				resolved = true
			}
			if efforts, ok := index.LookupReasoningEfforts(provider, id); ok && len(efforts) > 0 {
				effortNames := make([]string, 0, len(efforts))
				for _, effort := range efforts {
					effortNames = append(effortNames, string(effort))
				}
				entry["capabilities"] = map[string]any{
					"reasoning":        true,
					"reasoningOptions": effortNames,
				}
				resolved = true
			}
			if resolved {
				entry["metadataStatus"] = "resolved"
				out[id] = entry
			}
		}
	}
	return out
}

func indexAccountModelSettings(records []modelcatalogsettings.AccountModel, resolver accountrefmap.Resolver) map[string]modelcatalogsettings.AccountModel {
	out := make(map[string]modelcatalogsettings.AccountModel, len(records)*2)
	for _, record := range records {
		rawRef := strings.TrimSpace(record.AccountRef)
		lowerID := strings.ToLower(strings.TrimSpace(record.ID))
		if rawRef == "" || lowerID == "" {
			continue
		}
		keys := []string{rawRef + "\x00" + lowerID}
		if goRef := strings.TrimSpace(resolver.GoRef(rawRef)); goRef != "" && goRef != rawRef {
			keys = append(keys, goRef+"\x00"+lowerID)
		}
		if nodeRef := strings.TrimSpace(resolver.NodeRef(rawRef)); nodeRef != "" && nodeRef != rawRef {
			keys = append(keys, nodeRef+"\x00"+lowerID)
		}
		for _, key := range keys {
			if _, exists := out[key]; !exists {
				out[key] = record
			}
		}
	}
	return out
}

func findAccountSetting(
	index map[string]modelcatalogsettings.AccountModel,
	resolver accountrefmap.Resolver,
	goRef string,
	modelID string,
) (modelcatalogsettings.AccountModel, bool) {
	lowerID := strings.ToLower(strings.TrimSpace(modelID))
	if rec, ok := index[goRef+"\x00"+lowerID]; ok {
		return rec, true
	}
	if nodeRef := strings.TrimSpace(resolver.NodeRef(goRef)); nodeRef != "" && nodeRef != goRef {
		if rec, ok := index[nodeRef+"\x00"+lowerID]; ok {
			return rec, true
		}
	}
	return modelcatalogsettings.AccountModel{}, false
}

func mapAccountKeyToOutputRef(key string, knownGoRefs map[string]string, resolver accountrefmap.Resolver) string {
	trimmed := strings.TrimSpace(key)
	if trimmed == "" {
		return ""
	}
	if _, ok := knownGoRefs[trimmed]; ok {
		return trimmed
	}
	if goRef := strings.TrimSpace(resolver.GoRef(trimmed)); goRef != "" {
		if _, ok := knownGoRefs[goRef]; ok {
			return goRef
		}
	}
	return trimmed
}

func appendDistinct(slice []string, item string) []string {
	for _, existing := range slice {
		if existing == item {
			return slice
		}
	}
	return append(slice, item)
}

func containsString(slice []string, item string) bool {
	for _, existing := range slice {
		if existing == item {
			return true
		}
	}
	return false
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, map[string]any{
		"ok":      false,
		"error":   code,
		"message": message,
	})
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(body)
}
