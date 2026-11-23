// Package webuiproxyserveapi 提供 WebUI 的本地代理入口会话管理。
//
// 入口本身由 aih-go 的 `proxy serve` 子进程承载；这里只做启停与状态投影。
// system/TUN 等需要操作系统提权的模式不在此暴露：管理面不能在用户没有看到
// 权限提示的情况下改系统代理或创建 TUN。
package webuiproxyserveapi

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/proxyserve"
)

const (
	// Path 是入口会话的状态与启停契约。
	//
	//	GET  /v1/management/webui/proxy-serve
	//	POST /v1/management/webui/proxy-serve/start
	//	POST /v1/management/webui/proxy-serve/stop
	Path      = "/v1/management/webui/proxy-serve"
	StartPath = Path + "/start"
	StopPath  = Path + "/stop"

	maxBodyBytes = 8 * 1024
)

// ErrInvalidDependencies 表示 Handler 缺少会话管理能力。
var ErrInvalidDependencies = errors.New("代理入口 WebUI 管理依赖无效")

// Authorizer 是管理面请求的鉴权策略。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// SessionManager 是入口子进程的唯一生命周期所有者。
type SessionManager interface {
	View() proxyserve.View
	Start(ctx context.Context, request proxyserve.Request) (proxyserve.View, error)
	Stop(ctx context.Context) error
}

// Dependencies 汇总 Handler 依赖。
type Dependencies struct {
	Authorizer Authorizer
	Manager    SessionManager
	// LocateCLI 仅用于投影「这台机器能否启动入口」；缺省用 proxyserve.LocateCLI。
	LocateCLI func() (string, error)
}

// Handler 是入口会话的 HTTP 入站适配器。
type Handler struct {
	authorizer Authorizer
	manager    SessionManager
	locateCLI  func() (string, error)
}

func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Manager == nil {
		return nil, ErrInvalidDependencies
	}
	locate := dependencies.LocateCLI
	if locate == nil {
		locate = proxyserve.LocateCLI
	}
	return &Handler{authorizer: dependencies.Authorizer, manager: dependencies.Manager, locateCLI: locate}, nil
}

func (handler *Handler) ServeHTTP(responseWriter http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || !handler.authorizer.Authorized(request) {
		http.Error(responseWriter, "unauthorized", http.StatusUnauthorized)
		return
	}
	switch strings.TrimRight(request.URL.Path, "/") {
	case Path:
		if !requireMethod(responseWriter, request, http.MethodGet) {
			return
		}
		handler.serveView(responseWriter)
	case StartPath:
		if !requireMethod(responseWriter, request, http.MethodPost) {
			return
		}
		handler.serveStart(responseWriter, request)
	case StopPath:
		if !requireMethod(responseWriter, request, http.MethodPost) {
			return
		}
		handler.serveStop(responseWriter, request)
	default:
		writeError(responseWriter, http.StatusNotFound, "not_found", "未找到代理入口接口")
	}
}

func (handler *Handler) serveView(responseWriter http.ResponseWriter) {
	available := true
	reason := ""
	if _, err := handler.locateCLI(); err != nil {
		available = false
		reason = "未找到与 Server 同目录的 aih-go 可执行文件"
	}
	writeJSON(responseWriter, http.StatusOK, map[string]any{
		"ok":           true,
		"session":      handler.manager.View(),
		"cliAvailable": available,
		"cliReason":    reason,
	})
}

func (handler *Handler) serveStart(responseWriter http.ResponseWriter, request *http.Request) {
	var body struct {
		Selector string `json:"selector"`
		NoSocks  bool   `json:"noSocks"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(responseWriter, request.Body, maxBodyBytes)).Decode(&body); err != nil {
		writeError(responseWriter, http.StatusBadRequest, "invalid_request_body", "请求体不是有效的 JSON")
		return
	}
	body.Selector = strings.TrimSpace(body.Selector)
	if body.Selector == "" {
		body.Selector = "auto"
	}
	view, err := handler.manager.Start(request.Context(), proxyserve.Request{Selector: body.Selector, NoSocks: body.NoSocks})
	if err != nil {
		writeStartError(responseWriter, err)
		return
	}
	writeJSON(responseWriter, http.StatusOK, map[string]any{"ok": true, "session": view})
}

func (handler *Handler) serveStop(responseWriter http.ResponseWriter, request *http.Request) {
	if err := handler.manager.Stop(request.Context()); err != nil {
		writeError(responseWriter, http.StatusInternalServerError, "proxy_serve_stop_failed", "停止代理入口失败："+err.Error())
		return
	}
	writeJSON(responseWriter, http.StatusOK, map[string]any{"ok": true, "session": handler.manager.View()})
}

func writeStartError(responseWriter http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, proxyserve.ErrSelectorInvalid):
		writeError(responseWriter, http.StatusBadRequest, "proxy_serve_selector_invalid", "出口选择器无效")
	case errors.Is(err, proxyserve.ErrAlreadyRunning):
		writeError(responseWriter, http.StatusConflict, "proxy_serve_already_running", "代理入口已在运行")
	case errors.Is(err, proxyserve.ErrCLINotFound):
		writeError(responseWriter, http.StatusServiceUnavailable, "proxy_serve_cli_not_found", "未找到与 Server 同目录的 aih-go 可执行文件")
	case errors.Is(err, proxyserve.ErrServerURL):
		writeError(responseWriter, http.StatusServiceUnavailable, "proxy_serve_server_url_missing", "Server 未配置可拨号的回环地址")
	case errors.Is(err, proxyserve.ErrStartTimeout):
		writeError(responseWriter, http.StatusGatewayTimeout, "proxy_serve_start_timeout", "代理入口启动超时")
	case errors.Is(err, proxyserve.ErrStartFailed):
		writeError(responseWriter, http.StatusBadGateway, "proxy_serve_start_failed", describeStartFailure(err))
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		writeError(responseWriter, http.StatusRequestTimeout, "proxy_serve_start_canceled", "请求已取消或超时")
	default:
		writeError(responseWriter, http.StatusInternalServerError, "proxy_serve_start_failed", err.Error())
	}
}

func describeStartFailure(err error) string {
	message := strings.TrimPrefix(err.Error(), proxyserve.ErrStartFailed.Error()+": ")
	if message == "" || message == proxyserve.ErrStartFailed.Error() {
		return "代理入口启动失败，请查看 Server 日志"
	}
	return "代理入口启动失败：" + message
}

func requireMethod(responseWriter http.ResponseWriter, request *http.Request, method string) bool {
	if request.Method == method {
		return true
	}
	responseWriter.Header().Set("Allow", method)
	writeError(responseWriter, http.StatusMethodNotAllowed, "method_not_allowed", fmt.Sprintf("只支持 %s", method))
	return false
}

func writeJSON(responseWriter http.ResponseWriter, status int, payload any) {
	responseWriter.Header().Set("Content-Type", "application/json; charset=utf-8")
	responseWriter.Header().Set("Cache-Control", "no-store")
	responseWriter.WriteHeader(status)
	_ = json.NewEncoder(responseWriter).Encode(payload)
}

func writeError(responseWriter http.ResponseWriter, status int, code, message string) {
	writeJSON(responseWriter, status, map[string]any{"ok": false, "error": code, "message": message})
}
