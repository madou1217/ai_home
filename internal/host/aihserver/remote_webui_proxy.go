package aihserver

import (
	"net/http"
	"strings"
)

const remoteWebUIHeader = "X-Aih-Server-Id"

// withRemoteWebUIProxy 把带远端目标标识的 /v0/webui 请求交给前置门（Node）。
// Go 已承接 /v0/webui/*，如果不先分流，远端 profile 会读到本机账号；
// Node 的 webui-server-proxy 负责按 profile 解析 endpoint/key 并转发。
func withRemoteWebUIProxy(frontDoor http.Handler, next http.Handler) http.Handler {
	if frontDoor == nil {
		return next
	}
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if isRemoteWebUIRequest(request) {
			frontDoor.ServeHTTP(response, request)
			return
		}
		next.ServeHTTP(response, request)
	})
}

func isRemoteWebUIRequest(request *http.Request) bool {
	if request == nil || request.URL == nil {
		return false
	}
	path := request.URL.Path
	if path != "/v0/webui" && !strings.HasPrefix(path, "/v0/webui/") {
		return false
	}
	return strings.TrimSpace(request.Header.Get(remoteWebUIHeader)) != ""
}
