// Package webuiauth 复刻 Node 的 /v0/webui 鉴权门：所有客户端都要带 Management Key，
// 只有三个回环内部 ingress 与一个本机引导入口例外。
//
// 迁移 /v0/webui/* 到 Go 时，处理器仍按管理面鉴权（Bearer）；浏览器与插件走公开路径，
// 由这里先判定，再给下游请求注入 Bearer，避免同一能力出现两套鉴权结论。
package webuiauth

import (
	"crypto/subtle"
	"net"
	"net/http"
	"strings"
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
	"/v0/webui/internal/approval-request":        {},
	"/v0/webui/internal/remote-tools":            {},
	"/v0/webui/session-events/provider-hook":     {},
}

// bootstrapPath 是本机页面引导入口：浏览器存储被清掉后，同机 UI 用无 Key 入口取回配置。
var bootstrapPath = "/v0/webui/control-plane/bootstrap"

// Authorize 判定公开 WebUI 请求是否可以继续；publicPath 用于回环例外匹配。
func Authorize(request *http.Request, requiredKey string) Result {
	if request == nil {
		return Result{StatusCode: http.StatusUnauthorized, Reason: "missing_request"}
	}
	path := ""
	if request.URL != nil {
		path = request.URL.Path
	}
	if isNarrowIngress(request, path) {
		return Result{OK: true, Via: "internal_loopback"}
	}
	if isBootstrapIngress(request, path) {
		return Result{OK: true, Via: "loopback_bootstrap"}
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
	return Result{OK: true, Via: "management_key"}
}

// isNarrowIngress 只认 POST + 精确路径 + 回环对端。
func isNarrowIngress(request *http.Request, path string) bool {
	if request.Method != http.MethodPost {
		return false
	}
	if _, ok := narrowIngressPaths[path]; !ok {
		return false
	}
	return isLoopbackPeer(request)
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
	headers := request.Header
	if headers.Get("X-Forwarded-For") != "" ||
		headers.Get("X-Real-Ip") != "" ||
		headers.Get("Forwarded") != "" {
		return false
	}
	return true
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
		host = strings.TrimSpace(request.RemoteAddr)
	}
	host = strings.TrimPrefix(host, "::ffff:")
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
			host = host[:index+1]
		}
	} else if index := strings.LastIndex(host, ":"); index >= 0 {
		host = host[:index]
	}
	return host == "localhost" || host == "127.0.0.1" || host == "[::1]"
}
