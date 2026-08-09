package aihserver

import (
	"encoding/json"
	"net/http"

	"github.com/madou1217/ai_home/internal/transport/http/accountauthapi"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/anthropicmessagesapi"
	"github.com/madou1217/ai_home/internal/transport/http/claudenativerelay"
	"github.com/madou1217/ai_home/internal/transport/http/clauderelayleaseapi"
	"github.com/madou1217/ai_home/internal/transport/http/clientpropsapi"
	"github.com/madou1217/ai_home/internal/transport/http/modelsapi"
	"github.com/madou1217/ai_home/internal/transport/http/openaichatcompletionsapi"
	"github.com/madou1217/ai_home/internal/transport/http/openairesponsesapi"
)

// systemStatusResponse 是公开存活和就绪检查的稳定响应。
type systemStatusResponse struct {
	OK                    bool     `json:"ok"`
	Service               string   `json:"service"`
	Ready                 bool     `json:"ready,omitempty"`
	Capabilities          []string `json:"capabilities,omitempty"`
	InferenceCatalogReady bool     `json:"inference_catalog_ready,omitempty"`
	InferenceCatalogStale bool     `json:"inference_catalog_stale,omitempty"`
	ModelCount            int      `json:"model_count,omitempty"`
	RouteCount            int      `json:"route_count,omitempty"`
}

// catalogReadiness 是 Host 探针读取的低敏原子目录状态。
type catalogReadiness struct {
	ready      bool
	stale      bool
	modelCount int
	routeCount int
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

// newRouter 挂载系统、账号、推理和 Claude Native Relay 路由。
func newRouter(handlers serverHandlers) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", handleHealth)
	mux.HandleFunc("/readyz", func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		handleReadiness(response, request, handlers.catalogStatus)
	})
	mux.Handle(accountsapi.NativeImportPath, handlers.accounts)
	mux.Handle(accountsapi.Sub2APIImportPath, handlers.accounts)
	mux.Handle(accountsapi.CollectionPath, handlers.accounts)
	mux.Handle(accountsapi.CollectionPath+"/", handlers.accounts)
	mux.Handle(accountsapi.SelectionPath, handlers.accounts)
	mux.Handle(accountsapi.DefaultsPath+"/", handlers.accounts)
	mux.Handle(modelsapi.Path, handlers.models)
	mux.Handle(clientpropsapi.Path, clientpropsapi.NewHandler())
	mux.Handle(accountauthapi.CollectionPath, handlers.accountAuth)
	mux.Handle(accountauthapi.CollectionPath+"/", handlers.accountAuth)
	mux.Handle(
		clauderelayleaseapi.Path,
		handlers.claudeRelayLeases,
	)
	mux.Handle(openairesponsesapi.Path, handlers.inference)
	mux.Handle(openaichatcompletionsapi.Path, handlers.inference)
	// /v1/messages 统一进入透传入口：能无损透传的走字节转发，其余（跨协议、
	// 非 claude 模型、非官方端点凭据、不满足透传合同）由它自行交回 Canonical。
	//
	// 此前按 Relay Token 分流，等于只有官方 Claude Code 能用无损路径；其它
	// 客户端即使上游就是 claude 账号也被迫走 Canonical 重建——那是丢字段
	// （stop_details / service_tier / inference_geo / cache_creation）与错状态
	// 的来源，且同协议下这些信息本来是 1:1 的。
	mux.Handle(anthropicmessagesapi.Path, handlers.claudeNativeRelay)
	mux.HandleFunc("/", handleRouteNotFound)
	return mux
}

// claudeMessagesDispatcher 让同一路径按服务端签发的 Relay Token 区分原生透传。
//
// 只要请求声明 Relay Token 就必须进入 Relay 自身鉴权；无效 Token 不能降级为
// 普通客户端请求，避免权限域混淆。
//
// 尚未按「同协议一律透传」放宽，阻碍是 Relay 硬编码只打官方 Messages 端点
// （officialMessagesEndpoint，订阅 OAuth 唯一允许的真实目标，属安全属性）。
// 把全部 Messages 流量导入透传会让原本经 Canonical、可指向其它端点的请求改道，
// 包括测试替身上游。放宽前需先让透传按凭据判定是否适用，且给出可注入的上游
// 客户端边界；Relay 侧的调度取号、多账号轮转与委派回 Canonical 已经就位。
type claudeMessagesDispatcher struct {
	canonical http.Handler
	relay     http.Handler
}

func (dispatcher claudeMessagesDispatcher) ServeHTTP(
	response http.ResponseWriter,
	request *http.Request,
) {
	if request != nil &&
		len(request.Header.Values(claudenativerelay.RelayTokenHeader)) > 0 {
		dispatcher.relay.ServeHTTP(response, request)
		return
	}
	dispatcher.canonical.ServeHTTP(response, request)
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

// handleReadiness 明确当前进程已经装配的稳定能力。
func handleReadiness(
	response http.ResponseWriter,
	request *http.Request,
	statusReader func() catalogReadiness,
) {
	if !requireGet(response, request) {
		return
	}
	status := catalogReadiness{}
	if statusReader != nil {
		status = statusReader()
	}
	httpStatus := http.StatusOK
	if !status.ready {
		httpStatus = http.StatusServiceUnavailable
	}
	writeSystemJSON(response, httpStatus, systemStatusResponse{
		OK:      status.ready,
		Service: "aih-server",
		Ready:   status.ready,
		Capabilities: []string{
			"account_management_v1",
			"account_usage_v1",
			"account_auth_jobs_v1",
			"local_model_catalog_v1",
			"canonical_inference_v1",
			"claude_relay_leases_v1",
			"claude_native_relay_v1",
		},
		InferenceCatalogReady: status.ready,
		InferenceCatalogStale: status.stale,
		ModelCount:            status.modelCount,
		RouteCount:            status.routeCount,
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
