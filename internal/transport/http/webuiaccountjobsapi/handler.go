// Package webuiaccountjobsapi 提供账号授权作业的只读快照。
//
// 浏览器原来的作业路径（/v0/webui/accounts/add/jobs/{id}、import/jobs/{id}）与
// /accounts/{provider}/{accountRef}/<action> 在 ServeMux 里同形，无法同时注册；
// 迁移后统一走不冲突的 /v0/webui/account-jobs/{id}。
//
// 返回体对齐 Node 的 serializeAuthJob：持久化字段来自 oauth_jobs，运行时字段
// （设备码、回调捕获、日志）在没有内存态时给空值，并用 recovered=true 标记，
// 与 Node 进程重启后的只读视图同语义。
package webuiaccountjobsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/application/accountauth"
)

// Path 是账号授权作业快照的管理前缀。
const Path = "/v1/management/webui/account-jobs"

// ErrInvalidDependencies 表示 Handler 缺少核心依赖。
var ErrInvalidDependencies = errors.New("账号作业快照接口依赖无效")

// Authorizer 校验 Management Key 授权状态。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// JobReader 读取持久化作业快照。
type JobReader interface {
	GetJob(ctx context.Context, jobID string) (accountauth.JobRecord, bool, error)
}

// Dependencies 汇总 Handler 所需依赖。
type Dependencies struct {
	Authorizer Authorizer
	Jobs       JobReader
}

// Handler 处理 /v1/management/webui/account-jobs* 请求。
type Handler struct {
	authorizer Authorizer
	jobs       JobReader
}

// NewHandler 创建并校验处理器。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Jobs == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: dependencies.Authorizer, jobs: dependencies.Jobs}, nil
}

// ServeHTTP 只支持 GET：作业状态是只读视图。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.jobs == nil {
		writeError(response, http.StatusServiceUnavailable, "account_jobs_unavailable", "账号作业快照服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}
	jobID := strings.Trim(strings.TrimPrefix(request.URL.Path, Path), "/")
	if jobID == "" || strings.Contains(jobID, "/") {
		writeError(response, http.StatusNotFound, "job_not_found", "作业不存在")
		return
	}
	record, found, err := handler.jobs.GetJob(request.Context(), jobID)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "account_jobs_unavailable", "作业快照读取失败")
		return
	}
	if !found {
		writeError(response, http.StatusNotFound, "job_not_found", "作业不存在")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":        true,
		"recovered": true,
		"job":       jobView(record),
	})
}

// jobView 把持久化记录投影成 Node 的 serializeAuthJob 形状。
func jobView(record accountauth.JobRecord) map[string]any {
	createdAt := record.CreatedAt.UnixMilli()
	updatedAt := record.UpdatedAt.UnixMilli()
	var expiresAt any
	if !record.ExpiresAt.IsZero() {
		expiresAt = record.ExpiresAt.UnixMilli()
	}
	return map[string]any{
		"id":               record.ID,
		"provider":         record.ProviderID,
		"accountRef":       record.AccountRef,
		"authMode":         "",
		"authStrategy":     "",
		"reauth":           strings.EqualFold(string(record.Purpose), "reauth"),
		"status":           string(record.Status),
		"authProgressState": "",
		"logs":             "",
		"exitCode":         nil,
		"error":            record.ErrorCode,
		"createdAt":        createdAt,
		"updatedAt":        updatedAt,
		"lastOutputAt":     0,
		"pid":              nil,
		"expiresAt":        expiresAt,
		"pollIntervalMs":   nil,
		"verificationUri":  "",
		"verificationUriComplete": "",
		"userCode":         "",
		"authorizationUrl": "",
		"redirectUri":      "",
		"callbackCaptureStatus": "",
		"callbackListeningUrl":  "",
		"callbackCaptureError":  "",
		"email":            "",
		"displayName":      "",
		"planType":         "",
		"setupPhase":       "",
		"installRequired":  false,
		"installAttempts":  []any{},
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, map[string]any{
		"ok":      false,
		"error":   code,
		"message": message,
	})
}
