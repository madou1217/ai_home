// Package webuiopenaimodelsapi 提供 WebUI OpenAI 模型目录的 Go 部分读模型。
//
// Node 的 /v0/webui/openai-models 还包含探测缓存状态（cached/source/sources/
// scannedAccounts/firstError）、模型设置（managedData/settingsUpdatedAt）、
// 展示元数据（labels/metadata）、离开运行池账号的留档目录，以及 SSE 刷新任务。
// 这些事实没有 Go 真值来源。本包只发布 aih.db 的 account_models 与
// account_model_probes 能证明的字段，并用 derived_by=go_partial 与
// filled_fields/unfilled_fields 显式标注边界，绝不返回空对象冒充 Node 全量形状。
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
type Dependencies struct {
	Authorizer Authorizer
	Reader     Reader
}

// Handler 是 WebUI OpenAI 模型目录的 HTTP 入站适配器。
type Handler struct {
	authorizer Authorizer
	reader     Reader
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Reader == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: dependencies.Authorizer, reader: dependencies.Reader}, nil
}

// response 是成功响应。
//
// models 是按模型 ID 聚合后的稳定视图；account_models 保留每个账号的原始模型
// 关系与探测事实。两者都不是 Node 的 data/managedData：Node 的 enabled/manual/
// defaultModel 来自模型设置，Go 只有账号模型的上游可用性与人工策略。
type response struct {
	OK                 bool               `json:"ok"`
	DerivedBy          string             `json:"derived_by"`
	DataSource         string             `json:"data_source"`
	Generation         int64              `json:"generation"`
	CatalogUpdatedAtMS int64              `json:"catalog_updated_at_ms"`
	Models             []modelView        `json:"models"`
	AccountModels      []accountModelView `json:"account_models"`
	FilledFields       []string           `json:"filled_fields"`
	UnfilledFields     []string           `json:"unfilled_fields"`
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

// filledFields 是本响应真实提供的数据键（不含 ok/derived_by/data_source 这类 envelope）。
var filledFields = []string{
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
}

// unfilledFields 是 Node 的 /v0/webui/openai-models 有、Go 当前没有真值来源的键。
//
// 分组说明：
//   - data / managedData / metadata / labels：Node 的展示目录、模型设置与 models.dev 全量元数据。
//   - cached / source / sources / scannedAccounts / firstError：Node 探测缓存聚合。
//   - accounts / byProvider / byAccountRef / errorsByAccountRef / accountProbedAt：
//     Node 账号 ref 口径的汇总；Go 只有 account_ref 口径的 account_models。
//   - accountScope：Node accountRef 与 Go account_ref 不是同一个值，本端点不支持过滤。
//   - settingsUpdatedAt：模型设置更新时间。
//   - data.*：Node 单个模型项的展示/设置字段（object/created/owned_by/模态/价格等）。
//   - SSE：watch 与 refresh 任务仍由 Node 负责。
var unfilledFields = []string{
	"endpoint",
	"cached",
	"updatedAt",
	"source",
	"sources",
	"scannedAccounts",
	"firstError",
	"accountScope",
	"data",
	"managedData",
	"metadata",
	"labels",
	"accounts",
	"byProvider",
	"byAccountRef",
	"errorsByAccountRef",
	"accountProbedAt",
	"settingsUpdatedAt",
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
	writeJSON(responseWriter, http.StatusOK, newResponse(catalog))
}

// modelAggregate 聚合同一个模型 ID 在多个账号上的事实。
type modelAggregate struct {
	providers         map[string]struct{}
	accountRefs       map[string]struct{}
	upstreamAvailable bool
	effective         bool
}

// newResponse 把账号模型目录翻译成模型聚合与账号事实两份稳定视图。
func newResponse(catalog accountapp.AccountModelCatalog) response {
	accountModels := make([]accountModelView, 0, len(catalog.Sets))
	aggregates := make(map[string]*modelAggregate)
	for _, set := range catalog.Sets {
		accountModels = append(accountModels, newAccountModelView(set))
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
	return response{
		OK:                 true,
		DerivedBy:          derivedByGoPartial,
		DataSource:         dataSource,
		Generation:         catalog.Generation,
		CatalogUpdatedAtMS: catalog.UpdatedAtMS,
		Models:             models,
		AccountModels:      accountModels,
		FilledFields:       filledFields,
		UnfilledFields:     unfilledFields,
	}
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
