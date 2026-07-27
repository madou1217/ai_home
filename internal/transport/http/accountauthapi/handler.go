// Package accountauthapi 提供 Codex、Claude OAuth Job 的版本化 HTTP 入站适配器。
package accountauthapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/application/accountauth"
)

const (
	// CollectionPath 是 OAuth Job v1 集合资源的规范路径。
	CollectionPath = "/v1/management/account-auth-jobs"
	callbackAction = "callback"
)

// ErrInvalidDependencies 表示 Handler 缺少 OAuth Job 服务或鉴权策略。
var ErrInvalidDependencies = errors.New("OAuth Job HTTP Handler 依赖无效")

// Jobs 是 HTTP 入站适配器依赖的最小 OAuth Job 应用端口。
type Jobs interface {
	Start(
		ctx context.Context,
		providerID string,
	) (accountauth.StartResult, error)
	Get(jobID string) (accountauth.Job, error)
	Complete(
		ctx context.Context,
		jobID string,
		callback string,
	) (accountauth.Job, error)
	Cancel(jobID string) (accountauth.Job, error)
}

// Authorizer 是 OAuth Job 管理请求的鉴权策略。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 集中声明 OAuth Job HTTP 入站适配器依赖。
type Dependencies struct {
	Jobs       Jobs
	Authorizer Authorizer
}

// Handler 负责鉴权、路由、DTO 和错误映射，不读取数据库或凭据。
type Handler struct {
	jobs       Jobs
	authorizer Authorizer
}

// NewHandler 创建依赖完整且默认失败关闭的 OAuth Job Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Jobs == nil || dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		jobs:       dependencies.Jobs,
		authorizer: dependencies.Authorizer,
	}, nil
}

// ServeHTTP 先完成 Management Key 鉴权，再分发集合和成员资源。
func (handler *Handler) ServeHTTP(
	response http.ResponseWriter,
	request *http.Request,
) {
	if handler == nil ||
		handler.authorizer == nil ||
		!handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeAPIError(
			response,
			http.StatusUnauthorized,
			"unauthorized",
			"需要有效的 Management Key",
		)
		return
	}
	if request.URL.Path == CollectionPath {
		handler.handleCollection(response, request)
		return
	}
	jobID, action, err := parseResourcePath(request.URL.Path)
	if err != nil {
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_job_path",
			"OAuth Job 资源路径无效",
		)
		return
	}
	if action == callbackAction {
		handler.handleCallback(response, request, jobID)
		return
	}
	handler.handleMember(response, request, jobID)
}

// handleCollection 只允许创建新的 OAuth Job。
func (handler *Handler) handleCollection(
	response http.ResponseWriter,
	request *http.Request,
) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeMethodNotAllowed(response)
		return
	}
	if rejectUnexpectedQuery(response, request) {
		return
	}
	var input startJobRequest
	if err := decodeJSONRequest(response, request, &input); err != nil {
		writeRequestDecodeError(response, err)
		return
	}
	result, err := handler.jobs.Start(request.Context(), input.ProviderID)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	writeJSON(response, http.StatusCreated, startJobResponse{
		Data: startJobView{
			jobView:          newJobView(result.Job()),
			AuthorizationURL: result.AuthorizationURL(),
		},
	})
}

// handleMember 分发 Job 查询和取消操作。
func (handler *Handler) handleMember(
	response http.ResponseWriter,
	request *http.Request,
	jobID string,
) {
	if rejectUnexpectedQuery(response, request) {
		return
	}
	switch request.Method {
	case http.MethodGet:
		job, err := handler.jobs.Get(jobID)
		if err != nil {
			writeApplicationError(response, err)
			return
		}
		writeJSON(
			response,
			http.StatusOK,
			jobResponse{Data: newJobView(job)},
		)
	case http.MethodDelete:
		job, err := handler.jobs.Cancel(jobID)
		if err != nil {
			writeApplicationError(response, err)
			return
		}
		writeJSON(
			response,
			http.StatusOK,
			jobResponse{Data: newJobView(job)},
		)
	default:
		response.Header().Set(
			"Allow",
			http.MethodGet+", "+http.MethodDelete,
		)
		writeMethodNotAllowed(response)
	}
}

// handleCallback 唯一消费一次回调并等待账号注册完成。
func (handler *Handler) handleCallback(
	response http.ResponseWriter,
	request *http.Request,
	jobID string,
) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeMethodNotAllowed(response)
		return
	}
	if rejectUnexpectedQuery(response, request) {
		return
	}
	var input callbackRequest
	if err := decodeJSONRequest(response, request, &input); err != nil {
		writeRequestDecodeError(response, err)
		return
	}
	job, err := handler.jobs.Complete(
		request.Context(),
		jobID,
		input.Callback,
	)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	writeJSON(
		response,
		http.StatusOK,
		jobResponse{Data: newJobView(job)},
	)
}

// parseResourcePath 解析精确 Job ID 和可选 callback 子资源。
func parseResourcePath(path string) (string, string, error) {
	prefix := CollectionPath + "/"
	if !strings.HasPrefix(path, prefix) {
		return "", "", errors.New("OAuth Job 路径前缀无效")
	}
	remainder := strings.TrimPrefix(path, prefix)
	segments := strings.Split(remainder, "/")
	if len(segments) < 1 ||
		len(segments) > 2 ||
		!validJobID(segments[0]) {
		return "", "", errors.New("OAuth Job 路径结构无效")
	}
	if len(segments) == 1 {
		return segments[0], "", nil
	}
	if segments[1] != callbackAction {
		return "", "", errors.New("OAuth Job 子资源无效")
	}
	return segments[0], callbackAction, nil
}

// validJobID 要求路径 ID 是规范的 128 位小写十六进制字符串。
func validJobID(jobID string) bool {
	if len(jobID) != 32 || strings.ToLower(jobID) != jobID {
		return false
	}
	for _, character := range jobID {
		if (character < '0' || character > '9') &&
			(character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}

// rejectUnexpectedQuery 让所有 OAuth Job 语义只来自路径和 JSON body。
func rejectUnexpectedQuery(
	response http.ResponseWriter,
	request *http.Request,
) bool {
	if request.URL.RawQuery == "" {
		return false
	}
	writeAPIError(
		response,
		http.StatusBadRequest,
		"invalid_query",
		"请求包含不支持的查询参数",
	)
	return true
}
