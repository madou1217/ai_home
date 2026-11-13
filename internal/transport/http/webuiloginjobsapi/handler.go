// Package webuiloginjobsapi 暴露家族 CLI 登录作业的管理接口。
//
//	POST /v1/management/webui/accounts/login-jobs            {provider} → 202 job
//	GET  /v1/management/webui/accounts/login-jobs/{id}       → 200 job
//	POST /v1/management/webui/accounts/login-jobs/{id}/cancel → 200 job
//
// 作业引擎在 internal/host/aihloginjob；本包只做鉴权、参数校验与 JSON 投影。
package webuiloginjobsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/host/aihloginjob"
)

const (
	// Path 是作业集合路径。
	Path = "/v1/management/webui/accounts/login-jobs"
	// ItemSuffix 是单个作业路径。
	ItemSuffix = "/{jobId}"
	// CancelSuffix 是取消动作路径。
	CancelSuffix = "/{jobId}/cancel"
	// CodeSuffix 是粘贴授权码路径（agy 等 code-paste 登录）。
	CodeSuffix = "/{jobId}/code"
)

// ErrInvalidDependencies 表示 Handler 缺少鉴权或作业端口。
var ErrInvalidDependencies = errors.New("登录作业接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Jobs 是作业引擎的最小端口（aihloginjob.Manager 实现）。
type Jobs interface {
	Start(ctx context.Context, providerID string) (aihloginjob.Snapshot, error)
	Get(id string) (aihloginjob.Snapshot, bool)
	Cancel(id string) bool
	SubmitCode(id string, code string) bool
}

// Dependencies 汇总 Handler 依赖。
type Dependencies struct {
	Authorizer Authorizer
	Jobs       Jobs
}

// Handler 处理登录作业的创建、查询与取消。
type Handler struct {
	authorizer Authorizer
	jobs       Jobs
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Jobs == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: dependencies.Authorizer, jobs: dependencies.Jobs}, nil
}

type jobView struct {
	ID           string `json:"id"`
	Provider     string `json:"provider"`
	Status       string `json:"status"`
	Logs         string `json:"logs"`
	AuthURL      string `json:"authUrl,omitempty"`
	AccountRef   string `json:"accountRef,omitempty"`
	CLIAccountID int64  `json:"cliAccountId,omitempty"`
	Error        string `json:"error,omitempty"`
	StartedAt    string `json:"startedAt"`
	UpdatedAt    string `json:"updatedAt"`
}

type jobResponse struct {
	OK  bool    `json:"ok"`
	Job jobView `json:"job"`
}

type errorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 分发作业集合与单项操作。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.jobs == nil {
		writeError(response, http.StatusServiceUnavailable, "login_jobs_unavailable", "登录作业服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	jobID := strings.TrimSpace(request.PathValue("jobId"))
	switch {
	case request.Method == http.MethodPost && jobID == "":
		handler.startJob(response, request)
	case request.Method == http.MethodGet && jobID != "" && !strings.HasSuffix(request.URL.Path, "/cancel"):
		handler.getJob(response, jobID)
	case request.Method == http.MethodPost && jobID != "" && strings.HasSuffix(request.URL.Path, "/code"):
		handler.submitCode(response, request, jobID)
	case request.Method == http.MethodPost && jobID != "" && strings.HasSuffix(request.URL.Path, "/cancel"):
		if !handler.jobs.Cancel(jobID) {
			writeError(response, http.StatusNotFound, "job_not_found", "")
			return
		}
		handler.getJob(response, jobID)
	default:
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "")
	}
}

func (handler *Handler) startJob(response http.ResponseWriter, request *http.Request) {
	var payload struct {
		Provider string `json:"provider"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(response, request.Body, 64*1024)).Decode(&payload); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_payload", "")
		return
	}
	provider := strings.ToLower(strings.TrimSpace(payload.Provider))
	if provider == "" {
		writeError(response, http.StatusBadRequest, "invalid_payload", "provider 不能为空")
		return
	}
	snapshot, err := handler.jobs.Start(request.Context(), provider)
	if err != nil {
		if errors.Is(err, aihloginjob.ErrInvalidRequest) {
			writeError(response, http.StatusBadRequest, "invalid_payload", "")
			return
		}
		writeError(response, http.StatusInternalServerError, "login_job_start_failed", "")
		return
	}
	writeJSON(response, http.StatusAccepted, jobResponse{OK: true, Job: toJobView(snapshot)})
}

func (handler *Handler) submitCode(response http.ResponseWriter, request *http.Request, jobID string) {
	var payload struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(response, request.Body, 64*1024)).Decode(&payload); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_payload", "")
		return
	}
	if strings.TrimSpace(payload.Code) == "" {
		writeError(response, http.StatusBadRequest, "invalid_payload", "code 不能为空")
		return
	}
	if !handler.jobs.SubmitCode(jobID, payload.Code) {
		writeError(response, http.StatusConflict, "job_not_running", "")
		return
	}
	handler.getJob(response, jobID)
}

func (handler *Handler) getJob(response http.ResponseWriter, jobID string) {
	snapshot, ok := handler.jobs.Get(jobID)
	if !ok {
		writeError(response, http.StatusNotFound, "job_not_found", "")
		return
	}
	writeJSON(response, http.StatusOK, jobResponse{OK: true, Job: toJobView(snapshot)})
}

func toJobView(snapshot aihloginjob.Snapshot) jobView {
	return jobView{
		ID:           snapshot.ID,
		Provider:     snapshot.Provider,
		Status:       string(snapshot.Status),
		Logs:         snapshot.Logs,
		AuthURL:      snapshot.AuthURL,
		AccountRef:   snapshot.AccountRef,
		CLIAccountID: snapshot.CLIAccountID,
		Error:        snapshot.Error,
		StartedAt:    snapshot.StartedAt.UTC().Format(time.RFC3339),
		UpdatedAt:    snapshot.UpdatedAt.UTC().Format(time.RFC3339),
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorResponse{OK: false, Error: code, Message: message})
}
