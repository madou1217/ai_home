// Package webuiaccountjobsapi 提供账号授权作业的只读快照。
//
// 浏览器原来的作业路径（/v0/webui/accounts/add/jobs/{id}、import/jobs/{id}）与
// /accounts/{provider}/{accountRef}/<action> 在 ServeMux 里同形，无法同时注册；
// 迁移后统一走不冲突的 /v0/webui/account-jobs/{id}。
//
// 返回体对齐 Node 的 serializeAuthJob：活跃作业给出 authMode/authStrategy/账号字段；
// 内存中已清理的终态回落到 oauth_jobs 快照，运行时字段为空并用 recovered=true 标记，
// 与 Node 进程重启后的只读视图同语义。
package webuiaccountjobsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
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

// JobReader 读取作业快照（活跃作业在内存，终态回落持久化）。
type JobReader interface {
	GetJob(ctx context.Context, jobID string) (accountauth.Job, error)
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
	rawJobID := strings.Trim(strings.TrimPrefix(request.URL.Path, Path), "/")
	if rawJobID == "" || strings.Contains(rawJobID, "/") {
		writeError(response, http.StatusNotFound, "job_not_found", "作业不存在")
		return
	}
	jobID, unescapeErr := url.PathUnescape(rawJobID)
	jobID = strings.TrimSpace(jobID)
	if unescapeErr != nil || jobID == "" || strings.Contains(jobID, "/") {
		writeError(response, http.StatusNotFound, "job_not_found", "作业不存在")
		return
	}
	job, err := handler.jobs.GetJob(request.Context(), jobID)
	if errors.Is(err, accountauth.ErrJobNotFound) {
		writeError(response, http.StatusNotFound, "job_not_found", "作业不存在")
		return
	}
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "account_jobs_unavailable", "作业快照读取失败")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":        true,
		"recovered": job.AuthMode() == "",
		"job":       SerializeJob(job),
	})
}

// SerializeJob 把 Job 投影成 Node 的 serializeAuthJob 形状，供快照查询与 SSE 广播复用。
func SerializeJob(job accountauth.Job) map[string]any {
	createdAt := job.CreatedAt().UnixMilli()
	updatedAt := createdAt
	if finished := job.FinishedAt(); !finished.IsZero() {
		updatedAt = finished.UnixMilli()
	}
	var expiresAt any
	if expires := job.ExpiresAt(); !expires.IsZero() {
		expiresAt = expires.UnixMilli()
	}
	accountRef := job.AccountRef().String()
	if accountRef == "" {
		accountRef = job.TargetAccountRef().String()
	}
	authMode := strings.TrimSpace(job.AuthMode())
	recovered := authMode == ""
	rawAuthURL := strings.TrimSpace(job.AuthorizationURL())
	authorizationURL := ""
	verificationURI := ""
	redirectURI := ""
	if authMode == "oauth-device" {
		verificationURI = rawAuthURL
	} else if rawAuthURL != "" {
		authorizationURL = rawAuthURL
		redirectURI = deriveRedirectURI(rawAuthURL)
	}
	var pollIntervalMS any
	if !recovered {
		if authMode == "oauth-device" || authMode == "oauth-refresh-token" {
			pollIntervalMS = 2000
		} else {
			pollIntervalMS = 1000
		}
	}
	account := job.Account()
	return map[string]any{
		"id":                      job.ID(),
		"provider":                job.ProviderID(),
		"accountRef":              accountRef,
		"authMode":                authMode,
		"authStrategy":            job.AuthStrategy(),
		"reauth":                  strings.EqualFold(string(job.Purpose()), "reauth"),
		"status":                  nodeStatus(job.Status()),
		"goStatus":                string(job.Status()),
		"authProgressState":       progressState(job.Status(), authMode, recovered),
		"logs":                    "",
		"exitCode":                nil,
		"error":                   job.FailureCode(),
		"failureCode":             job.FailureCode(),
		"createdAt":               createdAt,
		"updatedAt":               updatedAt,
		"lastOutputAt":            0,
		"pid":                     nil,
		"expiresAt":               expiresAt,
		"pollIntervalMs":          pollIntervalMS,
		"verificationUri":         verificationURI,
		"verificationUriComplete": "",
		"userCode":                job.UserCode(),
		"authorizationUrl":        authorizationURL,
		"redirectUri":             redirectURI,
		"callbackCaptureStatus":   "",
		"callbackListeningUrl":    "",
		"callbackCaptureError":    "",
		"email":                   account.Email,
		"displayName":             account.DisplayName,
		"planType":                account.PlanType,
		"setupPhase":              "",
		"installRequired":         false,
		"installAttempts":         []any{},
	}
}

func nodeStatus(status accountauth.Status) string {
	switch status {
	case accountauth.StatusPending, accountauth.StatusProcessing:
		return "running"
	case accountauth.StatusCompleted:
		return "succeeded"
	case accountauth.StatusFailed:
		return "failed"
	case accountauth.StatusCancelled:
		return "cancelled"
	case accountauth.StatusExpired:
		return "expired"
	default:
		return "running"
	}
}

func progressState(status accountauth.Status, authMode string, recovered bool) string {
	switch status {
	case accountauth.StatusProcessing:
		return "submitted_code"
	case accountauth.StatusCompleted:
		return "completed"
	case accountauth.StatusFailed:
		return "failed"
	case accountauth.StatusCancelled:
		return "cancelled"
	case accountauth.StatusExpired:
		return "expired"
	case accountauth.StatusPending:
		if recovered {
			return ""
		}
		if authMode == "oauth-device" || authMode == "oauth-refresh-token" {
			return "awaiting_code"
		}
		return "auth_url_ready"
	default:
		if recovered {
			return ""
		}
		return "auth_url_ready"
	}
}

func deriveRedirectURI(authorizationURL string) string {
	if authorizationURL == "" {
		return ""
	}
	parsed, err := url.Parse(authorizationURL)
	if err != nil {
		return ""
	}
	query := parsed.Query()
	for _, key := range []string{"redirect_uri", "redirectUri", "redirect"} {
		if value := strings.TrimSpace(query.Get(key)); value != "" {
			return value
		}
	}
	return ""
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
