// Package webuiroutingweightsapi 提供 WebUI 路由权重诊断的只读 HTTP 契约。
//
// 路由（由 aihserver/webui_routing_weights_routes.go 装配）：
//
//	GET /v1/management/webui/routing/weights?provider=<p>&model=<m>
//
// 本包把 Node web-ui-router + account-selector.describeSelectionWeights +
// model-account-pool-selector.selectPoolAccountsForModel 收敛到 Go 真相源：
// 账号池、模型目录收窄、运行态资格判定、实时并发/速率负载与概率计算均在此处完成，
// 保证诊断页展示的权重与概率与 Go 路由征召完全同口径。
package webuiroutingweightsapi

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountrouting"
	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
	"github.com/madou1217/ai_home/internal/runtime/sessionactivity"
)

const (
	// Path 是路由权重诊断接口的 Go 管理面路径。
	//
	//	Node: GET /v0/webui/routing/weights
	Path = "/v1/management/webui/routing/weights"

	// unknownRemainingWeight 与 Node ACCOUNT_SELECTION_UNKNOWN_WEIGHT 一致。
	unknownRemainingWeight = 50.0
	// minSelectionRemainingPct / maxSelectionRemainingPct 与 Node 权重夹逼范围一致。
	minSelectionRemainingPct = 1.0
	maxSelectionRemainingPct = 100.0
	// defaultRateWindowMS 与 Node ACCOUNT_SELECTION_RATE_WINDOW_MS（10s）一致。
	defaultRateWindowMS = int64(10_000)
	// agyMaxSnapshotAgeMS 与 Node MODEL_WINDOW_MAX_SNAPSHOT_AGE_MS（10 分钟）一致。
	agyMaxSnapshotAgeMS = int64(10 * 60 * 1000)
)

// ErrInvalidDependencies 表示路由权重接口缺少必要的鉴权或账号池端口。
var ErrInvalidDependencies = errors.New("路由权重诊断接口依赖无效")

// Authorizer 校验管理面请求（与其他 /v1/management/webui 接口共享权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// PoolAccount 表示某 Provider 路由池内单个账号的只读快照。
type PoolAccount struct {
	AccountRef        string
	Provider          string
	CLIAccountID      *int64
	Email             string
	Enabled           bool
	Configured        bool
	APIKeyMode        bool
	RemainingPct      *float64
	UsageSnapshot     map[string]any
	QuotaStatus       string
	SchedulableStatus string
}

// PoolSource 读取指定 Provider 的路由池候选账号列表。
type PoolSource interface {
	ListProviderPool(ctx context.Context, provider string) ([]PoolAccount, error)
}

// ModelCatalogSource 提供持久化账号模型目录（account_models + 探针记录）。
type ModelCatalogSource interface {
	ListAllAccountModels(ctx context.Context) (accountapp.AccountModelCatalog, error)
}

// ModelSettingsSource 提供 WebUI 持久化的模型启停设置（model-catalog-settings）。
type ModelSettingsSource interface {
	LoadModelSettings(ctx context.Context) (modelcatalogsettings.Settings, error)
}

// RuntimeSource 提供 Go 进程内运行态快照（阻塞、模型 cooldown、最近结果）。
type RuntimeSource interface {
	RuntimeSnapshot() []runtimeapp.AccountView
}

// RuntimeEligibilitySource 提供实时的 (账号, 模型) 路由资格查询。
type RuntimeEligibilitySource interface {
	CheckEligibility(ctx context.Context, route runtimecore.ModelRoute) (runtimecore.Eligibility, error)
}

// AccountStateSource 提供 Node/Go 持久化的账号运行态文档（account_states）。
type AccountStateSource interface {
	ListAccountStates(ctx context.Context) ([]runtimecore.AccountState, error)
}

// UsageGate 提供选号前额度阈值与模型窗口门禁判定。
type UsageGate interface {
	EvaluateScheduling(
		ctx context.Context,
		providerID string,
		accountRef accountcore.AccountRef,
		modelID runtimecore.ModelID,
	) (accountrouting.UsageDecision, error)
}

// ActivitySource 提供账号与模型维度的实时并发与请求速率负载。
type ActivitySource interface {
	SelectionLoad(provider, accountRef, model string) sessionactivity.SelectionLoad
}

// Dependencies 汇总路由权重诊断接口的依赖端口。
type Dependencies struct {
	Authorizer  Authorizer
	Pool        PoolSource
	Catalog     ModelCatalogSource
	Settings    ModelSettingsSource
	Runtime     RuntimeSource
	Eligibility RuntimeEligibilitySource
	States      AccountStateSource
	UsageGate   UsageGate
	Activity    ActivitySource
	// Strategy 为当前选号策略（random / round-robin）；为空时取随机策略。
	Strategy string
	// Now 是测试时钟注入点；为空时使用 time.Now。
	Now func() time.Time
}

// Candidate 是单个账号对目标模型的调度诊断行，字段与前端 RoutingWeightCandidate 一一对应。
type Candidate struct {
	AccountRef    string   `json:"accountRef"`
	Provider      string   `json:"provider"`
	CLIAccountID  *int64   `json:"cliAccountId"`
	Email         string   `json:"email"`
	Eligible      bool     `json:"eligible"`
	Reason        string   `json:"reason"`
	RemainingPct  *float64 `json:"remainingPct"`
	InFlight      int      `json:"inFlight"`
	ModelInFlight int      `json:"modelInFlight"`
	Rate          int      `json:"rate"`
	WindowMS      int64    `json:"windowMs"`
	Weight        float64  `json:"weight"`
	Probability   float64  `json:"probability"`
}

// Response 是 GET /v1/management/webui/routing/weights 的成功响应。
type Response struct {
	OK            bool        `json:"ok"`
	Provider      string      `json:"provider"`
	Model         string      `json:"model"`
	Strategy      string      `json:"strategy"`
	Catalog       string      `json:"catalog"`
	TotalWeight   float64     `json:"totalWeight"`
	EligibleCount int         `json:"eligibleCount"`
	TotalCount    int         `json:"totalCount"`
	Candidates    []Candidate `json:"candidates"`
}

type errorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// Handler 是路由权重诊断的 HTTP 入站适配器。
type Handler struct {
	authorizer  Authorizer
	pool        PoolSource
	catalog     ModelCatalogSource
	settings    ModelSettingsSource
	runtime     RuntimeSource
	eligibility RuntimeEligibilitySource
	states      AccountStateSource
	usageGate   UsageGate
	activity    ActivitySource
	strategy    string
	now         func() time.Time
}

// NewHandler 校验必要依赖并构造路由权重诊断 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Pool == nil {
		return nil, ErrInvalidDependencies
	}
	parsedStrategy, err := accountrouting.ParseSelectionStrategy(dependencies.Strategy)
	if err != nil {
		return nil, err
	}
	nowFn := dependencies.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	eligibility := dependencies.Eligibility
	if eligibility == nil && dependencies.Runtime != nil {
		if source, ok := dependencies.Runtime.(RuntimeEligibilitySource); ok {
			eligibility = source
		}
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		pool:        dependencies.Pool,
		catalog:     dependencies.Catalog,
		settings:    dependencies.Settings,
		runtime:     dependencies.Runtime,
		eligibility: eligibility,
		states:      dependencies.States,
		usageGate:   dependencies.UsageGate,
		activity:    dependencies.Activity,
		strategy:    string(parsedStrategy),
		now:         nowFn,
	}, nil
}

// ServeHTTP 处理 GET /v1/management/webui/routing/weights 请求。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.pool == nil {
		writeError(response, http.StatusServiceUnavailable, "routing_weights_unavailable", "路由权重诊断服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 GET 请求")
		return
	}
	provider, model, ok := parseWeightsQuery(request)
	if !ok {
		writeError(response, http.StatusBadRequest, "invalid_query", "provider 和 model 必填")
		return
	}

	ctx := request.Context()
	pool, err := handler.pool.ListProviderPool(ctx, provider)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "routing_weights_unavailable", "读取账号池失败")
		return
	}
	if len(pool) == 0 {
		writeError(response, http.StatusNotFound, "provider_not_found", "没有 "+provider+" 账号池")
		return
	}

	payload := handler.evaluateWeights(ctx, provider, model, pool)
	writeJSON(response, http.StatusOK, payload)
}

func parseWeightsQuery(request *http.Request) (provider string, model string, ok bool) {
	if request == nil || request.URL == nil {
		return "", "", false
	}
	values, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil {
		return "", "", false
	}
	provider = strings.ToLower(strings.TrimSpace(values.Get("provider")))
	model = strings.TrimSpace(values.Get("model"))
	if provider == "" || model == "" {
		return "", "", false
	}
	return provider, model, true
}

func (handler *Handler) evaluateWeights(
	ctx context.Context,
	provider string,
	model string,
	pool []PoolAccount,
) Response {
	now := handler.now()
	nowMS := now.UnixMilli()

	catalog, hasCatalog := handler.loadCatalogBestEffort(ctx)
	settings, hasSettings := handler.loadSettingsBestEffort(ctx)
	narrowing := narrowCatalog(pool, provider, model, catalog, hasCatalog, settings, hasSettings, nowMS)

	statesByRef := handler.loadAccountStatesBestEffort(ctx)
	runtimeByRef := handler.loadRuntimeViews()
	parsedModelID, modelErr := runtimecore.NewModelID(model)
	modelIDValid := modelErr == nil

	candidates := make([]Candidate, 0, len(pool))
	accountByRef := make(map[string]PoolAccount, len(pool))
	loadsByRef := make(map[string]sessionactivity.SelectionLoad, len(pool))
	eligibleCount := 0

	for _, account := range pool {
		ref := strings.TrimSpace(account.AccountRef)
		accountProvider := strings.ToLower(strings.TrimSpace(account.Provider))
		if accountProvider == "" {
			accountProvider = provider
		}
		accountByRef[ref] = account

		load := handler.selectionLoad(accountProvider, ref, model)
		loadsByRef[ref] = load

		reason := narrowing.excludedReasons[ref]
		if reason == "" {
			reason = handler.evaluateAccountEligibility(
				ctx,
				account,
				accountProvider,
				model,
				parsedModelID,
				modelIDValid,
				statesByRef[ref],
				runtimeByRef[ref],
				load,
				now,
			)
		}

		eligible := reason == ""
		if eligible {
			eligibleCount++
		}
		var remainingPtr *float64
		if account.RemainingPct != nil && !math.IsNaN(*account.RemainingPct) && !math.IsInf(*account.RemainingPct, 0) {
			value := *account.RemainingPct
			remainingPtr = &value
		}
		var cliIDPtr *int64
		if account.CLIAccountID != nil && *account.CLIAccountID > 0 {
			value := *account.CLIAccountID
			cliIDPtr = &value
		}

		candidates = append(candidates, Candidate{
			AccountRef:    ref,
			Provider:      accountProvider,
			CLIAccountID:  cliIDPtr,
			Email:         strings.TrimSpace(account.Email),
			Eligible:      eligible,
			Reason:        reason,
			RemainingPct:  remainingPtr,
			InFlight:      load.InFlight,
			ModelInFlight: load.ModelInFlight,
			Rate:          load.Rate,
			WindowMS:      load.WindowMS,
		})
	}

	totalWeight := 0.0
	for index := range candidates {
		if !candidates[index].Eligible {
			continue
		}
		ref := candidates[index].AccountRef
		weight := computeSelectionWeight(accountByRef[ref], loadsByRef[ref])
		candidates[index].Weight = weight
		totalWeight += weight
	}
	if totalWeight > 0 {
		for index := range candidates {
			if candidates[index].Eligible {
				candidates[index].Probability = candidates[index].Weight / totalWeight
			}
		}
	}

	sortCandidates(candidates)

	return Response{
		OK:            true,
		Provider:      provider,
		Model:         model,
		Strategy:      handler.strategy,
		Catalog:       narrowing.status,
		TotalWeight:   totalWeight,
		EligibleCount: eligibleCount,
		TotalCount:    len(candidates),
		Candidates:    candidates,
	}
}

func (handler *Handler) loadCatalogBestEffort(ctx context.Context) (accountapp.AccountModelCatalog, bool) {
	if handler.catalog == nil {
		return accountapp.AccountModelCatalog{}, false
	}
	catalog, err := handler.catalog.ListAllAccountModels(ctx)
	if err != nil {
		return accountapp.AccountModelCatalog{}, false
	}
	return catalog, true
}

func (handler *Handler) loadSettingsBestEffort(ctx context.Context) (modelcatalogsettings.Settings, bool) {
	if handler.settings == nil {
		return modelcatalogsettings.Settings{}, false
	}
	settings, err := handler.settings.LoadModelSettings(ctx)
	if err != nil {
		return modelcatalogsettings.Settings{}, false
	}
	return settings, true
}

func (handler *Handler) loadAccountStatesBestEffort(ctx context.Context) map[string]runtimecore.AccountState {
	if handler.states == nil {
		return nil
	}
	list, err := handler.states.ListAccountStates(ctx)
	if err != nil {
		return nil
	}
	states := make(map[string]runtimecore.AccountState, len(list))
	for _, state := range list {
		ref := strings.TrimSpace(state.AccountRef().String())
		if ref != "" {
			states[ref] = state
		}
	}
	return states
}

func (handler *Handler) loadRuntimeViews() map[string]*runtimeapp.AccountView {
	if handler.runtime == nil {
		return nil
	}
	views := handler.runtime.RuntimeSnapshot()
	if len(views) == 0 {
		return nil
	}
	byRef := make(map[string]*runtimeapp.AccountView, len(views))
	for index := range views {
		ref := strings.TrimSpace(views[index].AccountRef.String())
		if ref != "" {
			view := views[index]
			byRef[ref] = &view
		}
	}
	return byRef
}

func (handler *Handler) selectionLoad(provider, accountRef, model string) sessionactivity.SelectionLoad {
	if handler.activity == nil {
		return sessionactivity.SelectionLoad{WindowMS: defaultRateWindowMS}
	}
	load := handler.activity.SelectionLoad(provider, accountRef, model)
	if load.WindowMS <= 0 {
		load.WindowMS = defaultRateWindowMS
	}
	return load
}

// computeSelectionWeight 与 Node lib/server/account-selection-load.js 保持同一公式：
//
//	remainingWeight = clamp(1, 100, remainingPct ?? 50)
//	requestPressure = inFlight + rate / max(1, windowMs / 1000)
//	weight = remainingWeight / (1 + requestPressure)^2
func computeSelectionWeight(account PoolAccount, load sessionactivity.SelectionLoad) float64 {
	remainingWeight := unknownRemainingWeight
	if account.RemainingPct != nil && !math.IsNaN(*account.RemainingPct) && !math.IsInf(*account.RemainingPct, 0) {
		remainingWeight = math.Min(maxSelectionRemainingPct, math.Max(minSelectionRemainingPct, *account.RemainingPct))
	}
	windowSeconds := math.Max(1.0, float64(load.WindowMS)/1000.0)
	inFlight := math.Max(0, float64(load.InFlight))
	rate := math.Max(0, float64(load.Rate))
	requestPressure := inFlight + rate/windowSeconds
	weight := remainingWeight / math.Pow(1.0+requestPressure, 2.0)
	if math.IsNaN(weight) || math.IsInf(weight, 0) || weight < 0 {
		return 0
	}
	return weight
}

// sortCandidates 按 Node describeSelectionWeights 的顺序排列：
// eligible 降序 → probability 降序 → email 升序（忽略大小写，再按原文、accountRef 稳定决胜）。
func sortCandidates(candidates []Candidate) {
	sort.SliceStable(candidates, func(left, right int) bool {
		if candidates[left].Eligible != candidates[right].Eligible {
			return candidates[left].Eligible
		}
		if candidates[left].Probability != candidates[right].Probability {
			return candidates[left].Probability > candidates[right].Probability
		}
		leftLower := strings.ToLower(candidates[left].Email)
		rightLower := strings.ToLower(candidates[right].Email)
		if leftLower != rightLower {
			return leftLower < rightLower
		}
		if candidates[left].Email != candidates[right].Email {
			return candidates[left].Email < candidates[right].Email
		}
		return candidates[left].AccountRef < candidates[right].AccountRef
	})
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, errorResponse{OK: false, Error: code, Message: message})
}
