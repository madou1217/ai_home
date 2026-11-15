// Package webuiauth 复刻 Node 的 /v0/webui 与 /v0/management 鉴权门：
//
//   - /v0/webui/*：所有客户端都要带 Management Key，只有三个回环内部 ingress 与一个本机引导入口例外；
//   - /v0/management/*：配置了 Management Key 时严格校验 Bearer；未配置时仅允许本机直连回环访问。
//
// 迁移 /v0/webui/* 与 /v0/management/* 到 Go 时，处理器仍按管理面鉴权（Bearer）；浏览器与 CLI
// 走公开路径，由这里先判定，再给下游请求注入 Bearer 或回环上下文标记，避免同一能力出现两套鉴权结论。
package webuiauth

import (
	"crypto/subtle"
	"net"
	"net/http"
	"strings"
)

// Via* 常量标识请求通过鉴权门的具体路径。
const (
	ViaManagementKey     = "management_key"
	ViaInternalLoopback  = "internal_loopback"
	ViaLoopbackBootstrap = "loopback_bootstrap"
	ViaLoopback          = "loopback"
)

// Result 是一次鉴权结论。
type Result struct {
	OK         bool
	StatusCode int
	Reason     string
	Via        string
}

// narrowIngressPaths 是自带会话令牌的本机内部 POST ingress：不返回管理数据，
// 也不能扩展成普通 WebUI 信任边界。
var narrowIngressPaths = map[string]struct{}{
	"/v0/webui/internal/approval-request":    {},
	"/v0/webui/internal/remote-tools":        {},
	"/v0/webui/session-events/provider-hook": {},
}

// bootstrapPath 是本机页面引导入口：浏览器存储被清掉后，同机 UI 用无 Key 入口取回配置。
var bootstrapPath = "/v0/webui/control-plane/bootstrap"

// forwardedHeaderNames 对齐 Node management-key-auth.js 的 FORWARDED_HEADERS 并覆盖反代头。
// 出现任意一个非空值都意味着请求经由反向代理或跨节点转发，不得按本机直连放行。
var forwardedHeaderNames = []string{
	"X-Forwarded-For",
	"X-Real-Ip",
	"Cf-Connecting-Ip",
	"Forwarded",
	"X-Aih-Server-Id",
	"X-Forwarded-Host",
	"X-Forwarded-Proto",
}

// Authorize 判定公开 WebUI 请求是否可以继续。
func Authorize(request *http.Request, requiredKey string) Result {
	if request == nil {
		return Result{StatusCode: http.StatusUnauthorized, Reason: "missing_request"}
	}
	path := ""
	if request.URL != nil {
		path = request.URL.Path
	}
	if isNarrowIngress(request, path) {
		return Result{OK: true, Via: ViaInternalLoopback}
	}
	if isBootstrapIngress(request, path) {
		return Result{OK: true, Via: ViaLoopbackBootstrap}
	}
	expected := strings.TrimSpace(requiredKey)
	if expected == "" {
		return Result{StatusCode: http.StatusServiceUnavailable, Reason: "management_key_not_configured"}
	}
	credential := bearerCredential(request)
	if credential == "" {
		return Result{StatusCode: http.StatusUnauthorized, Reason: "missing_credential"}
	}
	if subtle.ConstantTimeCompare([]byte(credential), []byte(expected)) != 1 {
		return Result{StatusCode: http.StatusUnauthorized, Reason: "unauthorized_management"}
	}
	return Result{OK: true, Via: ViaManagementKey}
}

// AuthorizeManagementKeyOrLoopback 复刻 Node management-key-auth.js 的 authorizeManagementKeyOrLoopback：
// 已配置 Management Key 时必须携带匹配的 Bearer；未配置时仅对无转发头的本机回环连接放行。
func AuthorizeManagementKeyOrLoopback(request *http.Request, requiredKey string) Result {
	if request == nil {
		return Result{StatusCode: http.StatusUnauthorized, Reason: "unauthorized_management"}
	}
	expected := strings.TrimSpace(requiredKey)
	if expected != "" {
		credential := bearerCredential(request)
		if credential == "" || subtle.ConstantTimeCompare([]byte(credential), []byte(expected)) != 1 {
			return Result{StatusCode: http.StatusUnauthorized, Reason: "unauthorized_management"}
		}
		return Result{OK: true, Via: ViaManagementKey}
	}
	if isLoopbackPeer(request) && !hasForwardedHeaders(request.Header) {
		return Result{OK: true, Via: ViaLoopback}
	}
	return Result{StatusCode: http.StatusServiceUnavailable, Reason: "management_key_not_configured"}
}

// isNarrowIngress 只认 POST + 精确路径 + 无转发头的本机回环对端。
func isNarrowIngress(request *http.Request, path string) bool {
	if request.Method != http.MethodPost {
		return false
	}
	if _, ok := narrowIngressPaths[path]; !ok {
		return false
	}
	return isLoopbackPeer(request) && !hasForwardedHeaders(request.Header)
}

// isBootstrapIngress 额外要求 Host 是本机名字且没有任何转发头：
// 反向代理转发到 127.0.0.1 时对端也是回环，只能靠这两条挡住外部域名。
func isBootstrapIngress(request *http.Request, path string) bool {
	if request.Method != http.MethodGet || path != bootstrapPath {
		return false
	}
	if !isLoopbackPeer(request) {
		return false
	}
	if !isLoopbackHostName(request.Host) {
		return false
	}
	if hasForwardedHeaders(request.Header) {
		return false
	}
	return true
}

func hasForwardedHeaders(header http.Header) bool {
	if len(header) == 0 {
		return false
	}
	for _, name := range forwardedHeaderNames {
		for _, value := range header.Values(name) {
			if strings.TrimSpace(value) != "" {
				return true
			}
		}
	}
	return false
}

// bearerCredential 只接受 Authorization: Bearer（与 Node 的策略一致）。
func bearerCredential(request *http.Request) string {
	header := strings.TrimSpace(request.Header.Get("Authorization"))
	parts := strings.Fields(header)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return parts[1]
}

// isLoopbackPeer 按 TCP 对端地址判定；缺地址（进程内调用）视为非回环。
func isLoopbackPeer(request *http.Request) bool {
	host, _, err := net.SplitHostPort(strings.TrimSpace(request.RemoteAddr))
	if err != nil {
		host = strings.Trim(strings.TrimSpace(request.RemoteAddr), "[]")
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

// isLoopbackHostName 判定 Host 头是不是本机名字（含端口写法）。
func isLoopbackHostName(value string) bool {
	host := strings.ToLower(strings.TrimSpace(value))
	if host == "" {
		return false
	}
	if host == "::1" {
		return true
	}
	if strings.HasPrefix(host, "[") {
		if index := strings.Index(host, "]"); index >= 0 {
			rest := host[index+1:]
			if rest != "" && !isPortSuffix(rest) {
				return false
			}
			host = host[:index+1]
		}
	} else if index := strings.LastIndex(host, ":"); index >= 0 {
		if isPortSuffix(host[index:]) {
			host = host[:index]
		}
	}
	return host == "localhost" || host == "127.0.0.1" || host == "[::1]"
}

func isPortSuffix(suffix string) bool {
	if len(suffix) < 2 || suffix[0] != ':' {
		return false
	}
	for _, ch := range suffix[1:] {
		if ch < '0' || ch > '9' {
			return false
		}
	}
	return true
}
