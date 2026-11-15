// Package webuicontrolplanebootstrapapi 提供本机控制面引导契约：
//
//	GET /v1/management/webui/control-plane/bootstrap
//	GET /v0/webui/control-plane/bootstrap
//
// 语义对齐 Node 的 handleBootstrapLocalProfile：把「当前生效 endpoint + 本机 profile」
// 交回浏览器，用于 localStorage 被清空（PWA 存储回收 / 清站点数据 / 换浏览器）后恢复同机连接。
package webuicontrolplanebootstrapapi

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/webuiauth"
)

// Path 是控制面引导的管理面契约路径。
const Path = "/v1/management/webui/control-plane/bootstrap"

// PublicPath 是浏览器直连的控制面引导公开路径。
const PublicPath = "/v0/webui/control-plane/bootstrap"

const (
	// localProfileID 是本机 profile 的固定标识（Node 的兜底值）。
	localProfileID = "local"
	// profileStateReady 表示这份 profile 就是当前正在服务的网关。
	profileStateReady = "ready"
	// managementKeySourceServer 说明密钥状态取自服务端当前生效配置，而不是 profile 快照。
	managementKeySourceServer = "server"
)

var bootstrapForwardedHeaders = []string{
	"X-Forwarded-For",
	"X-Real-Ip",
	"Cf-Connecting-Ip",
	"Forwarded",
	"X-Aih-Server-Id",
	"X-Forwarded-Host",
	"X-Forwarded-Proto",
}

// ErrInvalidDependencies 表示 Handler 缺少鉴权策略或数据根目录。
var ErrInvalidDependencies = errors.New("控制面引导接口依赖无效")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 契约共用同一个 Bearer 实现）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// KeyConfiguredReporter 是 Authorizer 的可选扩展：报告服务端是否已配置 Management Key。
type KeyConfiguredReporter interface {
	ManagementKeyConfigured() bool
}

// Dependencies 汇总引导契约的依赖。
type Dependencies struct {
	// Authorizer 是必需的管理面鉴权策略。
	Authorizer Authorizer
	// AIHomeDir 是 app-state.db 所在的数据根目录（读 control-plane:profiles）。
	AIHomeDir string
	// PublicBaseURL 返回浏览器可见的 base URL（scheme://host[:port]）。
	PublicBaseURL func(*http.Request) string
	// RevealManagementKey 决定本次请求能否回传 Management Key 明文。
	//
	// 注入方通常传入 IsLoopbackBootstrapRequest（仅 GET、TCP 对端 loopback、Host 为 loopback
	// 名字且不带转发头）。未显式注入时，仅对已通过外层 webuiauth 本机引导窄口（loopback_bootstrap）
	// 且满足 IsLoopbackBootstrapRequest 的请求回传明文，管理面裸调保持失败关闭。
	RevealManagementKey func(*http.Request) bool
	// ManagementKey 返回服务端当前生效的 Management Key（可选）。
	ManagementKey func() string
}

// Handler 是控制面引导的 HTTP 入站适配器。
type Handler struct {
	authorizer          Authorizer
	aiHomeDir           string
	publicBaseURL       func(*http.Request) string
	revealManagementKey func(*http.Request) bool
	managementKey       func() string
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (http.Handler, error) {
	if dependencies.Authorizer == nil || strings.TrimSpace(dependencies.AIHomeDir) == "" {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer:          dependencies.Authorizer,
		aiHomeDir:           strings.TrimSpace(dependencies.AIHomeDir),
		publicBaseURL:       dependencies.PublicBaseURL,
		revealManagementKey: dependencies.RevealManagementKey,
		managementKey:       dependencies.ManagementKey,
	}, nil
}

// IsLoopbackBootstrapRequest 复刻 Node 本机引导明文回传的窄边界：
// 仅允许 GET、TCP 对端为回环地址、请求 Host（及可选 host 查询参数）为本机名字，且不携带任何代理转发头。
func IsLoopbackBootstrapRequest(request *http.Request) bool {
	if request == nil || request.Method != http.MethodGet {
		return false
	}
	if !isLoopbackPeerAddr(request.RemoteAddr) {
		return false
	}
	if !isLoopbackHostName(request.Host) {
		return false
	}
	if hasBootstrapForwardingHeaders(request.Header) {
		return false
	}
	if request.URL != nil {
		query := request.URL.Query()
		if query.Has("host") && !isLoopbackHostName(query.Get("host")) {
			return false
		}
	}
	return true
}

func isLoopbackPeerAddr(remoteAddr string) bool {
	trimmed := strings.TrimSpace(remoteAddr)
	if trimmed == "" {
		return false
	}
	host, _, err := net.SplitHostPort(trimmed)
	if err != nil {
		host = strings.Trim(trimmed, "[]")
	}
	if zoneIndex := strings.IndexByte(host, '%'); zoneIndex >= 0 {
		host = host[:zoneIndex]
	}
	host = strings.TrimPrefix(strings.ToLower(host), "::ffff:")
	if host == "::1" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func hasBootstrapForwardingHeaders(header http.Header) bool {
	if len(header) == 0 {
		return false
	}
	for _, name := range bootstrapForwardedHeaders {
		for _, value := range header.Values(name) {
			if strings.TrimSpace(value) != "" {
				return true
			}
		}
	}
	return false
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 只放行 GET：先鉴权再判方法，避免未授权请求靠状态码探测路由。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil {
		writeError(response, http.StatusServiceUnavailable, "control_plane_bootstrap_unavailable", "控制面引导服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) && !webuiauth.IsLoopbackBootstrap(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "")
		return
	}
	handler.handleBootstrap(response, request)
}

// handleBootstrap 组装引导响应。
//
// 服务端没有配置 Management Key 时返回 404（Node 的 management_key_not_configured）：
// 引导的全部意义是让浏览器恢复连接，没有密钥就没有可引导的东西。
func (handler *Handler) handleBootstrap(response http.ResponseWriter, request *http.Request) {
	if !handler.managementKeyConfigured() {
		writeError(response, http.StatusNotFound, "management_key_not_configured", "")
		return
	}
	resolution := handler.resolveEndpoint(request)
	store, err := handler.readProfileStore(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "control_plane_bootstrap_read_failed", "")
		return
	}
	existing := store.profileByEndpoint(resolution.Endpoint)
	profile := bootstrapProfile(existing, resolution.Endpoint)
	if key := handler.revealableManagementKey(request, existing); key != "" {
		profile["managementKey"] = key
	}
	hints, warnings := buildEndpointHints(resolution)
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":                      true,
		"profile":                 profile,
		"activeProfileId":         store.activeProfileID(trimmedString(profile["id"])),
		"endpoints":               hints,
		"warnings":                warnings,
		"managementKeyConfigured": true,
		"managementKeySource":     managementKeySourceServer,
	})
}

// managementKeyConfigured 询问鉴权策略或实时提供方服务端是否已配置密钥。
func (handler *Handler) managementKeyConfigured() bool {
	if handler.managementKey != nil {
		return strings.TrimSpace(handler.managementKey()) != ""
	}
	if reporter, ok := handler.authorizer.(KeyConfiguredReporter); ok {
		return reporter.ManagementKeyConfigured()
	}
	return true
}

// revealableManagementKey 返回本次请求可以回传的明文 Key。
func (handler *Handler) revealableManagementKey(request *http.Request, existing map[string]any) string {
	allowed := false
	if handler.revealManagementKey != nil {
		allowed = handler.revealManagementKey(request)
	} else if webuiauth.IsLoopbackBootstrap(request) {
		allowed = IsLoopbackBootstrapRequest(request)
	}
	if !allowed {
		return ""
	}
	if handler.managementKey != nil {
		if live := strings.TrimSpace(handler.managementKey()); live != "" {
			return live
		}
	}
	return trimmedString(existing["managementKey"])
}

// bootstrapProfile 复刻 Node 的 profile 合并：以 endpoint 命中的已存 profile 为底，
// 覆盖 id/name/endpoint/state，并剔除旧快照里的 managementKey。
func bootstrapProfile(existing map[string]any, endpoint string) map[string]any {
	profile := make(map[string]any, len(existing)+4)
	for key, value := range existing {
		profile[key] = value
	}
	delete(profile, "managementKey")
	if trimmedString(profile["id"]) == "" {
		profile["id"] = localProfileID
	}
	if trimmedString(profile["name"]) == "" {
		profile["name"] = localProfileID
	}
	profile["endpoint"] = endpoint
	profile["state"] = profileStateReady
	return profile
}

func trimmedString(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	encoder := json.NewEncoder(response)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
