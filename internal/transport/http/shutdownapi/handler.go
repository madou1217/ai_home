// Package shutdownapi 暴露受 Management Key 保护的进程优雅退出端点。
//
// 存在的理由（P1）：Windows 上 Node 停止 Go Core 时 `child.kill('SIGTERM')` 实际走
// TerminateProcess，Go 的信号路径不会执行——内存里的账号运行态与用量事件每次停机都丢。
// 与其依赖信号，不如让宿主显式请求退出，由进程自己走 `server.Shutdown`。
package shutdownapi

import (
	"errors"
	"net/http"
	"strings"
)

// Path 与 Node 的 /v0/management/* 管理域保持一致。
const Path = "/v0/management/shutdown"

// ErrInvalidDependencies 表示 Handler 缺少鉴权器或退出回调。
var ErrInvalidDependencies = errors.New("关闭端点依赖无效")

// Authorizer 复用管理面既有的 Management Key 校验。
type Authorizer interface{ Authorized(*http.Request) bool }

// Dependencies 集中声明关闭端点的鉴权与退出回调。
type Dependencies struct {
	Authorizer Authorizer
	// RequestShutdown 在响应写出后触发优雅退出；必须是幂等且非阻塞的。
	RequestShutdown func()
}

// Handler 只接受 Management Key 鉴权过的 POST。
type Handler struct {
	authorizer Authorizer
	shutdown   func()
}

// NewHandler 创建失败关闭的关闭端点。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.RequestShutdown == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		shutdown:   dependencies.RequestShutdown,
	}, nil
}

// ServeHTTP 鉴权后立即返回 202，再异步触发退出。
//
// 顺序是刻意的：先写出响应，宿主才知道「退出已经受理」，随后才可能看到连接关闭。
// 反过来会让宿主把一次正常的优雅退出读成端点不可用，退回强杀。
func (handler *Handler) ServeHTTP(
	response http.ResponseWriter,
	request *http.Request,
) {
	if handler == nil || handler.authorizer == nil || handler.shutdown == nil {
		writeJSON(response, http.StatusServiceUnavailable, `{"ok":false,"error":"shutdown_unavailable"}`)
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(response, http.StatusUnauthorized, `{"ok":false,"error":"unauthorized"}`)
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeJSON(response, http.StatusMethodNotAllowed, `{"ok":false,"error":"method_not_allowed"}`)
		return
	}
	// 请求体没有语义；不读会让 keep-alive 连接上的后续请求解析错位。
	if request.Body != nil {
		_ = request.Body.Close()
	}
	writeJSON(response, http.StatusAccepted, `{"ok":true}`)
	go handler.shutdown()
}

// writeJSON 写出禁止缓存的 JSON，且不泄漏内部细节。
func writeJSON(response http.ResponseWriter, status int, body string) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_, _ = response.Write([]byte(strings.TrimSpace(body) + "\n"))
}
