// Package webuiegressupstreamsapi 提供出口上游地区策略、主动/被动探测与账号出口配置的 WebUI HTTP 与 SSE 管理面接口。
//
// 契约对应 Node 侧：
//   - lib/server/webui-egress-upstream-routes.js
//   - lib/server/webui-egress-account-routes.js
package webuiegressupstreamsapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	runtimeegress "github.com/madou1217/ai_home/internal/runtime/egress"
)

const (
	// UpstreamsPath 是上游地区策略总览与编辑根路径。
	UpstreamsPath = "/v1/management/webui/egress-upstreams"
	// UpstreamsWatchPath 是上游变更 SSE 订阅流路径。
	UpstreamsWatchPath = UpstreamsPath + "/watch"
	// NetworkRefreshPath 是强制刷新本机直连出口地理位置的 POST 路径。
	NetworkRefreshPath = UpstreamsPath + "/network/refresh"
	// UpstreamItemPath 是更新单个上游策略的 PUT 路径模板。
	UpstreamItemPath = UpstreamsPath + "/{id}"
	// UpstreamProbePath 是立即探测上游节点可用性的 POST 路径模板。
	UpstreamProbePath = UpstreamsPath + "/{id}/probe"
	// UpstreamProbeAccountPath 是按账号当前生效出口探测上游的 POST 路径模板。
	UpstreamProbeAccountPath = UpstreamsPath + "/{id}/probe-account"
	// UpstreamEvidenceResetPath 是清空上游实测证据的 POST 路径模板。
	UpstreamEvidenceResetPath = UpstreamsPath + "/{id}/evidence/reset"

	// AccountEgressPrefix 是账号级出口池运行时与分配路由前缀（避免与 /accounts/{provider}/{accountRef}/egress 冲突）。
	AccountEgressPrefix = "/v1/management/webui/egress/accounts/"
	// AccountRuntimePath 是查询账号出口池运行时状态的 GET 路径模板。
	AccountRuntimePath = AccountEgressPrefix + "{provider}/{accountRef}/egress-runtime"
	// AccountAssignmentPath 是保存账号出口池分配方案的 PUT 路径模板。
	AccountAssignmentPath = AccountEgressPrefix + "{provider}/{accountRef}/egress-assignment"

	maxUpstreamBodyBytes = 64 * 1024
	maxAccountBodyBytes  = 32 * 1024
)

// ErrInvalidDependencies 表示缺少鉴权策略或上游运行时管理器。
var ErrInvalidDependencies = errors.New("出口上游 WebUI 适配层依赖无效")

// Authorizer 校验 WebUI 管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// UpstreamsManager 抽象 Go 出口上游与账号出口配置服务（由 *runtimeegress.Manager 实现）。
type UpstreamsManager interface {
	BuildUpstreamsView(ctx context.Context, accountRefFilter string) (*runtimeegress.EgressUpstreamsView, error)
	SubscribeWatch() (<-chan runtimeegress.WatchEvent, func())
	RefreshDirectNetworkGeo(ctx context.Context) (*runtimeegress.NetworkGeoEntry, error)
	UpdateUpstreamPolicy(ctx context.Context, upstreamID string, patch runtimeegress.UpstreamPolicyPatch) (runtimeegress.UpstreamPolicy, error)
	ResetUpstreamEvidence(ctx context.Context, upstreamID string, exitKeys []string) (int, int, string)
	StartUpstreamProbe(ctx context.Context, upstreamID string, requestedNodes []string) (runtimeegress.UpstreamProbeHTTPResult, int)
	ValidateAccountPath(ctx context.Context, provider string, accountRef string) (*runtimeegress.AccountRecord, int, string)
	GetAccountEgressRuntime(ctx context.Context, account runtimeegress.AccountRecord) map[string]any
	PutAccountEgressAssignment(ctx context.Context, account runtimeegress.AccountRecord, rawBody map[string]any) (map[string]any, int, string)
}

// AccountUpstreamProbeManager 是可选的按账号真实出口探测能力。
//
// 生产 runtimeegress.Manager 实现它；旧的测试/替代管理器没有该能力时，
// 仅该路由返回 501，不影响其它出口管理路由的装配。
type AccountUpstreamProbeManager interface {
	ProbeUpstreamAccount(ctx context.Context, upstreamID string, accountRef string) (runtimeegress.AccountUpstreamProbeResult, int)
}

// DiagnosticsManager 是可选的代理层冲突诊断能力（只读）。
type DiagnosticsManager interface {
	Diagnostics(ctx context.Context) runtimeegress.EgressDiagnostics
}

// StrategyCatalogManager 是可选的出口策略目录能力（只读）。
type StrategyCatalogManager interface {
	StrategyCatalog(ctx context.Context) []runtimeegress.StrategyStatus
}

// RoutingPolicyManager 是出口池路由/DNS 策略的读写能力。
type RoutingPolicyManager interface {
	GetRoutingPolicy(ctx context.Context) runtimeegress.RoutingPolicy
	SaveRoutingPolicy(ctx context.Context, policy runtimeegress.RoutingPolicy, restart bool) (runtimeegress.RoutingPolicy, error)
}

// Dependencies 注入鉴权策略、上游管理器及测试时钟/心跳配置。
type Dependencies struct {
	Authorizer        Authorizer
	Manager           UpstreamsManager
	Now               func() time.Time
	HeartbeatInterval time.Duration
}

// Handler 实现上游与账号出口配置路由。
type Handler struct {
	authorizer        Authorizer
	manager           UpstreamsManager
	now               func() time.Time
	heartbeatInterval time.Duration

	viewMu    sync.Mutex
	viewCache map[string]egressViewCacheEntry
}

const upstreamsViewCacheTTL = 10 * time.Second

type egressViewCacheEntry struct {
	at   time.Time
	view *runtimeegress.EgressUpstreamsView
}

// NewHandler 校验依赖并构造 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Manager == nil {
		return nil, ErrInvalidDependencies
	}
	now := dependencies.Now
	if now == nil {
		now = time.Now
	}
	heartbeat := dependencies.HeartbeatInterval
	if heartbeat <= 0 {
		heartbeat = defaultHeartbeatInterval
	}
	return &Handler{
		authorizer:        dependencies.Authorizer,
		manager:           dependencies.Manager,
		now:               now,
		heartbeatInterval: heartbeat,
	}, nil
}

// ServeHTTP 按精确方法与 URL 转义路径分发全部上游及账号出口路由。
// buildUpstreamsView 复用短 TTL 的上游视图；视图包含大量节点与证据，重复构建成本高。
func (handler *Handler) buildUpstreamsView(ctx context.Context, accountRefFilter string) (*runtimeegress.EgressUpstreamsView, error) {
	handler.viewMu.Lock()
	if entry, ok := handler.viewCache[accountRefFilter]; ok && time.Since(entry.at) < upstreamsViewCacheTTL {
		view := entry.view
		handler.viewMu.Unlock()
		return view, nil
	}
	handler.viewMu.Unlock()

	view, err := handler.manager.BuildUpstreamsView(ctx, accountRefFilter)
	if err != nil || view == nil {
		return view, err
	}
	handler.viewMu.Lock()
	if handler.viewCache == nil {
		handler.viewCache = make(map[string]egressViewCacheEntry)
	}
	if len(handler.viewCache) >= 32 {
		for stale := range handler.viewCache {
			delete(handler.viewCache, stale)
			break
		}
	}
	handler.viewCache[accountRefFilter] = egressViewCacheEntry{at: time.Now(), view: view}
	handler.viewMu.Unlock()
	return view, nil
}

func (handler *Handler) ServeHTTP(responseWriter http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.manager == nil {
		writeError(responseWriter, http.StatusServiceUnavailable, "egress_upstreams_unavailable", "出口上游服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		responseWriter.Header().Set("WWW-Authenticate", "Bearer")
		writeError(responseWriter, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}

	escapedPath := request.URL.EscapedPath()
	if escapedPath == "" {
		escapedPath = request.URL.Path
	}

	switch {
	case escapedPath == UpstreamsPath:
		if !requireMethod(responseWriter, request, http.MethodGet) {
			return
		}
		accountRef := strings.TrimSpace(request.URL.Query().Get("accountRef"))
		view, err := handler.buildUpstreamsView(request.Context(), accountRef)
		if err != nil || view == nil {
			writeError(responseWriter, http.StatusServiceUnavailable, "egress_upstreams_unavailable", "出口上游视图读取失败")
			return
		}
		writeJSON(responseWriter, http.StatusOK, view)

	case escapedPath == UpstreamsWatchPath:
		if !requireMethod(responseWriter, request, http.MethodGet) {
			return
		}
		handler.serveWatchSSE(responseWriter, request)

	case escapedPath == NetworkRefreshPath:
		if !requireMethod(responseWriter, request, http.MethodPost) {
			return
		}
		entry, err := handler.manager.RefreshDirectNetworkGeo(request.Context())
		if err != nil || entry == nil {
			writeJSON(responseWriter, http.StatusBadGateway, map[string]any{"ok": false, "error": "geo_lookup_failed"})
			return
		}
		writeJSON(responseWriter, http.StatusOK, map[string]any{"ok": true, "geo": entry.Geo, "at": entry.At})

	case strings.HasPrefix(escapedPath, AccountEgressPrefix):
		handler.serveAccountEgress(responseWriter, request, escapedPath)

	case strings.HasPrefix(escapedPath, UpstreamsPath+"/"):
		handler.serveUpstreamSubpath(responseWriter, request, escapedPath)

	default:
		writeError(responseWriter, http.StatusNotFound, "not_found", "未找到出口上游路由")
	}
}

func (handler *Handler) serveUpstreamSubpath(responseWriter http.ResponseWriter, request *http.Request, escapedPath string) {
	rest := strings.TrimPrefix(escapedPath, UpstreamsPath+"/")
	switch {
	case rest == "routing/test":
		handler.serveRoutingTest(responseWriter, request, rest)
	case rest == "routing":
		handler.serveRouting(responseWriter, request, rest)
	case rest == "strategies":
		handler.serveStrategies(responseWriter, request, rest)
	case rest == "diagnostics":
		handler.serveDiagnostics(responseWriter, request, rest)
	case strings.HasSuffix(rest, "/probe"):
		handler.serveUpstreamProbe(responseWriter, request, rest)
	case strings.HasSuffix(rest, "/probe-account"):
		handler.serveProbeAccount(responseWriter, request, rest)
	case strings.HasSuffix(rest, "/evidence/reset"):
		handler.serveEvidenceReset(responseWriter, request, rest)
	case !strings.Contains(rest, "/"):
		handler.serveUpstreamDetail(responseWriter, request, rest)
	default:
		writeError(responseWriter, http.StatusNotFound, "not_found", "未找到上游操作路由")
	}
}

func (handler *Handler) serveAccountEgress(responseWriter http.ResponseWriter, request *http.Request, escapedPath string) {
	rest := strings.TrimPrefix(escapedPath, AccountEgressPrefix)
	parts := strings.Split(rest, "/")
	if len(parts) != 3 {
		writeError(responseWriter, http.StatusNotFound, "not_found", "未找到账号出口路由")
		return
	}
	rawProvider, rawRef, leaf := parts[0], parts[1], parts[2]

	switch leaf {
	case "egress-runtime":
		if !requireMethod(responseWriter, request, http.MethodGet) {
			return
		}
	case "egress-assignment":
		if !requireMethod(responseWriter, request, http.MethodPut) {
			return
		}
	default:
		writeError(responseWriter, http.StatusNotFound, "not_found", "未找到账号出口路由")
		return
	}

	provider, ok1 := unescapeSegment(rawProvider)
	accountRef, ok2 := unescapeSegment(rawRef)
	if !ok1 || !ok2 {
		writeError(responseWriter, http.StatusBadRequest, "invalid_account_path", "账号路径参数无效")
		return
	}
	account, status, code := handler.manager.ValidateAccountPath(request.Context(), provider, accountRef)
	if status != http.StatusOK || account == nil {
		writeError(responseWriter, status, code, "账号校验失败")
		return
	}

	if request.Method == http.MethodGet {
		writeJSON(responseWriter, http.StatusOK, handler.manager.GetAccountEgressRuntime(request.Context(), *account))
		return
	}

	var body map[string]any
	if !readJSONObject(responseWriter, request, &body, maxAccountBodyBytes, false) {
		return
	}
	res, status, code := handler.manager.PutAccountEgressAssignment(request.Context(), *account, body)
	if status != http.StatusOK {
		writeError(responseWriter, status, code, "保存账号出口池分配失败")
		return
	}
	writeJSON(responseWriter, http.StatusOK, res)
}

func unescapeSegment(raw string) (string, bool) {
	decoded, err := url.PathUnescape(raw)
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(decoded), true
}

func requireMethod(responseWriter http.ResponseWriter, request *http.Request, allow string) bool {
	if request.Method == allow {
		return true
	}
	responseWriter.Header().Set("Allow", allow)
	writeError(responseWriter, http.StatusMethodNotAllowed, "method_not_allowed", "请求方法不支持")
	return false
}

func readJSONObject(responseWriter http.ResponseWriter, request *http.Request, target any, maxBytes int64, allowEmpty bool) bool {
	if request.Body == nil {
		if allowEmpty {
			return true
		}
		writeError(responseWriter, http.StatusBadRequest, "invalid_json_body", "请求体不能为空")
		return false
	}
	raw, err := io.ReadAll(io.LimitReader(request.Body, maxBytes+1))
	if err != nil || int64(len(raw)) > maxBytes {
		writeError(responseWriter, http.StatusBadRequest, "invalid_json_body", "请求体过大或不可读")
		return false
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		if allowEmpty {
			return true
		}
		writeError(responseWriter, http.StatusBadRequest, "invalid_json_body", "请求体不能为空")
		return false
	}
	var obj map[string]any
	if err := json.Unmarshal([]byte(trimmed), &obj); err != nil || obj == nil {
		writeError(responseWriter, http.StatusBadRequest, "invalid_json_body", "请求体必须是 JSON 对象")
		return false
	}
	if err := json.Unmarshal([]byte(trimmed), target); err != nil {
		writeError(responseWriter, http.StatusBadRequest, "invalid_json_body", "请求体 JSON 格式错误")
		return false
	}
	return true
}

func writeJSON(responseWriter http.ResponseWriter, status int, payload any) {
	responseWriter.Header().Set("Content-Type", "application/json; charset=utf-8")
	responseWriter.Header().Set("Cache-Control", "no-store")
	responseWriter.WriteHeader(status)
	_ = json.NewEncoder(responseWriter).Encode(payload)
}

func writeError(responseWriter http.ResponseWriter, status int, code, message string) {
	writeJSON(responseWriter, status, map[string]any{
		"ok":      false,
		"error":   code,
		"message": message,
	})
}
