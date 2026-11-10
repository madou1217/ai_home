// Package webuiopenaimodelsapi 提供 WebUI OpenAI 模型目录的 Go 部分读模型。
//
// Node 的 /v0/webui/openai-models 包含探测缓存状态（cached/source/sources/
// scannedAccounts/firstError）、模型设置派生的管理目录（managedData/settingsUpdatedAt）、
// 展示元数据（labels/metadata）、离开运行池账号的留档目录，以及 SSE 刷新任务。
//
// 本包分两层：
//   - aih.db 的 account_models 与 account_model_probes 是始终存在的真值来源，
//     发布为 models / account_models。
//   - app-state.db 的 model-catalog-settings（设置文档）与 webui-models-snapshot.json
//     （上游显示名快照）是可选来源，读到才发布 managed_data / labels /
//     settings_updated_at_ms；两者由 Node 写入，账号引用是 Node ref，必须经
//     accountrefmap 翻译成 Go 的 account_ref 才能与 account_models 对齐。
//
// 无论可选源是否接线，本包都用 derived_by=go_partial 与 filled_fields/unfilled_fields
// 显式标注边界，绝不返回空对象冒充 Node 全量形状。
package webuiopenaimodelsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// Path 是 WebUI OpenAI 模型目录的 Go 读模型契约路径。
//
//	GET /v1/management/webui/openai-models
const Path = "/v1/management/webui/openai-models"

const (
	// derivedByGoPartial 标注响应只包含 Go 能证明的字段。
	derivedByGoPartial = "go_partial"
	// dataSource 固定指向 Go 的账号模型与探测事实表。
	dataSource = "account_models"
)

// ErrInvalidDependencies 表示 Handler 缺少数据源或鉴权策略。
var ErrInvalidDependencies = errors.New("WebUI OpenAI 模型目录接口依赖无效")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 契约共用同一个 Bearer 实现）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Reader 是账号模型批量读端口（由 sqliteaccount.Store 实现）。
type Reader interface {
	ListAllAccountModels(ctx context.Context) (accountapp.AccountModelCatalog, error)
}

// Dependencies 汇总 WebUI OpenAI 模型目录的依赖。
//
// Settings / Snapshot / AccountRefs 是可选接线：未提供时对应字段留空并计入
// unfilled_fields，而不是用默认值伪造。三者的文档都在 app-state.db。
type Dependencies struct {
	Authorizer Authorizer
	Reader     Reader

	Settings    SettingsReader
	Snapshot    SnapshotReader
	AccountRefs AccountRefResolver
}

// Handler 是 WebUI OpenAI 模型目录的 HTTP 入站适配器。
type Handler struct {
	authorizer  Authorizer
	reader      Reader
	settings    SettingsReader
	snapshot    SnapshotReader
	accountRefs AccountRefResolver
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Reader == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		reader:      dependencies.Reader,
		settings:    dependencies.Settings,
		snapshot:    dependencies.Snapshot,
		accountRefs: dependencies.AccountRefs,
	}, nil
}

// response 是成功响应。
//
// models 是按模型 ID 聚合后的稳定视图；account_models 保留每个账号的原始模型关系与
// 探测事实；managed_data 是模型设置维度的管理条目（含手动添加与被停用的模型）；
// labels 是上游显示名。三者都不是 Node 的 data：Node 的 data 还叠加别名、网关能力
// 目录与 models.dev 元数据，本包没有这些源。
type response struct {
	OK                 bool               `json:"ok"`
	DerivedBy          string             `json:"derived_by"`
	DataSource         string             `json:"data_source"`
	Generation         int64              `json:"generation"`
	CatalogUpdatedAtMS int64              `json:"catalog_updated_at_ms"`
	Models             []modelView        `json:"models"`
	AccountModels      []accountModelView `json:"account_models"`
	// ManagedData 只在读到设置文档时出现；nil 与「空管理目录」不是同一件事。
	ManagedData []managedModelView `json:"managed_data,omitempty"`
	// Labels 只在快照可用时出现；空对象表示快照确实没有显示名。
	Labels              *labelsView `json:"labels,omitempty"`
	SettingsUpdatedAtMS int64       `json:"settings_updated_at_ms,omitempty"`
	// UnavailableSources 记录「接了线但读失败」的源，供调用方区分「没有事实」与「读不到」。
	UnavailableSources []string `json:"unavailable_sources"`
	FilledFields       []string `json:"filled_fields"`
	UnfilledFields     []string `json:"unfilled_fields"`
}

// modelView 是一个模型 ID 的聚合视图。
//
// 同一个模型可能被多个账号发现：providers/account_refs 是去重后的集合；
// upstream_available 与 effective 表示「至少有一个账号」满足，而不是所有账号。
type modelView struct {
	ID                string   `json:"id"`
	Providers         []string `json:"providers"`
	AccountRefs       []string `json:"account_refs"`
	UpstreamAvailable bool     `json:"upstream_available"`
	Effective         bool     `json:"effective"`
}

// accountModelView 是一个账号的模型 ID 与探测事实。
//
// model_ids 包含上游已下架与人工停用的行；effective_model_ids 是 Go 路由索引
// 会采纳的子集。它与 Node 的「可选集」不同：后者还叠加模型设置与运行池。
type accountModelView struct {
	ProviderID        string   `json:"provider_id"`
	AccountRef        string   `json:"account_ref"`
	ModelIDs          []string `json:"model_ids"`
	EffectiveModelIDs []string `json:"effective_model_ids"`
	LastAttemptAtMS   int64    `json:"last_attempt_at_ms"`
	LastErrorCode     string   `json:"last_error_code"`
	LastErrorMessage  string   `json:"last_error_message"`
	LastSource        string   `json:"last_source"`
	LastModelCount    int      `json:"last_model_count"`
}

// 字段清单分组：filled_fields 与 unfilled_fields 都由这些分组派生，
// 新增字段时只改分组，不会出现两边都写或两边都漏。
var (
	// catalogFieldKeys 只依赖 aih.db 的账号模型事实，永远填充。
	catalogFieldKeys = []string{
		"generation",
		"catalog_updated_at_ms",
		"models",
		"account_models",
		"id",
		"providers",
		"account_refs",
		"upstream_available",
		"effective",
		"provider_id",
		"account_ref",
		"model_ids",
		"effective_model_ids",
		"last_attempt_at_ms",
		"last_error_code",
		"last_error_message",
		"last_source",
		"last_model_count",
		"unavailable_sources",
	}
	// settingsFieldKeys 需要 model-catalog-settings 文档。
	settingsFieldKeys = []string{
		"managed_data",
		"settings_updated_at_ms",
		"managed_data.id",
		"managed_data.provider",
		"managed_data.account_ref",
		"managed_data.enabled",
		"managed_data.manual",
		"managed_data.default_model",
		"managed_data.source",
		"managed_data.providers",
		"managed_data.description",
		"managed_data.custom_pricing",
		"managed_data.updated_at_ms",
	}
	// snapshotFieldKeys 需要 WebUI 模型快照。
	snapshotFieldKeys = []string{
		"labels",
	}
)

// nodeOnlyFieldKeys 是 Node 的 /v0/webui/openai-models 有、Go 仍无真值来源的键。
//
// 分组说明：
//   - data / metadata / managedData.metadata：Node 的展示目录与 models.dev 全量元数据
//     （价格、模态、上下文）。managed_data 的条目级 metadata 因此仍在缺口里。
//   - cached / source / sources / scannedAccounts / firstError：Node 探测缓存聚合。
//   - accounts / byProvider / byAccountRef / errorsByAccountRef / accountProbedAt：
//     Node 账号 ref 口径的汇总；Go 只有 account_ref 口径的 account_models。
//   - accountScope：Node accountRef 与 Go account_ref 不是同一个值，本端点不支持过滤。
//   - data.*：Node 单个模型项的展示/设置字段（object/created/owned_by/模态/价格等）。
//   - SSE：watch 与 refresh 任务仍由 Node 负责。
var nodeOnlyFieldKeys = []string{
	"endpoint",
	"cached",
	"updatedAt",
	"source",
	"sources",
	"scannedAccounts",
	"firstError",
	"accountScope",
	"data",
	"metadata",
	"managedData.metadata",
	"accounts",
	"byProvider",
	"byAccountRef",
	"errorsByAccountRef",
	"accountProbedAt",
	"data.object",
	"data.created",
	"data.owned_by",
	"data.aih_modalities",
	"data.aih_reasoning_efforts",
	"data.enabled",
	"data.manual",
	"data.defaultModel",
	"data.providers",
	"data.description",
	"data.customPricing",
	"data.updatedAt",
	"data.retained",
	"data.aliasEntries",
	"data.gatewayCapabilities",
	"data.manualEntries",
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type errorResponse struct {
	OK    bool      `json:"ok"`
	Error errorBody `json:"error"`
}

func (handler *Handler) ServeHTTP(responseWriter http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.reader == nil {
		writeError(responseWriter, http.StatusServiceUnavailable, "webui_openai_models_unavailable", "WebUI 模型目录不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		responseWriter.Header().Set("WWW-Authenticate", "Bearer")
		writeError(responseWriter, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		responseWriter.Header().Set("Allow", http.MethodGet)
		writeError(responseWriter, http.StatusMethodNotAllowed, "method_not_allowed", "只支持读取 WebUI 模型目录")
		return
	}
	// 不接受任何查询参数：Node 的 accountRef 与 Go 的 account_ref 不是同一个值，
	// 静默忽略会返回全部账号，让调用方误以为过滤生效。
	if strings.TrimSpace(request.URL.RawQuery) != "" {
		writeError(responseWriter, http.StatusBadRequest, "invalid_query", "WebUI 模型目录暂不支持查询参数")
		return
	}
	catalog, err := handler.reader.ListAllAccountModels(request.Context())
	if err != nil {
		writeError(responseWriter, http.StatusServiceUnavailable, "webui_openai_models_failed", "WebUI 模型目录读取失败")
		return
	}
	enrich := newEnrichment(request.Context(), handler.accountRefs, handler.settings, handler.snapshot)
	writeJSON(responseWriter, http.StatusOK, newResponse(catalog, enrich))
}

// modelAggregate 聚合同一个模型 ID 在多个账号上的事实。
type modelAggregate struct {
	providers         map[string]struct{}
	accountRefs       map[string]struct{}
	upstreamAvailable bool
	effective         bool
}

// newResponse 把账号模型目录翻译成模型聚合与账号事实两份稳定视图，
// 再按实际读到的可选源补上管理目录与显示名。
func newResponse(catalog accountapp.AccountModelCatalog, enrich *enrichment) response {
	accountModels := make([]accountModelView, 0, len(catalog.Sets))
	aggregates := make(map[string]*modelAggregate)
	providerIDs := make(map[string]struct{}, len(catalog.Sets))
	for _, set := range catalog.Sets {
		accountModels = append(accountModels, newAccountModelView(set))
		if providerID := strings.TrimSpace(set.ProviderID); providerID != "" {
			providerIDs[providerID] = struct{}{}
		}
		for _, model := range set.Models {
			modelID := model.ModelID().String()
			aggregate := aggregates[modelID]
			if aggregate == nil {
				aggregate = &modelAggregate{
					providers:   make(map[string]struct{}),
					accountRefs: make(map[string]struct{}),
				}
				aggregates[modelID] = aggregate
			}
			if providerID := strings.TrimSpace(set.ProviderID); providerID != "" {
				aggregate.providers[providerID] = struct{}{}
			}
			if accountRef := set.AccountRef.String(); accountRef != "" {
				aggregate.accountRefs[accountRef] = struct{}{}
			}
			if model.UpstreamAvailable() {
				aggregate.upstreamAvailable = true
			}
			if model.Effective() {
				aggregate.effective = true
			}
		}
	}
	sort.Slice(accountModels, func(left, right int) bool {
		if accountModels[left].ProviderID != accountModels[right].ProviderID {
			return accountModels[left].ProviderID < accountModels[right].ProviderID
		}
		return accountModels[left].AccountRef < accountModels[right].AccountRef
	})
	models := make([]modelView, 0, len(aggregates))
	for modelID, aggregate := range aggregates {
		models = append(models, modelView{
			ID:                modelID,
			Providers:         sortedKeys(aggregate.providers),
			AccountRefs:       sortedKeys(aggregate.accountRefs),
			UpstreamAvailable: aggregate.upstreamAvailable,
			Effective:         aggregate.effective,
		})
	}
	sort.Slice(models, func(left, right int) bool {
		return models[left].ID < models[right].ID
	})

	managedData := enrich.managedData(catalog)
	for _, item := range managedData {
		if item.Provider != "" {
			providerIDs[item.Provider] = struct{}{}
		}
	}
	filled, unfilled := fieldCoverage(enrich)
	settingsUpdatedAtMS, _ := enrich.settingsUpdatedAtMS()
	return response{
		OK:                  true,
		DerivedBy:           derivedByGoPartial,
		DataSource:          dataSource,
		Generation:          catalog.Generation,
		CatalogUpdatedAtMS:  catalog.UpdatedAtMS,
		Models:              models,
		AccountModels:       accountModels,
		ManagedData:         managedData,
		Labels:              enrich.labelProjection(sortedKeys(providerIDs)),
		SettingsUpdatedAtMS: settingsUpdatedAtMS,
		UnavailableSources:  enrich.unavailableSources(),
		FilledFields:        filled,
		UnfilledFields:      unfilled,
	}
}

// fieldCoverage 按本次实际读到的源切分字段清单。
//
// 两个清单都是「本次响应真实提供的键」与「Node 有但没有源的键」的划分：
// 同一次响应里同一个键不会两边都出现，也不会两边都漏。
func fieldCoverage(enrich *enrichment) (filled []string, unfilled []string) {
	hasSettings := enrich != nil && enrich.hasSettings
	hasSnapshot := enrich != nil && enrich.hasSnapshot
	filled = make([]string, 0, len(catalogFieldKeys)+len(settingsFieldKeys)+len(snapshotFieldKeys))
	filled = append(filled, catalogFieldKeys...)
	if hasSettings {
		filled = append(filled, settingsFieldKeys...)
	}
	if hasSnapshot {
		filled = append(filled, snapshotFieldKeys...)
	}
	unfilled = make([]string, 0, len(nodeOnlyFieldKeys)+3)
	unfilled = append(unfilled, nodeOnlyFieldKeys...)
	if !hasSettings {
		unfilled = append(unfilled, "managedData", "settingsUpdatedAt")
	}
	if !hasSnapshot {
		unfilled = append(unfilled, "labels")
	}
	return filled, unfilled
}

// newAccountModelView 把一条账号模型快照翻译成稳定排序的视图。
func newAccountModelView(set accountapp.AccountModelSet) accountModelView {
	modelIDs := make([]string, 0, len(set.Models))
	effectiveModelIDs := make([]string, 0, len(set.Models))
	for _, model := range set.Models {
		modelID := model.ModelID().String()
		modelIDs = append(modelIDs, modelID)
		if model.Effective() {
			effectiveModelIDs = append(effectiveModelIDs, modelID)
		}
	}
	sort.Strings(modelIDs)
	sort.Strings(effectiveModelIDs)
	// 零值时间不能直接 UnixMilli()：会得到负数，调用方会把它当成一次真实探测。
	var lastAttemptAtMS int64
	if !set.LastAttemptAt.IsZero() {
		lastAttemptAtMS = set.LastAttemptAt.UnixMilli()
	}
	return accountModelView{
		ProviderID:        set.ProviderID,
		AccountRef:        set.AccountRef.String(),
		ModelIDs:          modelIDs,
		EffectiveModelIDs: effectiveModelIDs,
		LastAttemptAtMS:   lastAttemptAtMS,
		LastErrorCode:     set.LastErrorCode,
		LastErrorMessage:  set.LastErrorMessage,
		LastSource:        set.LastSource,
		LastModelCount:    set.LastModelCount,
	}
}

func sortedKeys(values map[string]struct{}) []string {
	keys := make([]string, 0, len(values))
	for value := range values {
		keys = append(keys, value)
	}
	sort.Strings(keys)
	return keys
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, errorResponse{OK: false, Error: errorBody{Code: code, Message: message}})
}
