// Package webuisessionslistapi 提供「按账号读取项目与会话」的只读管理接口。
//
//	GET /v1/management/webui/sessions/{provider}/{accountRef}
//
// 契约来源：Node lib/server/web-ui-router.js 的
// GET /v0/webui/sessions/:provider/:accountRef 分支，实现在
// lib/server/webui-session-routes.js 的 handleGetAccountSessionsRequest：
//
//	响应 { ok: true, projects: [{ id, name, path, sessions, provider }] }
//	会话 { id, title, updatedAt, provider, projectDirName }
//
// 会话按 updatedAt 降序；空 id 的会话不下发；读不出任何项目时 projects 为空数组
// 而不是 null。
//
// 覆盖范围：只承接 Go 有事实源的 Provider —— claude、codex 与 CodeBuddy 家族
// （codebuddy / codebuddycn / workbuddy / workbuddycn）。其余 Provider 的会话
// 真相在 SQLite 或账号投影里，本切片返回 501 unsupported_provider，绝不用空
// 列表冒充「该账号没有会话」。
//
// 数据边界：只读宿主 HOME 下的会话目录。这些 Provider 的会话按产品共享
// （切换账号不改变可见历史，见 lib/sessions/session-reader-codebuddy.js 的说明），
// 因此 accountRef 只作路由标识与合法性校验，不参与目录定位。
//
// 本切片刻意不含：会话消息、事件流、模型回放、归档与生命周期操作。
package webuisessionslistapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

// Path 是账号会话列表的管理契约路径。
//
//	GET /v1/management/webui/sessions/{provider}/{accountRef}
const Path = "/v1/management/webui/sessions"

const (
	// DefaultMaxEntries 是单次扫描允许消费的目录条目总数。
	DefaultMaxEntries = 20000
	// DefaultScanTimeout 是单次扫描的时间上限；超时返回已扫到的部分结果。
	DefaultScanTimeout = 8 * time.Second
)

// 响应错误码；它们是契约的一部分，不要随文案改动。
const (
	errorCodeUnauthorized     = "unauthorized"
	errorCodeMethodNotAllowed = "method_not_allowed"
	errorCodeInvalidProvider  = "invalid_provider"
	errorCodeInvalidAccount   = "invalid_account_ref"
	errorCodeUnsupported      = "unsupported_provider"
	errorCodeScanFailed       = "get_sessions_failed"
	errorCodeUnavailable      = "sessions_unavailable"
	errorCodeNotFound         = "not_found"
)

// ErrInvalidDependencies 表示 Handler 缺少鉴权或宿主目录。
var ErrInvalidDependencies = errors.New("账号会话列表接口依赖无效")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 契约共用同一个 Bearer 实现）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总账号会话列表的依赖。
type Dependencies struct {
	Authorizer Authorizer
	// HostHomeDir 是宿主用户目录（会话目录的根）；必填。
	HostHomeDir string
	// AIHomeDir 是 aih 自己的状态目录。本切片覆盖的 Provider 会话都在宿主 HOME
	// 下，与账号投影无关；该字段保留给后续账号投影型 Provider 的切片使用。
	AIHomeDir string
	// MaxEntries 覆盖单次扫描的条目预算；<=0 时用 DefaultMaxEntries。
	MaxEntries int
	// ScanTimeout 覆盖单次扫描的时间上限；<=0 时用 DefaultScanTimeout。
	ScanTimeout time.Duration
}

// Handler 是账号会话列表的 HTTP 入站适配器。
type Handler struct {
	authorizer  Authorizer
	hostHomeDir string
	maxEntries  int
	scanTimeout time.Duration
}

// projectView 与 Node 的项目条目同形（键序按 Node 的构造顺序）。
type projectView struct {
	ID       string        `json:"id"`
	Name     string        `json:"name"`
	Path     string        `json:"path"`
	Sessions []sessionView `json:"sessions"`
	Provider string        `json:"provider"`
}

// sessionView 与 Node 的会话条目同形。
type sessionView struct {
	ID             string `json:"id"`
	Title          string `json:"title"`
	UpdatedAt      int64  `json:"updatedAt"`
	Provider       string `json:"provider"`
	ProjectDirName string `json:"projectDirName"`
}

// responseView 是成功响应。truncated 只在扫描被预算或超时截断时出现，
// 正常结果的键集合与 Node 一致。
type responseView struct {
	OK        bool          `json:"ok"`
	Projects  []projectView `json:"projects"`
	Truncated bool          `json:"truncated,omitempty"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message"`
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (http.Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	hostHomeDir := strings.TrimSpace(dependencies.HostHomeDir)
	if hostHomeDir == "" {
		return nil, ErrInvalidDependencies
	}
	maxEntries := dependencies.MaxEntries
	if maxEntries <= 0 {
		maxEntries = DefaultMaxEntries
	}
	scanTimeout := dependencies.ScanTimeout
	if scanTimeout <= 0 {
		scanTimeout = DefaultScanTimeout
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		hostHomeDir: hostHomeDir,
		maxEntries:  maxEntries,
		scanTimeout: scanTimeout,
	}, nil
}

// ServeHTTP 只接受带管理密钥的 GET。
func (handler *Handler) ServeHTTP(responseWriter http.ResponseWriter, request *http.Request) {
	// 会话随文件变化，缓存会让人看到过期条目。
	responseWriter.Header().Set("Cache-Control", "no-store")

	if handler == nil || handler.authorizer == nil || handler.hostHomeDir == "" {
		writeError(responseWriter, http.StatusServiceUnavailable, errorCodeUnavailable, "账号会话列表服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		responseWriter.Header().Set("WWW-Authenticate", "Bearer")
		writeError(responseWriter, http.StatusUnauthorized, errorCodeUnauthorized, "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		responseWriter.Header().Set("Allow", http.MethodGet)
		writeError(responseWriter, http.StatusMethodNotAllowed, errorCodeMethodNotAllowed, "只支持读取账号会话列表")
		return
	}

	provider, accountRef, ok := routeSegments(request)
	if !ok {
		writeError(responseWriter, http.StatusNotFound, errorCodeNotFound, "路径应为 /{provider}/{accountRef}")
		return
	}
	provider = normalizeProvider(provider)
	if !isSafePathSegment(provider) {
		writeError(responseWriter, http.StatusBadRequest, errorCodeInvalidProvider, "provider 必须是单段路径")
		return
	}
	if !isSafePathSegment(accountRef) {
		writeError(responseWriter, http.StatusBadRequest, errorCodeInvalidAccount, "accountRef 必须是单段路径")
		return
	}
	if !isSupportedProvider(provider) {
		writeError(responseWriter, http.StatusNotImplemented, errorCodeUnsupported,
			"该 Provider 的会话读取尚未由 Go 承接，请走 Node 网关")
		return
	}

	ctx, cancel := context.WithTimeout(request.Context(), handler.scanTimeout)
	defer cancel()

	projects, truncated := handler.collect(ctx, provider)
	writeJSON(responseWriter, http.StatusOK, responseView{
		OK:        true,
		Projects:  projects,
		Truncated: truncated,
	})
}

// collect 执行一次有界扫描并完成排序。
//
// 扫描被预算或超时打断时返回已收集到的部分结果（truncated=true），
// 而不是把「读得慢」升级成 5xx：会话列表本来就是最终一致视图。
func (handler *Handler) collect(ctx context.Context, provider string) ([]projectView, bool) {
	scan := newScanner(ctx, handler.hostHomeDir, handler.maxEntries)
	var projects []projectView
	switch {
	case provider == claudeProvider:
		projects = scan.claudeProjects(scan.knownProjectPaths())
	case provider == codexProvider:
		projects = scan.codexProjects()
	default:
		projects = scan.codebuddyProjects(provider)
	}
	return finalizeProjects(projects), scan.truncated
}

// routeSegments 取 {provider}/{accountRef}。
//
// 生产路由由 ServeMux 注册 "GET Path/{provider}/{accountRef}"，参数走 PathValue；
// 单测可以直接构造请求，此时按契约路径自行切分。路径段数量不对返回 false。
func routeSegments(request *http.Request) (string, string, bool) {
	provider := strings.TrimSpace(request.PathValue("provider"))
	accountRef := strings.TrimSpace(request.PathValue("accountRef"))
	if provider != "" && accountRef != "" {
		return provider, accountRef, true
	}
	rest := strings.Trim(strings.TrimPrefix(request.URL.Path, Path), "/")
	parts := strings.Split(rest, "/")
	if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" {
		return "", "", false
	}
	return parts[0], parts[1], true
}

func writeJSON(responseWriter http.ResponseWriter, status int, body any) {
	responseWriter.Header().Set("Content-Type", "application/json; charset=utf-8")
	responseWriter.WriteHeader(status)
	_ = json.NewEncoder(responseWriter).Encode(body)
}

func writeError(responseWriter http.ResponseWriter, status int, code, message string) {
	writeJSON(responseWriter, status, errorView{OK: false, Error: code, Message: message})
}
