// Package webuiaccountegressapi 提供账号级出口绑定的读写、运行态应用与失败回滚入口。
//
// 契约来源是 GET|POST /v0/webui/accounts/:provider/:accountRef/egress：
//   1. 路径/provider/账号校验、mode 与代理地址校验、绑定落盘与分配投影；
//   2. 当注入 Runtime / Pool / Assignments 时，在 Go 内完成出口池启动/车道重排、
//      数据面 204 连通性探测与运行态桌面重启；应用失败时自动回滚到写入前的绑定（已退役记录除外）；
//   3. 合并 runtime 与 assignment 视图后返回给前端。
//
// 错误码与既有契约逐字一致；500 响应不带 message，避免外抛底层细节。
package webuiaccountegressapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/agy/egress"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
)

const (
	// Path 是账号出口设置的管理契约前缀。
	//
	//	GET  /v1/management/webui/accounts/{provider}/{accountRef}/egress
	//	POST /v1/management/webui/accounts/{provider}/{accountRef}/egress
	Path = "/v1/management/webui/accounts"

	maxRequestBodyBytes = 16 * 1024
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("账号出口设置接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// BindingStore 是绑定读写端口（生产实现是 egress.Store）。
type BindingStore interface {
	Read(ctx context.Context, accountRef string) (egress.Binding, bool, error)
	Replace(ctx context.Context, accountRef string, mode string, proxyURL string, scope any, strategy string) (egress.Binding, error)
	Clear(ctx context.Context, accountRef string) error
}

// RuntimeController 提供账号出口运行态探针与连通性探测/应用能力（可选，生产实现为 runtimeegress.Manager）。
type RuntimeController interface {
	GetAccountEgressRuntimeStatus(ctx context.Context, opts runtimeegress.RuntimeStatusOptions) runtimeegress.AccountEgressRuntimeStatus
	ApplyStoredAccountEgress(ctx context.Context, opts runtimeegress.ApplyAccountEgressOptions) runtimeegress.ApplyEgressResult
}

// AssignmentReader 读取账号出口池分配投影（可选，生产实现为 runtimeegress.Manager）。
type AssignmentReader interface {
	GetAssignment(ctx context.Context, accountRef string) (*runtimeegress.AccountEgressAssignment, error)
}

// PoolController 负责拉起出口池并在绑定变化时重排车道（可选，生产实现为 runtimeegress.Manager）。
type PoolController interface {
	StartPool(ctx context.Context) runtimeegress.PoolStartResult
	ReconcileLanes(ctx context.Context) error
}

// Dependencies 汇总读写与可选运行态依赖。
type Dependencies struct {
	Authorizer Authorizer
	AIHomeDir  string
	// Catalog 判定 provider 是否已知（EGRESS_SUPPORTED_PROVIDERS = 全部已声明 provider）。
	Catalog     *providers.Catalog
	Store       BindingStore
	Runtime     RuntimeController
	Assignments AssignmentReader
	Pool        PoolController
}

// Handler 处理账号出口绑定的读写、应用及失败自动回滚。
type Handler struct {
	aiHomeDir   string
	catalog     *providers.Catalog
	store       BindingStore
	authorizer  Authorizer
	runtime     RuntimeController
	assignments AssignmentReader
	pool        PoolController
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || strings.TrimSpace(dependencies.AIHomeDir) == "" ||
		dependencies.Catalog == nil || dependencies.Store == nil {
		return nil, ErrInvalidDependencies
	}
	assignments := dependencies.Assignments
	if assignments == nil && dependencies.Runtime != nil {
		if ar, ok := dependencies.Runtime.(AssignmentReader); ok {
			assignments = ar
		}
	}
	pool := dependencies.Pool
	if pool == nil && dependencies.Runtime != nil {
		if pc, ok := dependencies.Runtime.(PoolController); ok {
			pool = pc
		}
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		aiHomeDir:   strings.TrimSpace(dependencies.AIHomeDir),
		catalog:     dependencies.Catalog,
		store:       dependencies.Store,
		runtime:     dependencies.Runtime,
		assignments: assignments,
		pool:        pool,
	}, nil
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

type responseView struct {
	OK         bool           `json:"ok"`
	Provider   string         `json:"provider"`
	AccountRef string         `json:"accountRef"`
	Binding    map[string]any `json:"binding"`
	// Previous 只在写入路径出现：失败回滚需要「写入前的原绑定」。
	Previous map[string]any `json:"previous,omitempty"`
}

type runtimeResponseView struct {
	OK           bool                                      `json:"ok"`
	Provider     string                                    `json:"provider"`
	AccountRef   string                                    `json:"accountRef"`
	Binding      map[string]any                            `json:"binding"`
	Previous     map[string]any                            `json:"previous,omitempty"`
	Assignment   *runtimeegress.AccountEgressAssignment    `json:"assignment"`
	Apply        *runtimeegress.ApplyEgressResult          `json:"apply,omitempty"`
	Runtime      *runtimeegress.AccountEgressRuntimeDetail `json:"runtime"`
	RuntimeError string                                    `json:"runtimeError,omitempty"`
}

// ServeHTTP 接受 GET（读）与 POST（写）。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil {
		writeError(response, http.StatusServiceUnavailable, "egress_unavailable", "账号出口服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet && request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET/POST")
		return
	}
	provider := strings.ToLower(strings.TrimSpace(request.PathValue("provider")))
	accountRef := strings.TrimSpace(request.PathValue("accountRef"))
	if provider == "" || accountRef == "" {
		writeError(response, http.StatusBadRequest, "invalid_account_path", "")
		return
	}
	// 与 Node EGRESS_SUPPORTED_PROVIDERS（全部已知 provider）一致：只认规范 ID，
	// 别名（如 openai → codex）不算独立 provider。
	if canonical, known := handler.catalog.CanonicalID(provider); !known || canonical != provider {
		writeError(response, http.StatusBadRequest, "egress_unsupported_provider", "")
		return
	}
	databasePath, err := appstate.DatabasePath(handler.aiHomeDir)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "ai_home_dir_unavailable", "")
		return
	}
	owner, found, err := appstate.LookupAccountProvider(request.Context(), databasePath, accountRef)
	if err != nil {
		writeError(response, http.StatusInternalServerError, errorForMethod(request.Method), "")
		return
	}
	if !found {
		writeError(response, http.StatusNotFound, "account_not_found", "")
		return
	}
	if strings.ToLower(strings.TrimSpace(owner)) != provider {
		writeError(response, http.StatusConflict, "account_provider_mismatch", "")
		return
	}
	if request.Method == http.MethodGet {
		handler.read(response, request, provider, accountRef)
		return
	}
	handler.write(response, request, provider, accountRef)
}

func (handler *Handler) hasPresentationPorts() bool {
	return handler.runtime != nil || handler.assignments != nil
}

func (handler *Handler) readAssignment(ctx context.Context, accountRef string) *runtimeegress.AccountEgressAssignment {
	if handler.assignments == nil {
		return nil
	}
	assignment, err := handler.assignments.GetAssignment(ctx, accountRef)
	if err != nil {
		return nil
	}
	return assignment
}

func (handler *Handler) readRuntimeDetail(
	ctx context.Context,
	provider string,
	accountRef string,
	explicit *egress.Binding,
) (*runtimeegress.AccountEgressRuntimeDetail, string) {
	if handler.runtime == nil {
		return nil, ""
	}
	res := handler.runtime.GetAccountEgressRuntimeStatus(ctx, runtimeegress.RuntimeStatusOptions{
		Provider:        provider,
		AccountRef:      accountRef,
		HasExplicit:     true,
		ExplicitBinding: explicit,
	})
	if !res.OK {
		code := strings.TrimSpace(res.Error)
		if code == "" {
			code = "egress_status_unavailable"
		}
		return nil, code
	}
	detail := res.Runtime
	return &detail, ""
}

func (handler *Handler) read(response http.ResponseWriter, request *http.Request, provider string, accountRef string) {
	binding, found, err := handler.store.Read(request.Context(), accountRef)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "egress_binding_read_failed", "")
		return
	}
	if !handler.hasPresentationPorts() {
		writeJSON(response, http.StatusOK, responseView{
			OK: true, Provider: provider, AccountRef: accountRef, Binding: bindingView(binding, found),
		})
		return
	}
	var explicit *egress.Binding
	if found {
		copied := binding
		explicit = &copied
	}
	runtimeDetail, runtimeErr := handler.readRuntimeDetail(request.Context(), provider, accountRef, explicit)
	assignment := handler.readAssignment(request.Context(), accountRef)
	writeJSON(response, http.StatusOK, runtimeResponseView{
		OK:           true,
		Provider:     provider,
		AccountRef:   accountRef,
		Binding:      bindingView(binding, found),
		Assignment:   assignment,
		Runtime:      runtimeDetail,
		RuntimeError: runtimeErr,
	})
}

func (handler *Handler) write(response http.ResponseWriter, request *http.Request, provider string, accountRef string) {
	var payload any
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxRequestBodyBytes))
	if err := decoder.Decode(&payload); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_json_body", "")
		return
	}
	object, ok := payload.(map[string]any)
	if !ok || object == nil {
		writeError(response, http.StatusBadRequest, "invalid_request_body", "")
		return
	}
	modeText, scalar := scalarText(object["mode"])
	if !scalar {
		writeError(response, http.StatusBadRequest, "invalid_egress_mode", "")
		return
	}
	mode := strings.ToLower(modeText)
	proxyURL, proxyScalar := scalarText(object["proxyUrl"])
	if !proxyScalar {
		if mode == egress.ModeURL {
			writeError(response, http.StatusBadRequest, "invalid_proxy_url", "")
			return
		}
		proxyURL = ""
	}
	if mode != "" && !egress.IsKnownMode(mode) {
		writeError(response, http.StatusBadRequest, "invalid_egress_mode", "")
		return
	}
	if mode == egress.ModeURL && proxyURL != "" {
		if issue := egress.ProxyURLIssueForProvider(proxyURL, provider); issue != "" {
			writeError(response, http.StatusBadRequest, issue, "")
			return
		}
	}
	shouldClear := mode == "" || (mode == egress.ModeURL && proxyURL == "")

	previous, hadPrevious, err := handler.store.Read(request.Context(), accountRef)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "egress_binding_read_failed", "")
		return
	}

	var current egress.Binding
	hasCurrent := false
	if shouldClear {
		if err := handler.store.Clear(request.Context(), accountRef); err != nil {
			writeError(response, http.StatusInternalServerError, "egress_binding_write_failed", "")
			return
		}
	} else {
		written, err := handler.store.Replace(
			request.Context(), accountRef, mode, proxyURL, object["scope"], textValue(object["strategy"]),
		)
		if err != nil {
			writeError(response, http.StatusInternalServerError, "egress_binding_write_failed", "")
			return
		}
		current = written
		hasCurrent = true
	}

	if !handler.hasPresentationPorts() {
		writeJSON(response, http.StatusOK, responseView{
			OK:         true,
			Provider:   provider,
			AccountRef: accountRef,
			Binding:    bindingView(current, hasCurrent),
			Previous:   bindingView(previous, hadPrevious),
		})
		return
	}

	ctx := request.Context()
	handler.syncPoolForTransition(ctx, hasCurrent && current.Mode == egress.ModePool, hadPrevious && previous.Mode == egress.ModePool)

	var applyResult *runtimeegress.ApplyEgressResult
	if handler.runtime != nil {
		res := handler.runtime.ApplyStoredAccountEgress(ctx, runtimeegress.ApplyAccountEgressOptions{
			Provider:        provider,
			AccountRef:      accountRef,
			HasExplicit:     true,
			ExplicitBinding: bindingPtr(current, hasCurrent),
		})
		// 新绑定探测或重启应用失败时，回滚到写入前原绑定；已下线模式的历史记录不再写回。
		if !res.OK && !(hadPrevious && previous.Retired) {
			restored, restoredFound, rbErr := handler.rollbackStore(ctx, accountRef, previous, hadPrevious)
			if rbErr != nil {
				rb := false
				res.RolledBack = &rb
				res.RollbackError = "egress_binding_rollback_failed"
			} else {
				current = restored
				hasCurrent = restoredFound
				handler.syncPoolForTransition(
					ctx,
					hasCurrent && current.Mode == egress.ModePool,
					true,
				)
				rbApply := handler.runtime.ApplyStoredAccountEgress(ctx, runtimeegress.ApplyAccountEgressOptions{
					Provider:        provider,
					AccountRef:      accountRef,
					HasExplicit:     true,
					ExplicitBinding: bindingPtr(current, hasCurrent),
				})
				rb := rbApply.OK
				res.RolledBack = &rb
				if !rbApply.OK {
					errCode := strings.TrimSpace(rbApply.Error)
					if errCode == "" {
						errCode = "egress_binding_rollback_failed"
					}
					res.RollbackError = errCode
				}
			}
		}
		applyResult = &res
	}

	runtimeDetail, runtimeErr := handler.readRuntimeDetail(ctx, provider, accountRef, bindingPtr(current, hasCurrent))
	assignment := handler.readAssignment(ctx, accountRef)
	writeJSON(response, http.StatusOK, runtimeResponseView{
		OK:           true,
		Provider:     provider,
		AccountRef:   accountRef,
		Binding:      bindingView(current, hasCurrent),
		Previous:     bindingView(previous, hadPrevious),
		Assignment:   assignment,
		Apply:        applyResult,
		Runtime:      runtimeDetail,
		RuntimeError: runtimeErr,
	})
}

func (handler *Handler) syncPoolForTransition(ctx context.Context, currentIsPool bool, involvedPool bool) {
	if handler.pool == nil {
		return
	}
	if currentIsPool {
		_ = handler.pool.StartPool(ctx)
		_ = handler.pool.ReconcileLanes(ctx)
		return
	}
	if involvedPool {
		_ = handler.pool.ReconcileLanes(ctx)
	}
}

func (handler *Handler) rollbackStore(
	ctx context.Context,
	accountRef string,
	previous egress.Binding,
	hadPrevious bool,
) (egress.Binding, bool, error) {
	if !hadPrevious {
		return egress.Binding{}, false, handler.store.Clear(ctx, accountRef)
	}
	var scopePayload any
	if previous.PoolScope != nil {
		scopePayload = map[string]any{
			"kind":   previous.PoolScope.Kind,
			"groups": append([]string{}, previous.PoolScope.Groups...),
			"nodes":  append([]string{}, previous.PoolScope.Nodes...),
		}
	}
	restored, err := handler.store.Replace(ctx, accountRef, previous.Mode, previous.ProxyURL, scopePayload, previous.PoolStrategy)
	if err != nil {
		return egress.Binding{}, false, err
	}
	return restored, true, nil
}

func bindingPtr(binding egress.Binding, found bool) *egress.Binding {
	if !found {
		return nil
	}
	copied := binding
	return &copied
}

func bindingView(binding egress.Binding, found bool) map[string]any {
	if !found {
		return nil
	}
	return binding.View()
}

func errorForMethod(method string) string {
	if method == http.MethodPost {
		return "egress_binding_write_failed"
	}
	return "egress_binding_read_failed"
}

func textValue(value any) string {
	text, _ := scalarText(value)
	return text
}

// scalarText 复刻 Node 的 String(value || '').trim()：假值（nil / false / 0 / 空串）
// 一律空串，真标量转文本，对象与数组判为非标量（ok=false）。
func scalarText(value any) (string, bool) {
	switch typed := value.(type) {
	case nil:
		return "", true
	case string:
		return strings.TrimSpace(typed), true
	case bool:
		if typed {
			return "true", true
		}
		return "", true
	case float64:
		if typed == 0 {
			return "", true
		}
		return strconv.FormatFloat(typed, 'g', -1, 64), true
	default:
		return "", false
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	encoder := json.NewEncoder(response)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
