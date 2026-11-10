// Package webuicontrolplanebootstrapapi 提供本机控制面引导契约：
//
//	GET /v1/management/webui/control-plane/bootstrap
//
// 语义对齐 Node 的 handleBootstrapLocalProfile：把「当前生效 endpoint + 本机 profile」
// 交回浏览器，用于 localStorage 被清空（PWA 存储回收 / 清站点数据 / 换浏览器）后恢复同机连接。
//
// 凭据边界：默认**不回传 Management Key 明文**，只回传 managementKeyConfigured 与
// managementKeySource，让调用方知道服务端是否已配置密钥。只有宿主注入的
// RevealManagementKey 对本次请求返回 true（通常就是 Node 的 loopback + 无转发头窄口）时，
// profile 才带上 managementKey；未注入或返回 false 时响应体不会出现 Key 明文。
//
// 数据边界：
//   - endpoint 只由请求地址与本机监听端口推导（PublicBaseURL 由宿主注入，未注入时退化为
//     请求自身的 scheme+Host），不做任何网络探测。
//   - profile 骨架来自 app-state.db 的 control-plane:profiles：按 endpoint 命中的记录原样
//     透传（统计值、时间戳保持调用方写入的样子），只覆盖 id/name/endpoint/state 并剔除
//     managementKey。归一化口径归 webuicontrolplaneapi（唯一写入口），本包不重算统计字段。
//   - 本契约只读，不写 store：引导请求不应该产生副作用（Node 同样不写）。
//
// 鉴权边界：Authorizer 负责全部放行判断，包括 Node 侧的本机窄口
// （webui-auth-gate 的 loopback_bootstrap：只允许 GET、TCP 对端 loopback、Host 为 loopback
// 名字且不带转发头）。那属于策略，不属于本契约；Handler 只认 Authorizer 的结论。
// 「能不能回明文」是另一条独立策略，由 RevealManagementKey 单独决定，不写在 Handler 里。
package webuicontrolplanebootstrapapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

// Path 是控制面引导的 WebUI 契约路径。
const Path = "/v1/management/webui/control-plane/bootstrap"

const (
	// localProfileID 是本机 profile 的固定标识（Node 的兜底值）。
	localProfileID = "local"
	// profileStateReady 表示这份 profile 就是当前正在服务的网关。
	profileStateReady = "ready"
	// managementKeySourceServer 说明密钥状态取自服务端当前生效配置，而不是 profile 快照。
	//
	// Node 的引导响应会用服务端当前 Key 覆盖 store 里的旧快照；Go 不回明文，因此用这个
	// 来源标记告诉调用方：configured 反映「服务端现在有没有密钥」，不能拿历史快照当依据。
	managementKeySourceServer = "server"
)

// ErrInvalidDependencies 表示 Handler 缺少鉴权策略或数据根目录。
var ErrInvalidDependencies = errors.New("控制面引导接口依赖无效")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 契约共用同一个 Bearer 实现）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// KeyConfiguredReporter 是 Authorizer 的可选扩展：报告服务端是否已配置 Management Key。
//
// 不实现时按「已配置」处理：请求能走到这里说明鉴权策略已经放行，缺密钥的场景由策略自己
// 拒绝；把未知当成未配置会让所有未接线的宿主都返回 404。
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
	//
	// 由宿主按反向代理头计算；零值时退化为请求自身的 scheme+Host（Node 只认 Host 头）。
	// 注入它是为了让端口映射场景仍能对上浏览器地址栏。
	PublicBaseURL func(*http.Request) string
	// RevealManagementKey 决定本次请求能否回传 Management Key 明文。
	//
	// 零值表示永不回明文（失败关闭）。注入方通常实现 Node 的 loopback 窄口：仅 GET、
	// TCP 对端 loopback、Host 为 loopback 名字且不带转发头。返回 true 时 profile 里带
	// managementKey（与 Node 同名同位置），值取自 control-plane:profiles 的已存快照；
	// 返回 false 或零值时响应体不出现该键。
	RevealManagementKey func(*http.Request) bool
}

// Handler 是控制面引导的 HTTP 入站适配器。
type Handler struct {
	authorizer          Authorizer
	aiHomeDir           string
	publicBaseURL       func(*http.Request) string
	revealManagementKey func(*http.Request) bool
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
	}, nil
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
	if !handler.authorizer.Authorized(request) {
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

// managementKeyConfigured 询问鉴权策略服务端是否已配置密钥。
func (handler *Handler) managementKeyConfigured() bool {
	if reporter, ok := handler.authorizer.(KeyConfiguredReporter); ok {
		return reporter.ManagementKeyConfigured()
	}
	return true
}

// revealableManagementKey 返回本次请求可以回传的明文 Key。
//
// 策略未注入、策略拒绝、或已存 profile 没有 Key 时都返回空串，调用方据此不写该字段——
// 空字符串也不写，避免把「没有」伪装成「有但是空」。
func (handler *Handler) revealableManagementKey(request *http.Request, existing map[string]any) string {
	if handler.revealManagementKey == nil || !handler.revealManagementKey(request) {
		return ""
	}
	return trimmedString(existing["managementKey"])
}

// bootstrapProfile 复刻 Node 的 profile 合并：以 endpoint 命中的已存 profile 为底，
// 覆盖 id/name/endpoint/state，并剔除 managementKey（本契约不回明文）。
//
// 不改动已存记录本身：入参是 store 解码出来的副本，返回值是新的 map。
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

// trimmedString 取字符串字段并去空白；非字符串一律视为空（endpoint/id 只会是字符串）。
func trimmedString(value any) string {
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
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
