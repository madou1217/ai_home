// Package webuimodelsapi 提供「按 Provider 分组、按账号归属」的模型只读 WebUI 契约。
//
// 数据边界：
//   - 骨架来自 Go 的 aih.db.account_models 与 account_model_probes（通过
//     application/accounts.AccountModelCatalog 读出）：账号、模型 id、路由有效集与每账号的
//     上次探测结果只认这一份事实表。
//   - 展示与设置事实按来源可用性叠加：modelcatalogsettings（app-state 的
//     model-catalog-settings）提供 (账号, 模型) 的开关 / 手工标记 / 默认标记 / 描述 / 自定义价；
//     webuimodelssnapshot（cache:webui-models-snapshot.json）提供上游显示名、上下文窗口与
//     账号真正被探测的时刻；accountrefmap 负责把 Go account_ref 翻成 Node 账号引用再去查
//     这两份文档（没有链接时按恒等回落）。
//   - 三份外部事实都可选：读不到就整块不填，用 filled_fields / unfilled_fields 与
//     unavailable_sources 显式标注，绝不用空对象冒充已知。
//
// 账号集合边界：只包含 account_models 或 account_model_probes 有行的账号；从未探测且
// 没有模型行的账号不会出现在 providers 里（账号本身由 /v1/management/webui/accounts 提供）。
//
// 标识边界：account_ref 是 Go 的 acct_* 稳定引用，不是 Node 的账号 ref。Node→Go 翻译只在
// 包内用于查设置与快照；对外一律输出 Go 引用，调用方不能把响应里的引用当 Node 引用用。
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
	// dataSource 固定指向 Go 的账号模型事实表（响应骨架的唯一来源）。
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
//
// Settings / Snapshot / Refs 是可选的：不接线时响应只含 Go 事实表能证明的字段，
// 其余键留在 unfilled_fields 里，而不是用零值假装已填。
type Dependencies struct {
	Authorizer Authorizer
	Reader     Reader
	// Settings 读 app-state 的 model-catalog-settings（账号×模型设置）。
	Settings SettingsReader
	// Snapshot 读 WebUI 模型快照（显示名、上下文窗口、探测时刻）。
	Snapshot SnapshotReader
	// Refs 做 Go→Node 账号引用翻译；零值时按恒等处理。
	Refs AccountRefResolver
}

// Handler 是模型只读投影的 HTTP 入站适配器。
type Handler struct {
	authorizer Authorizer
	reader     Reader
	settings   SettingsReader
	snapshot   SnapshotReader
	refs       AccountRefResolver
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Reader == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		reader:     dependencies.Reader,
		settings:   dependencies.Settings,
		snapshot:   dependencies.Snapshot,
		refs:       dependencies.Refs,
	}, nil
}

// labelsView 是 provider -> 模型 id -> 上游显示名。
//
// 用指针承载整个映射：快照缺失时键整体省略（未知），快照存在但没有显示名时输出 {}（已知为空），
// 两种状态不能混成同一个空对象。
type labelsView map[string]map[string]string

// response 是成功响应。
//
// 两个字段清单是契约的一部分：filled_fields 列出本次真正填充的数据键，
// unfilled_fields 列出 Node /v0/webui/models（及模型管理页）有、而本次没有可信来源的键。
type response struct {
	OK                  bool           `json:"ok"`
	DerivedBy           string         `json:"derived_by"`
	DataSource          string         `json:"data_source"`
	Generation          int64          `json:"generation"`
	CatalogUpdatedAtMS  int64          `json:"catalog_updated_at_ms"`
	SettingsUpdatedAtMS int64          `json:"settings_updated_at_ms,omitempty"`
	SnapshotUpdatedAtMS int64          `json:"snapshot_updated_at_ms,omitempty"`
	Providers           []providerView `json:"providers"`
	Labels              *labelsView    `json:"labels,omitempty"`
	UnavailableSources  []string       `json:"unavailable_sources"`
	FilledFields        []string       `json:"filled_fields"`
	UnfilledFields      []string       `json:"unfilled_fields"`
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
// selectableByAccountRef：后者以 Node 账号 ref 为键并叠加运行池语义，见 unfilled 说明。
type accountView struct {
	AccountRef        string      `json:"account_ref"`
	ModelIDs          []string    `json:"model_ids"`
	EffectiveModelIDs []string    `json:"effective_model_ids"`
	ProbedAtMS        int64       `json:"probed_at_ms,omitempty"`
	ModelDetails      []modelView `json:"model_details,omitempty"`
	LastAttemptAtMS   int64       `json:"last_attempt_at_ms"`
	LastErrorCode     string      `json:"last_error_code"`
	LastErrorMessage  string      `json:"last_error_message"`
	LastSource        string      `json:"last_source"`
	LastModelCount    int         `json:"last_model_count"`
}

// 仍然无来源的键及原因（仅文档用途，不进入响应）：
//
//   - models / metadata：Node 的展示目录（provider->ids 与 models.dev 元数据；标题、模态、价格）。
//     本包按 provider/账号/模型维度输出同一批模型，metadata 需要 models.dev 目录，故整块不填。
//   - selectableByAccountRef / defaultByAccountRef：以 Node 账号 ref 为键的聚合集合；
//     本包已把同等开关事实放在 model_details[].setting，但不复制一份 Node-ref 键的集合，
//     避免跨端身份误用。
//   - errorsByAccountRef：每账号错误已由 last_error_message 表达（Go 事实表），不重复映射。
//   - cached / source / sources / scannedAccounts / firstError：Node 刷新流程的运行态聚合，
//     Go 没有对应的刷新流水线。
//   - accountScope：Node 账号 ref 的查询作用域；本接口不接受查询参数。
//   - managedData：模型管理页的整页聚合（含未探测账号），属于另一条契约。

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
	// 可选事实源读失败不影响主数据：降级为空并在 unavailable_sources 里说明。
	enrich := newEnricher(request.Context(), handler.refs, handler.settings, handler.snapshot)
	writeJSON(responseWriter, http.StatusOK, newResponse(catalog, enrich))
}

// newResponse 把账号模型目录按 Provider / 账号稳定分组，并叠加可证实的设置与展示事实。
func newResponse(catalog accountapp.AccountModelCatalog, enrich *enricher) response {
	grouped := make(map[string][]accountView, len(catalog.Sets))
	for _, set := range catalog.Sets {
		grouped[set.ProviderID] = append(grouped[set.ProviderID], newAccountView(set, enrich))
	}
	providers := make([]providerView, 0, len(grouped))
	providerIDs := make([]string, 0, len(grouped))
	for providerID, accounts := range grouped {
		sort.Slice(accounts, func(left, right int) bool {
			return accounts[left].AccountRef < accounts[right].AccountRef
		})
		providers = append(providers, providerView{
			ProviderID: providerID,
			Accounts:   accounts,
		})
		providerIDs = append(providerIDs, providerID)
	}
	sort.Slice(providers, func(left, right int) bool {
		return providers[left].ProviderID < providers[right].ProviderID
	})
	sort.Strings(providerIDs)
	filledFields, unfilledFields := enrich.fieldCoverage()
	return response{
		OK:                  true,
		DerivedBy:           derivedByGoPartial,
		DataSource:          dataSource,
		Generation:          catalog.Generation,
		CatalogUpdatedAtMS:  catalog.UpdatedAtMS,
		SettingsUpdatedAtMS: enrich.settingsUpdatedAtMS(),
		SnapshotUpdatedAtMS: enrich.snapshotUpdatedAtMS(),
		Providers:           providers,
		Labels:              enrich.labels(providerIDs),
		UnavailableSources:  enrich.unavailableSources(),
		FilledFields:        filledFields,
		UnfilledFields:      unfilledFields,
	}
}

// newAccountView 把一条账号模型快照翻译成稳定排序的视图。
func newAccountView(set accountapp.AccountModelSet, enrich *enricher) accountView {
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
	accountRef := set.AccountRef.String()
	nodeRef := enrich.nodeRef(accountRef)
	return accountView{
		AccountRef:        accountRef,
		ModelIDs:          modelIDs,
		EffectiveModelIDs: effectiveModelIDs,
		ProbedAtMS:        enrich.probedAtMS(nodeRef),
		ModelDetails:      enrich.modelDetails(nodeRef, set.Models),
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
