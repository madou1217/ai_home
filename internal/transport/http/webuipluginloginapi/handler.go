// Package webuipluginloginapi 提供插件账号登录的 WebUI 管理入口。
//
// 路由（管理面，浏览器同构别名由 router 自动生成）：
//
//	POST /v1/management/webui/accounts/plugin-login/start
//	GET  /v1/management/webui/accounts/plugin-login/{jobId}
//	POST /v1/management/webui/accounts/plugin-login/{jobId}/submit
//	POST /v1/management/webui/accounts/plugin-login/{jobId}/cancel
//
// 任务状态机与投影登记在 pluginhost.Service；本包只负责鉴权、体积上限与错误映射。
package webuipluginloginapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/pluginerr"
	"github.com/madou1217/ai_home/internal/runtime/pluginhost"
)

const (
	// StartPath 是登录任务集合入口。
	StartPath = "/v1/management/webui/accounts/plugin-login/start"
	// Prefix 是单任务入口前缀。
	Prefix             = "/v1/management/webui/accounts/plugin-login/"
	maxStartBodyBytes  = 64 * 1024
	maxSubmitBodyBytes = 128 * 1024
)

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// LoginService 是插件登录任务端口。
type LoginService interface {
	StartAccountLogin(ctx context.Context, req pluginhost.AccountLoginStartRequest) (pluginhost.AccountLoginJob, error)
	PollAccountLogin(ctx context.Context, jobID string) (pluginhost.AccountLoginJob, error)
	SubmitAccountLogin(ctx context.Context, jobID, value string) (pluginhost.AccountLoginJob, error)
	CancelAccountLogin(ctx context.Context, jobID string) (pluginhost.AccountLoginJob, error)
}

// Dependencies 汇总 Handler 依赖。
type Dependencies struct {
	Authorizer Authorizer
	Service    LoginService
}

// Handler 处理插件登录的四个动词。
type Handler struct {
	authorizer Authorizer
	service    LoginService
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, errors.New("插件登录接口缺少鉴权器")
	}
	return &Handler{authorizer: dependencies.Authorizer, service: dependencies.Service}, nil
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || !handler.authorizer.Authorized(request) {
		writeJSON(response, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
		return
	}
	if handler.service == nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "plugin_runtime_inactive"})
		return
	}
	path := strings.TrimSpace(request.URL.Path)
	switch {
	case request.Method == http.MethodPost && path == StartPath:
		handler.start(response, request)
	case request.Method == http.MethodGet && strings.HasPrefix(path, Prefix) && !strings.Contains(strings.TrimPrefix(path, Prefix), "/"):
		handler.poll(response, request, strings.TrimPrefix(path, Prefix))
	case request.Method == http.MethodPost && strings.HasPrefix(path, Prefix):
		rest := strings.TrimPrefix(path, Prefix)
		if strings.HasSuffix(rest, "/submit") {
			handler.submit(response, request, strings.TrimSuffix(rest, "/submit"))
			return
		}
		if strings.HasSuffix(rest, "/cancel") {
			handler.cancel(response, request, strings.TrimSuffix(rest, "/cancel"))
			return
		}
		writeJSON(response, http.StatusNotFound, map[string]any{"ok": false, "error": "not_found"})
	default:
		writeJSON(response, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
	}
}

func (handler *Handler) start(response http.ResponseWriter, request *http.Request) {
	var payload struct {
		Provider string `json:"provider"`
		SourceID string `json:"sourceId"`
	}
	if !decodeBody(response, request, maxStartBodyBytes, &payload) {
		return
	}
	provider := strings.ToLower(strings.TrimSpace(payload.Provider))
	sourceID := strings.TrimSpace(payload.SourceID)
	if provider == "" || sourceID == "" {
		writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_payload"})
		return
	}
	job, err := handler.service.StartAccountLogin(request.Context(), pluginhost.AccountLoginStartRequest{
		Provider: provider,
		SourceID: sourceID,
	})
	if err != nil {
		writeServiceError(response, err, "account_login_failed")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "job": job.Public()})
}

func (handler *Handler) poll(response http.ResponseWriter, request *http.Request, jobID string) {
	jobID = strings.TrimSpace(jobID)
	if jobID == "" {
		writeJSON(response, http.StatusNotFound, map[string]any{"ok": false, "error": "account_login_job_not_found"})
		return
	}
	job, err := handler.service.PollAccountLogin(request.Context(), jobID)
	if err != nil {
		writeServiceError(response, err, "account_login_failed")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "job": job.Public()})
}

func (handler *Handler) submit(response http.ResponseWriter, request *http.Request, jobID string) {
	jobID = strings.TrimSpace(jobID)
	var payload struct {
		Value string `json:"value"`
	}
	if !decodeBody(response, request, maxSubmitBodyBytes, &payload) {
		return
	}
	if strings.TrimSpace(payload.Value) == "" {
		writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "account_login_submit_value_required"})
		return
	}
	job, err := handler.service.SubmitAccountLogin(request.Context(), jobID, payload.Value)
	if err != nil {
		writeServiceError(response, err, "account_login_submit_failed")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "job": job.Public()})
}

func (handler *Handler) cancel(response http.ResponseWriter, request *http.Request, jobID string) {
	jobID = strings.TrimSpace(jobID)
	job, err := handler.service.CancelAccountLogin(request.Context(), jobID)
	if err != nil {
		writeServiceError(response, err, "account_login_cancel_failed")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "job": job.Public()})
}

func decodeBody(response http.ResponseWriter, request *http.Request, maxBytes int64, target any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxBytes))
	if err := decoder.Decode(target); err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_payload"})
		return false
	}
	return true
}

func writeServiceError(response http.ResponseWriter, err error, fallback string) {
	code := fallback
	detail := ""
	var coded *pluginerr.Error
	if errors.As(err, &coded) && coded != nil {
		code = firstNonEmpty(coded.Code, fallback)
		detail = coded.Message
	} else if err != nil {
		detail = err.Error()
	}
	status := http.StatusBadRequest
	switch code {
	case "plugin_runtime_inactive":
		status = http.StatusServiceUnavailable
	case "auth_source_unknown", "account_login_job_not_found":
		status = http.StatusNotFound
	case "auth_source_unavailable", "account_login_submit_unsupported":
		status = http.StatusConflict
	}
	body := map[string]any{"ok": false, "error": code}
	if strings.TrimSpace(detail) != "" {
		body["detail"] = detail
	}
	writeJSON(response, status, body)
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
