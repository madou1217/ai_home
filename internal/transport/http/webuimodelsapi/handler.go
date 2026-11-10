// Package webuimodelsapi 提供「按 Provider 分组、按账号归属」的模型只读 WebUI 契约。
//
// 数据边界：唯一数据源是 Go 的 aih.db.account_models 与 account_model_probes
// （通过 application/accounts.AccountModelCatalog 读出）。Node 的 /v0/webui/models
// 还包含展示元数据（labels / metadata）、由模型设置派生的可选集
// （selectableByAccountRef / defaultByAccountRef）以及探测缓存状态；这些事实不在 Go 里，
// 本包不伪造，而是用 derived_by=go_partial 与 filled_fields/unfilled_fields 显式标注。
//
// 账号集合边界：只包含 account_models 或 account_model_probes 有行的账号；从未探测且
// 没有模型行的账号不会出现在 providers 里（账号本身由 /v1/management/webui/accounts 提供）。
//
// 标识边界：account_ref 是 Go 的 acct_* 稳定引用，不是 Node 的账号 ref；跨端比较前
// 必须先做 Node→Go 映射。
package webuimodelsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// Path 是模型只读投影的 WebUI 契约路径。
//
//	GET /v1/management/webui/models
const Path = "/v1/management/webui/models"

const (
	// derivedByGoPartial 标注响应只包含 Go 能证明的字段，调用方不得把它当成 Node 全量形状。
	derivedByGoPartial = "go_partial"
	// dataSource 固定指向 Go 的账号模型事实表。
	dataSource = "account_models"
)

// ErrInvalidDependencies 表示 Handler 缺少数据源或鉴权策略。
var ErrInvalidDependencies = errors.New("模型 WebUI 读模型接口依赖无效")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 契约共用同一个 Bearer 实现）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Reader 是账号模型批量读端口（由 sqliteaccount.Store 实现）。
//
// 只依赖应用层快照而不是传输层重新拼 SQL：分组、排序、有效模型判定都沿用
// 账号模型管理的既有口径，避免第二个读实现。
type Reader interface {
	ListAllAccountModels(ctx context.Context) (accountapp.AccountModelCatalog, error)
}

// Dependencies 汇总模型只读投影的依赖。
type Dependencies struct {
	Authorizer Authorizer
	Reader     Reader
}

// Handler 是模型只读投影的 HTTP 入站适配器。
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
// 三个字段清单是契约的一部分：filled_fields 列出本响应真实填充的数据键，
// unfilled_fields 列出 Node /v0/webui/models（及模型管理页）有、但 Go 没有事实来源的键。
type response struct {
	OK                 bool           `json:"ok"`
	DerivedBy          string         `json:"derived_by"`
	DataSource         string         `json:"data_source"`
	Generation         int64          `json:"generation"`
	CatalogUpdatedAtMS int64          `json:"catalog_updated_at_ms"`
	Providers          []providerView `json:"providers"`
	FilledFields       []string       `json:"filled_fields"`
	UnfilledFields     []string       `json:"unfilled_fields"`
}

// providerView 是一个 Provider 下的账号模型集合。
type providerView struct {
	ProviderID string        `json:"provider_id"`
	Accounts   []accountView `json:"accounts"`
}

// accountView 是一个账号的模型 ID 与探测事实。
//
// model_ids 是 account_models 里的全部行（含上游已下架/人工停用的模型）；
// effective_model_ids 是 Go 路由索引会采纳的子集。两者都不是 Node 的
// selectableByAccountRef：后者还会叠加 Node 的模型设置与运行池。
type accountView struct {
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
	"providers",
	"provider_id",
	"accounts",
	"account_ref",
	"model_ids",
	"effective_model_ids",
	"last_attempt_at_ms",
	"last_error_code",
	"last_error_message",
	"last_source",
	"last_model_count",
}

// unfilledFields 是 Node 模型接口有、Go 当前没有真值来源的键。
//
// 分组说明：
//   - models / labels / metadata：Node 的展示目录（标题、描述、上下文窗口、模态、价格）。
//   - selectableByAccountRef / defaultByAccountRef：叠加了 Node 模型设置与运行池；
//     Go 只有路由有效集，不能直接当作「可选集」。
//   - errorsByAccountRef / accountProbedAt / cached / source / sources /
//     scannedAccounts / firstError：Node 探测缓存级的聚合事实；Go 只有每账号 last_*。
//   - accountScope：Node 账号 ref 与 Go account_ref 的翻译/作用域。
//   - managedData / settingsUpdatedAt：模型管理页（/v0/webui/openai-models）字段。
var unfilledFields = []string{
	"models",
	"labels",
	"metadata",
	"selectableByAccountRef",
	"defaultByAccountRef",
	"errorsByAccountRef",
	"accountProbedAt",
	"cached",
	"source",
	"sources",
	"scannedAccounts",
	"firstError",
	"accountScope",
	"managedData",
	"settingsUpdatedAt",
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
		writeError(responseWriter, http.StatusServiceUnavailable, "webui_models_unavailable", "模型读模型不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		responseWriter.Header().Set("WWW-Authenticate", "Bearer")
		writeError(responseWriter, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		responseWriter.Header().Set("Allow", http.MethodGet)
		writeError(responseWriter, http.StatusMethodNotAllowed, "method_not_allowed", "只支持读取模型投影")
		return
	}
	// 不接受任何查询参数：Node 的 accountRef 作用域与 Go 的 account_ref 不是同一个值。
	// 静默忽略会返回全部 Provider，让调用方误以为过滤生效；显式 400 更容易排查。
	if strings.TrimSpace(request.URL.RawQuery) != "" {
		writeError(responseWriter, http.StatusBadRequest, "invalid_query", "模型投影暂不支持查询参数")
		return
	}
	catalog, err := handler.reader.ListAllAccountModels(request.Context())
	if err != nil {
		writeError(responseWriter, http.StatusServiceUnavailable, "webui_models_failed", "模型投影读取失败")
		return
	}
	writeJSON(responseWriter, http.StatusOK, newResponse(catalog))
}

// newResponse 把账号模型目录按 Provider / 账号稳定分组。
func newResponse(catalog accountapp.AccountModelCatalog) response {
	grouped := make(map[string][]accountView, len(catalog.Sets))
	for _, set := range catalog.Sets {
		grouped[set.ProviderID] = append(grouped[set.ProviderID], newAccountView(set))
	}
	providers := make([]providerView, 0, len(grouped))
	for providerID, accounts := range grouped {
		sort.Slice(accounts, func(left, right int) bool {
			return accounts[left].AccountRef < accounts[right].AccountRef
		})
		providers = append(providers, providerView{
			ProviderID: providerID,
			Accounts:   accounts,
		})
	}
	sort.Slice(providers, func(left, right int) bool {
		return providers[left].ProviderID < providers[right].ProviderID
	})
	return response{
		OK:                 true,
		DerivedBy:          derivedByGoPartial,
		DataSource:         dataSource,
		Generation:         catalog.Generation,
		CatalogUpdatedAtMS: catalog.UpdatedAtMS,
		Providers:          providers,
		FilledFields:       filledFields,
		UnfilledFields:     unfilledFields,
	}
}

// newAccountView 把一条账号模型快照翻译成稳定排序的视图。
func newAccountView(set accountapp.AccountModelSet) accountView {
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
	return accountView{
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

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, errorResponse{OK: false, Error: errorBody{Code: code, Message: message}})
}
