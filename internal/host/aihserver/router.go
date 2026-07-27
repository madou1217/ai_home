package aihserver

import (
	"encoding/json"
	"net/http"

	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

// systemStatusResponse 是公开存活和就绪检查的稳定响应。
type systemStatusResponse struct {
	OK           bool     `json:"ok"`
	Service      string   `json:"service"`
	Ready        bool     `json:"ready,omitempty"`
	Capabilities []string `json:"capabilities,omitempty"`
}

// systemErrorResponse 是 Host 级路由错误的稳定响应。
type systemErrorResponse struct {
	Error systemErrorView `json:"error"`
}

// systemErrorView 只暴露安全错误码和固定消息。
type systemErrorView struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// newRouter 只挂载当前确认的系统路由和账号管理路由。
func newRouter(accountsHandler http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", handleHealth)
	mux.HandleFunc("/readyz", handleReadiness)
	mux.Handle(accountsapi.CollectionPath, accountsHandler)
	mux.Handle(accountsapi.CollectionPath+"/", accountsHandler)
	mux.HandleFunc("/", handleRouteNotFound)
	return mux
}

// handleHealth 返回不依赖账号数量的进程存活状态。
func handleHealth(response http.ResponseWriter, request *http.Request) {
	if !requireGet(response, request) {
		return
	}
	writeSystemJSON(response, http.StatusOK, systemStatusResponse{
		OK:      true,
		Service: "aih-server",
	})
}

// handleReadiness 明确当前进程只提供账号管理 v1 能力。
func handleReadiness(response http.ResponseWriter, request *http.Request) {
	if !requireGet(response, request) {
		return
	}
	writeSystemJSON(response, http.StatusOK, systemStatusResponse{
		OK:           true,
		Service:      "aih-server",
		Ready:        true,
		Capabilities: []string{"account_management_v1"},
	})
}

// handleRouteNotFound 返回 JSON 404，避免标准库默认纯文本泄漏合同差异。
func handleRouteNotFound(response http.ResponseWriter, _ *http.Request) {
	writeSystemJSON(response, http.StatusNotFound, systemErrorResponse{
		Error: systemErrorView{
			Code:    "route_not_found",
			Message: "请求的资源不存在",
		},
	})
}

// requireGet 让系统探针只接受安全的 GET 和 HEAD。
func requireGet(response http.ResponseWriter, request *http.Request) bool {
	if request.Method == http.MethodGet || request.Method == http.MethodHead {
		return true
	}
	response.Header().Set("Allow", http.MethodGet+", "+http.MethodHead)
	writeSystemJSON(response, http.StatusMethodNotAllowed, systemErrorResponse{
		Error: systemErrorView{
			Code:    "method_not_allowed",
			Message: "HTTP 方法不受支持",
		},
	})
	return false
}

// writeSystemJSON 写入禁止缓存的 Host 级 JSON 响应。
func writeSystemJSON(
	response http.ResponseWriter,
	status int,
	payload any,
) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}
