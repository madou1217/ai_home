// Package webuiaccountdetectapi 提供「扫描本机账号」的 WebUI 写入口。
//
// 路由（由共享 wiring 注册，本包只导出模式常量）：
//
//	POST /v1/management/webui/accounts/detect
//
// 契约与 Node 的 handleDetectHostAccountsRequest 一致：成功 200，检测器整体不可用
// 时 500，响应体保持 {ok, scanned, updated, reloaded, registered, skipped, accounts}。
// 扫描执行本身仍走 Node 宿主能力（家族 .info 需要厂商 Electron 运行时解密、桌面端
// 状态库与登录 shell 环境只有 Node 侧实现）；Go 持有路由、鉴权、响应契约与后续替换点。
package webuiaccountdetectapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
)

// Path 是本接口的管理契约路径（Node 侧为 /v0/webui/accounts/detect）。
const Path = "/v1/management/webui/accounts/detect"

// ErrInvalidDependencies 表示 Handler 缺少鉴权策略或检测端口。
var ErrInvalidDependencies = errors.New("账号发现接口依赖无效")

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Detector 执行一次本机账号扫描：返回 HTTP 状态与 Node 同形的响应体。
//
// 用 (status, body) 而不是具名结构体，是为了让适配器不反向依赖传输层包。
type Detector interface {
	Detect(ctx context.Context) (status int, body []byte, err error)
}

// Dependencies 汇总接口依赖；Detector 为空时请求回 503。
type Dependencies struct {
	Authorizer Authorizer
	Detector   Detector
}

// Handler 是账号发现的管理面入站适配器。
type Handler struct {
	authorizer Authorizer
	detector   Detector
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: dependencies.Authorizer, detector: dependencies.Detector}, nil
}

type errorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

type errorResponse struct {
	OK    bool      `json:"ok"`
	Error errorBody `json:"error"`
}

// ServeHTTP 只接受带管理密钥的 POST。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil {
		writeError(response, http.StatusServiceUnavailable, "account_detect_unavailable", "账号发现接口不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持扫描账号")
		return
	}
	if handler.detector == nil {
		writeError(response, http.StatusServiceUnavailable, "detect_host_accounts_unavailable", "本机账号扫描不可用")
		return
	}
	status, body, err := handler.detector.Detect(request.Context())
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "detect_host_accounts_unavailable", "本机账号扫描不可用")
		return
	}
	if status < 200 || status > 599 {
		status = http.StatusOK
	}
	if len(body) == 0 {
		body = json.RawMessage(`{"ok":false,"error":"detect_host_accounts_unavailable"}`)
		status = http.StatusServiceUnavailable
	}
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_, _ = response.Write(body)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(errorResponse{OK: false, Error: errorBody{Code: code, Message: message}})
}
