// Package webuiaccountactivityapi 提供账号活动（签到 / 领臭鸡蛋）的 WebUI 数据面。
//
// 五条路由与 Node 的 webui-account-activity-routes.js 一一对应：
//
//	POST /v1/management/webui/account-activity/run
//	POST /v1/management/webui/account-activity/probe
//	GET  /v1/management/webui/account-activity/jobs/{jobId}
//	GET  /v1/management/webui/account-activity/params
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/activity/{actionId}
//
// 前四条为什么单独一个前缀：Go 的 ServeMux 会把 /accounts/activity/jobs/{id} 与
// /accounts/{provider}/{accountRef}/quota-reset-events 判成互不包含的歧义模式；
// 浏览器看到的仍是 Node 的 /v0/webui/accounts/activity/*，这里只是内部管理地址。
//
// 任务状态、运行守卫（防抖 + 唯一）、探测/领取互斥、探测上限与上游调用的串行化都在
// Go（见 internal/adapters/accountactivity）；本包只做管理鉴权、HTTP 形状与错误映射。
// Provider handler 仍由 Node 执行（无痕验证码 / 设备指纹只有 Node 运行时具备），
// 通过 Node 桥逐账号调用。
package webuiaccountactivityapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/accountactivity"
)

const (
	// Path 是活动任务前缀（独立命名空间，避免与账号级路由的 ServeMux 歧义）。
	Path = "/v1/management/webui/account-activity"
	// AccountsPath 是账号级契约前缀。
	AccountsPath = "/v1/management/webui/accounts"
	// RunPath / ProbePath / JobsPath / ParamsPath 是批量、探测、任务与参数端点。
	RunPath    = Path + "/run"
	ProbePath  = Path + "/probe"
	JobsPath   = Path + "/jobs/{jobId}"
	ParamsPath = Path + "/params"
	// AccountActionPath 是账号菜单里的单账号单动作。
	AccountActionPath = AccountsPath + "/{provider}/{accountRef}/activity/{actionId}"
	// maxSelectionBytes 与 Node 的 readBody(maxBytes: 8KB) 一致。
	maxSelectionBytes = 8 * 1024
)

// jobIDPattern 与 Node 的 JOB_ROUTE 一致：只接受任务 id 的字符集与长度。
var jobIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("账号活动接口依赖无效")

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总接口依赖。
type Dependencies struct {
	Authorizer Authorizer
	Service    *accountactivity.Service
}

// Handler 处理账号活动路由。
type Handler struct {
	authorizer Authorizer
	service    *accountactivity.Service
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Service == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: dependencies.Authorizer, service: dependencies.Service}, nil
}

type selectionRequest struct {
	Providers []string       `json:"providers"`
	ActionID  string         `json:"actionId"`
	Params    map[string]any `json:"params"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 按路径分发五条路由。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.service == nil {
		writeError(response, http.StatusServiceUnavailable, "activity_unavailable", "账号活动服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	switch {
	case request.URL.Path == RunPath:
		handler.handleRun(response, request)
	case request.URL.Path == ProbePath:
		handler.handleProbe(response, request)
	case request.URL.Path == ParamsPath:
		handler.handleParams(response, request)
	case strings.HasPrefix(request.URL.Path, Path+"/jobs/"):
		handler.handleJob(response, request)
	default:
		handler.handleAccountAction(response, request)
	}
}

func (handler *Handler) handleRun(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeMethodNotAllowed(response, http.MethodPost)
		return
	}
	selection, ok := readSelection(response, request)
	if !ok {
		return
	}
	writeOutcome(response, handler.service.Run(request.Context(), selection))
}

func (handler *Handler) handleProbe(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeMethodNotAllowed(response, http.MethodPost)
		return
	}
	selection, ok := readSelection(response, request)
	if !ok {
		return
	}
	writeOutcome(response, handler.service.Probe(request.Context(), selection))
}

func (handler *Handler) handleJob(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeMethodNotAllowed(response, http.MethodGet)
		return
	}
	jobID := strings.TrimPrefix(request.URL.Path, Path+"/jobs/")
	if !jobIDPattern.MatchString(jobID) {
		writeError(response, http.StatusNotFound, "activity_job_not_found", "")
		return
	}
	writeOutcome(response, handler.service.Job(jobID))
}

func (handler *Handler) handleParams(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		writeMethodNotAllowed(response, http.MethodGet)
		return
	}
	query := request.URL.Query()
	provider := strings.TrimSpace(query.Get("provider"))
	actionID := strings.TrimSpace(query.Get("actionId"))
	writeOutcome(response, handler.service.Params(request.Context(), provider, actionID))
}

func (handler *Handler) handleAccountAction(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		writeMethodNotAllowed(response, http.MethodPost)
		return
	}
	provider := strings.TrimSpace(request.PathValue("provider"))
	accountRef := strings.TrimSpace(request.PathValue("accountRef"))
	actionID := strings.TrimSpace(request.PathValue("actionId"))
	if provider == "" || accountRef == "" || actionID == "" {
		writeError(response, http.StatusBadRequest, "invalid_account_path", "")
		return
	}
	writeOutcome(response, handler.service.RunForAccount(request.Context(), provider, accountRef, actionID))
}

func readSelection(response http.ResponseWriter, request *http.Request) (accountactivity.Selection, bool) {
	limited := http.MaxBytesReader(response, request.Body, maxSelectionBytes)
	var payload selectionRequest
	if err := json.NewDecoder(limited).Decode(&payload); err != nil {
		// 缺字段 / 空数组 / 非法 JSON 一律按非法选择处理，绝不解释成「全部 Provider」。
		writeError(response, http.StatusBadRequest, "invalid_activity_selection", "")
		return accountactivity.Selection{}, false
	}
	return accountactivity.Selection{
		Providers: payload.Providers,
		ActionID:  payload.ActionID,
		Params:    payload.Params,
	}, true
}

func writeOutcome(response http.ResponseWriter, outcome accountactivity.Outcome) {
	status := outcome.Status
	if status == 0 {
		status = http.StatusOK
	}
	writeJSON(response, status, outcome.Payload)
}

func writeMethodNotAllowed(response http.ResponseWriter, allow string) {
	response.Header().Set("Allow", allow)
	writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 "+allow)
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
