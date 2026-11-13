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
		view, err := handler.manager.BuildUpstreamsView(request.Context(), accountRef)
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
	case strings.HasSuffix(rest, "/probe"):
		if !requireMethod(responseWriter, request, http.MethodPost) {
			return
		}
		rawID := strings.TrimSuffix(rest, "/probe")
		if strings.Contains(rawID, "/") {
			writeError(responseWriter, http.StatusNotFound, "not_found", "未找到路由")
			return
		}
		id, ok := unescapeSegment(rawID)
		if !ok {
			writeError(responseWriter, http.StatusNotFound, "upstream_not_found", "未找到上游")
			return
		}
		var body struct {
			Nodes []string `json:"nodes"`
		}
		if !readJSONObject(responseWriter, request, &body, maxUpstreamBodyBytes, true) {
			return
		}
		result, status := handler.manager.StartUpstreamProbe(request.Context(), id, body.Nodes)
		writeJSON(responseWriter, status, result)

	case strings.HasSuffix(rest, "/evidence/reset"):
		if !requireMethod(responseWriter, request, http.MethodPost) {
			return
		}
		rawID := strings.TrimSuffix(rest, "/evidence/reset")
		if strings.Contains(rawID, "/") {
			writeError(responseWriter, http.StatusNotFound, "not_found", "未找到路由")
			return
		}
		id, ok := unescapeSegment(rawID)
		if !ok {
			writeError(responseWriter, http.StatusNotFound, "upstream_not_found", "未找到上游")
			return
		}
		var body struct {
			ExitKeys []string `json:"exitKeys"`
		}
		if !readJSONObject(responseWriter, request, &body, maxUpstreamBodyBytes, true) {
			return
		}
		removed, status, code := handler.manager.ResetUpstreamEvidence(request.Context(), id, body.ExitKeys)
		if status != http.StatusOK {
			writeError(responseWriter, status, code, "未找到上游")
			return
		}
		writeJSON(responseWriter, http.StatusOK, map[string]any{"ok": true, "removed": removed})

	case !strings.Contains(rest, "/"):
		if !requireMethod(responseWriter, request, http.MethodPut) {
			return
		}
		id, ok := unescapeSegment(rest)
		if !ok || strings.TrimSpace(id) == "" {
			writeError(responseWriter, http.StatusBadRequest, "invalid_upstream_id", "上游 ID 无效")
			return
		}
		var patch runtimeegress.UpstreamPolicyPatch
		if !readJSONObject(responseWriter, request, &patch, maxUpstreamBodyBytes, true) {
			return
		}
		policy, err := handler.manager.UpdateUpstreamPolicy(request.Context(), id, patch)
		if err != nil {
			if err.Error() == "invalid_upstream_id" {
				writeError(responseWriter, http.StatusBadRequest, "invalid_upstream_id", "上游 ID 无效")
				return
			}
			writeError(responseWriter, http.StatusInternalServerError, err.Error(), "保存上游策略失败")
			return
		}
		writeJSON(responseWriter, http.StatusOK, map[string]any{"ok": true, "policy": policy})

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
