package aihserver

import (
	"net"
	"net/http"
	"net/url"
	"strings"
)

const managementPathPrefix = "/v1/management"

var managementBrowserMethods = map[string]struct{}{
	http.MethodDelete: {},
	http.MethodGet:    {},
	http.MethodPatch:  {},
	http.MethodPost:   {},
	http.MethodPut:    {},
}

var managementBrowserHeaders = map[string]struct{}{
	"accept":        {},
	"authorization": {},
	"content-type":  {},
}

// withManagementBrowserAccess 只允许本机 WebUI 跨端口访问 Go 管理面。
//
// 推理路径不获得 CORS 权限；桌面端继续通过 Rust 原生传输，不依赖此策略。
func withManagementBrowserAccess(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if next == nil || request == nil {
			handleRouteNotFound(response, request)
			return
		}
		if !isManagementPath(request.URL.Path) {
			next.ServeHTTP(response, request)
			return
		}
		origin := request.Header.Get("Origin")
		if origin == "" {
			next.ServeHTTP(response, request)
			return
		}
		if !isLoopbackBrowserOrigin(origin) {
			writeSystemJSON(response, http.StatusForbidden, systemErrorResponse{
				Error: systemErrorView{
					Code:    "browser_origin_forbidden",
					Message: "浏览器来源不受支持",
				},
			})
			return
		}
		setManagementBrowserHeaders(response.Header(), origin)
		if request.Method != http.MethodOptions {
			next.ServeHTTP(response, request)
			return
		}
		if !validManagementPreflight(request) {
			writeSystemJSON(response, http.StatusForbidden, systemErrorResponse{
				Error: systemErrorView{
					Code:    "browser_preflight_forbidden",
					Message: "浏览器预检请求不受支持",
				},
			})
			return
		}
		response.WriteHeader(http.StatusNoContent)
	})
}

// isManagementPath 使用完整路径段匹配，拒绝相似前缀绕过管理面边界。
func isManagementPath(path string) bool {
	return path == managementPathPrefix ||
		strings.HasPrefix(path, managementPathPrefix+"/")
}

// isLoopbackBrowserOrigin 接受 localhost 和真实 loopback IP，不信任可重绑定域名。
func isLoopbackBrowserOrigin(origin string) bool {
	parsed, err := url.Parse(origin)
	if err != nil ||
		(parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.Host == "" ||
		parsed.User != nil ||
		(parsed.Path != "" && parsed.Path != "/") ||
		parsed.RawQuery != "" ||
		parsed.Fragment != "" {
		return false
	}
	host := parsed.Hostname()
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// validManagementPreflight 只接受 Web 传输实际使用的方法和请求头。
func validManagementPreflight(request *http.Request) bool {
	method := strings.ToUpper(strings.TrimSpace(
		request.Header.Get("Access-Control-Request-Method"),
	))
	if _, allowed := managementBrowserMethods[method]; !allowed {
		return false
	}
	for _, rawHeader := range strings.Split(
		request.Header.Get("Access-Control-Request-Headers"),
		",",
	) {
		header := strings.ToLower(strings.TrimSpace(rawHeader))
		if header == "" {
			continue
		}
		if _, allowed := managementBrowserHeaders[header]; !allowed {
			return false
		}
	}
	return true
}

// setManagementBrowserHeaders 回显已校验 Origin，且不启用 Cookie 凭据。
func setManagementBrowserHeaders(header http.Header, origin string) {
	header.Add("Vary", "Origin")
	header.Set("Access-Control-Allow-Origin", origin)
	header.Set("Access-Control-Allow-Methods", "DELETE, GET, PATCH, POST, PUT")
	header.Set("Access-Control-Allow-Headers", "Accept, Authorization, Content-Type")
	header.Set("Access-Control-Expose-Headers", "Content-Disposition, Content-Type")
	header.Set("Access-Control-Max-Age", "600")
}
