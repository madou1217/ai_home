// Package webuiaccountaddapi 提供「新增账号」OAuth 作业的 WebUI 管理入口。
//
// 六条路由与 Node 的 webui-account-routes.js 一一对应（浏览器看到的仍是
// /v0/webui/accounts/add*，这里只是 Node 回环调用的内部管理地址）：
//
//	POST /v1/management/webui/account-add
//	GET  /v1/management/webui/account-add/jobs/{jobId}
//	POST /v1/management/webui/account-add/jobs/{jobId}/callback
//	POST /v1/management/webui/account-add/jobs/{jobId}/cancel
//	POST /v1/management/webui/account-add/jobs/{jobId}/local-import
//	POST /v1/management/webui/account-add/jobs/{jobId}/install
//
// 作业引擎复用 application/accountauth（PurposeRegister：没有目标账号 = 注册新账号），
// 本包只做鉴权、DTO 与稳定错误码。PKCE、state、授权码与 Token 都留在应用层内存里，
// 传输层既不读取也不落库。
//
// 与 Node 的边界（刻意保留，不是未完成项）：
//   - loopback 回调捕获：Node 监听 1455/54545 等本地端口，把完整回调原样转发到这里；
//   - 本机登录态导入：来源解析与导入实现住在 Node 的 Provider 运行时（插件、宿主文件、
//     身份探针），Go 的 OAuth Flow 无法转化这些来源，因此 local-import 明确返回 501；
//     Node 桥接层只在「本机没有可用导入来源」时才把新作业交给 Go，本地作业仍由 Node 执行；
//   - CLI 安装确认：Go 的 OAuth Flow 不依赖本地 CLI，install 对 Go 作业恒为
//     install_not_required（与 Node 对不需要安装的作业给出的结论一致）。
package webuiaccountaddapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	accountapp "github.com/madou1217/ai_home/application/accounts"
)

const (
	// Path 是新增账号作业的 WebUI 契约前缀。
	//
	// 刻意不挂在 /accounts/add 下：Go 的 ServeMux 会把
	// GET /accounts/add/jobs/{jobId} 与 GET /accounts/{provider}/{accountRef}/quota-reset-events
	// 判成互不包含的歧义模式（两者都能匹配 /accounts/add/jobs/quota-reset-events）。
	// 独立前缀与 account-activity 的处理一致，浏览器看到的仍是 /v0/webui/accounts/add*。
	Path = "/v1/management/webui/account-add"
	// JobsSuffix 由共享 wiring 拼在 Path 之后，构成单作业资源模式。
	JobsSuffix = "/jobs/{jobId}"
	// CallbackSuffix / CancelSuffix / LocalImportSuffix / InstallSuffix 是作业动作。
	CallbackSuffix    = JobsSuffix + "/callback"
	CancelSuffix      = JobsSuffix + "/cancel"
	LocalImportSuffix = JobsSuffix + "/local-import"
	InstallSuffix     = JobsSuffix + "/install"

	// maxBodyBytes 与 Node 的 readRequestBody({maxBytes: 64 * 1024}) 一致。
	maxBodyBytes = 64 * 1024

	// deriveByGo 标注该响应由 Go 的作业引擎直接产出。
	deriveByGo = "go"

	// progress* 与 Node 的 AUTH_PROGRESS_STATES 逐字对齐。
	progressAuthURLReady  = "auth_url_ready"
	progressAwaitingCode  = "awaiting_code"
	progressSubmittedCode = "submitted_code"
	progressCompleted     = "completed"
	progressFailed        = "failed"
	progressCancelled     = "cancelled"
	progressExpired       = "expired"
)

// ErrInvalidDependencies 表示 Handler 缺少作业服务或鉴权策略。
var ErrInvalidDependencies = errors.New("新增账号作业接口依赖无效")

var (
	// ErrUnsupportedLocalSource 表示作业或 sourceId 不支持从本机导入。
	ErrUnsupportedLocalSource = errors.New("本机登录态来源不受支持")
	// ErrLocalSourceUnavailable 表示本机未发现可用登录态文件或凭据已失效。
	ErrLocalSourceUnavailable = errors.New("本机登录态来源不可用")
)

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Jobs 是新增账号作业需要的最小应用端口。
//
// 端口刻意使用本包的公开视图而不是应用层类型：应用层 Job 没有公开构造函数，
// 传输层测试无法伪造；同时响应字段的取舍只发生在一个适配器里。
type Jobs interface {
	Start(ctx context.Context, request StartRequest) (Started, error)
	GetJob(ctx context.Context, jobID string) (JobSnapshot, error)
	Complete(ctx context.Context, jobID, callback string) (JobSnapshot, error)
	Cancel(jobID string) (JobSnapshot, error)
}

// JobLocalImporter 为等待中的 OAuth 作业执行本机登录态导入并收敛终态。
type JobLocalImporter interface {
	CompleteLocalImport(ctx context.Context, job JobSnapshot, sourceID string) (JobSnapshot, error)
}

// StartRequest 是一次注册型作业的起始命令。
type StartRequest struct {
	ProviderID    string
	AuthStrategy  string
	LoginProvider string
}

// Started 是新建作业的公开结果：授权地址只在创建响应里交付一次。
type Started struct {
	Job              JobSnapshot
	AuthorizationURL string
	UserCode         string
}

// Dependencies 汇总新增账号作业的依赖。
type Dependencies struct {
	Authorizer    Authorizer
	Jobs          Jobs
	LocalImporter JobLocalImporter
}

// Handler 是新增账号 OAuth 作业的 HTTP 入站适配器。
type Handler struct {
	authorizer    Authorizer
	jobs          Jobs
	localImporter JobLocalImporter
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Jobs == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer:    dependencies.Authorizer,
		jobs:          dependencies.Jobs,
		localImporter: dependencies.LocalImporter,
	}, nil
}

// startRequest 是 Node 桥接层传来的新增作业输入。
//
// 只接受 Go 能证明的字段：api-key / vertex / refresh-token / 自定义 authStrategy
// 由 Node 执行，桥接层不会送进来；这里再拒绝一次，避免绕过桥接直接调用时被误解为成功。
type startRequest struct {
	Provider      string `json:"provider"`
	AuthMode      string `json:"authMode"`
	AuthStrategy  string `json:"authStrategy"`
	LoginProvider string `json:"loginProvider"`
}

// callbackRequest 是浏览器回调的提交体，键与 Node 的同名输入一致。
type callbackRequest struct {
	CallbackURL string `json:"callbackUrl"`
}

// localImportRequest 是本机登录态导入的提交体。
type localImportRequest struct {
	SourceID string `json:"sourceId"`
}

// pendingResponse 是新增作业受理后的公开形状。
//
// 键名沿用 Node 的 buildPendingOauthResponse（camelCase），Node 可以只补 tracker 字段
// 就交给前端；Go 没有的 Node 运行态字段（callbackCapture*）不出现在这里，由 Node 自己填。
type pendingResponse struct {
	OK                bool   `json:"ok"`
	Provider          string `json:"provider"`
	AccountRef        string `json:"accountRef"`
	Purpose           string `json:"purpose"`
	AuthMode          string `json:"authMode"`
	AuthStrategy      string `json:"authStrategy"`
	Status            string `json:"status"`
	JobID             string `json:"jobId"`
	AuthorizationURL  string `json:"authorizationUrl"`
	RedirectURI       string `json:"redirectUri"`
	UserCode          string `json:"userCode,omitempty"`
	ExpiresAt         int64  `json:"expiresAt"`
	PollIntervalMS    int    `json:"pollIntervalMs"`
	AuthProgressState string `json:"authProgressState"`
	SetupPhase        string `json:"setupPhase"`
	InstallRequired   bool   `json:"installRequired"`
	DerivedBy         string `json:"derivedBy"`
}

// jobResponse 是查询、回调与取消共享的成功 envelope。
type jobResponse struct {
	OK  bool        `json:"ok"`
	Job JobSnapshot `json:"job"`
}

// JobSnapshot 是作业的公开快照：状态使用 Node 的词汇，goStatus 保留 Go 原始状态。
//
// 不含授权码、state、PKCE 或 Token；AuthorizationURL 只在创建响应交付一次。
type JobSnapshot struct {
	ID                string `json:"id"`
	Provider          string `json:"provider"`
	Purpose           string `json:"purpose"`
	Status            string `json:"status"`
	GoStatus          string `json:"goStatus"`
	AuthMode          string `json:"authMode"`
	AuthStrategy      string `json:"authStrategy,omitempty"`
	AuthProgressState string `json:"authProgressState"`
	AuthorizationURL  string `json:"authorizationUrl,omitempty"`
	RedirectURI       string `json:"redirectUri,omitempty"`
	UserCode          string `json:"userCode,omitempty"`
	AccountRef        string `json:"accountRef,omitempty"`
	CLIAccountID      int64  `json:"cliAccountId,omitempty"`
	FailureCode       string `json:"failureCode,omitempty"`
	Email             string `json:"email,omitempty"`
	DisplayName       string `json:"displayName,omitempty"`
	PlanType          string `json:"planType,omitempty"`
	CreatedAt         int64  `json:"createdAt"`
	UpdatedAt         int64  `json:"updatedAt"`
	FinishedAt        int64  `json:"finishedAt,omitempty"`
	ExpiresAt         int64  `json:"expiresAt,omitempty"`
}

// errorResponse 与 Node 的同名失败形状一致：error 是稳定错误族，code 是具体原因。
type errorResponse struct {
	OK      bool         `json:"ok"`
	Error   string       `json:"error"`
	Code    string       `json:"code,omitempty"`
	Message string       `json:"message,omitempty"`
	Job     *JobSnapshot `json:"job,omitempty"`
}

// ServeHTTP 先完成管理密钥鉴权，再按资源与动作分发。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要有效的 Management Key", nil)
		return
	}
	path := strings.TrimSuffix(request.URL.Path, "/")
	if path == Path {
		handler.handleStart(response, request)
		return
	}
	if !strings.HasPrefix(path, Path+"/jobs/") {
		writeError(response, http.StatusNotFound, "not_found", "路由不存在", nil)
		return
	}
	handler.handleJob(response, request, strings.TrimPrefix(path, Path+"/jobs/"))
}

// handleStart 创建一个注册型 OAuth Job。
func (handler *Handler) handleStart(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 POST", nil)
		return
	}
	payload, err := decodeJSON[startRequest](request)
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_payload", "请求体必须是 JSON", nil)
		return
	}
	provider := strings.ToLower(strings.TrimSpace(payload.Provider))
	if provider == "" {
		writeError(response, http.StatusBadRequest, "invalid_payload", "provider 不能为空", nil)
		return
	}
	authMode := normalizeAuthMode(payload.AuthMode)
	if authMode == "" {
		writeError(response, http.StatusBadRequest, "unsupported_auth_mode", "Go 只承接 OAuth 登录与 Kiro refresh_token 导入作业", nil)
		return
	}
	if authMode == "oauth-refresh-token" && provider != "kiro" {
		writeError(response, http.StatusBadRequest, "unsupported_auth_mode", "仅 Kiro 支持 refresh_token 导入模式", nil)
		return
	}
	if provider == "gemini" && authMode == "oauth-browser" {
		writeError(response, http.StatusBadRequest, "gemini_google_oauth_disabled", "Google 登录已关闭：Gemini Code Assist 个人版已停用，请改用 Gemini API Key 或 Antigravity。", nil)
		return
	}
	strategy, loginProvider, errCode, errMessage := resolveStartOptions(provider, authMode, payload.AuthStrategy, payload.LoginProvider)
	if errCode != "" {
		writeError(response, http.StatusBadRequest, errCode, errMessage, nil)
		return
	}

	started, err := handler.jobs.Start(request.Context(), StartRequest{
		ProviderID:    provider,
		AuthStrategy:  strategy,
		LoginProvider: loginProvider,
	})
	if err != nil {
		writeStartError(response, err)
		return
	}
	job := started.Job
	if job.AuthMode != authMode {
		// 请求的形态与 Go 实际流程不一致时立刻释放刚创建的 Job，避免占住 Provider 名额。
		_, _ = handler.jobs.Cancel(job.ID)
		writeError(response, http.StatusBadRequest, "unsupported_auth_mode", "Go 的登录流程与请求的认证方式不一致", nil)
		return
	}
	resolvedStrategy := strings.TrimSpace(job.AuthStrategy)
	if resolvedStrategy == "" {
		resolvedStrategy = strategy
	}
	job.AuthorizationURL = started.AuthorizationURL
	job.UserCode = started.UserCode
	job.RedirectURI = deriveRedirectURI(started.AuthorizationURL)
	writeJSON(response, http.StatusOK, pendingResponse{
		OK:                true,
		Provider:          job.Provider,
		AccountRef:        job.AccountRef,
		Purpose:           job.Purpose,
		AuthMode:          job.AuthMode,
		AuthStrategy:      resolvedStrategy,
		Status:            "pending",
		JobID:             job.ID,
		AuthorizationURL:  job.AuthorizationURL,
		RedirectURI:       job.RedirectURI,
		UserCode:          job.UserCode,
		ExpiresAt:         job.ExpiresAt,
		PollIntervalMS:    pollInterval(job.AuthMode),
		AuthProgressState: job.AuthProgressState,
		SetupPhase:        "",
		InstallRequired:   false,
		DerivedBy:         deriveByGo,
	})
}

// handleJob 分派单个作业的查询与动作。
func (handler *Handler) handleJob(response http.ResponseWriter, request *http.Request, rest string) {
	segments := strings.Split(strings.Trim(rest, "/"), "/")
	jobID := strings.TrimSpace(segments[0])
	if jobID == "" || len(segments) > 2 {
		writeError(response, http.StatusNotFound, "job_not_found", "OAuth Job 不存在", nil)
		return
	}
	action := ""
	if len(segments) == 2 {
		action = segments[1]
	}
	switch action {
	case "":
		handler.handleGet(response, request, jobID)
	case "callback":
		handler.handleCallback(response, request, jobID)
	case "cancel":
		handler.handleCancel(response, request, jobID)
	case "local-import":
		handler.handleLocalImport(response, request, jobID)
	case "install":
		handler.handleInstall(response, request, jobID)
	default:
		writeError(response, http.StatusNotFound, "not_found", "路由不存在", nil)
	}
}

// handleGet 返回作业快照；内存终态被清理时由适配器回落持久化记录。
func (handler *Handler) handleGet(response http.ResponseWriter, request *http.Request, jobID string) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 GET", nil)
		return
	}
	job, err := handler.jobs.GetJob(request.Context(), jobID)
	if err != nil {
		writeLookupError(response, err, nil)
		return
	}
	writeJSON(response, http.StatusOK, jobResponse{OK: true, Job: job})
}

// handleCallback 把浏览器回调交给应用层完成换码与账号写入。
func (handler *Handler) handleCallback(response http.ResponseWriter, request *http.Request, jobID string) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 POST", nil)
		return
	}
	payload, err := decodeJSON[callbackRequest](request)
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_callback_url", "请求体必须是 JSON", nil)
		return
	}
	callbackURL := strings.TrimSpace(payload.CallbackURL)
	if callbackURL == "" {
		writeError(response, http.StatusBadRequest, "invalid_callback_url", "callbackUrl 不能为空", nil)
		return
	}
	job, err := handler.jobs.Complete(request.Context(), jobID, callbackURL)
	if err != nil {
		var view *JobSnapshot
		if current, lookupErr := handler.jobs.GetJob(request.Context(), jobID); lookupErr == nil {
			view = &current
		}
		writeCallbackError(response, err, view)
		return
	}
	writeJSON(response, http.StatusOK, jobResponse{OK: true, Job: job})
}

// handleCancel 取消等待中的作业；已消失的作业按 Node 的语义收尾为 cancelled。
func (handler *Handler) handleCancel(response http.ResponseWriter, request *http.Request, jobID string) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 POST", nil)
		return
	}
	job, err := handler.jobs.Cancel(jobID)
	if err == nil {
		writeJSON(response, http.StatusOK, jobResponse{OK: true, Job: job})
		return
	}
	if errors.Is(err, accountauth.ErrJobNotFound) {
		// 与 Node 的本地 cancelJob 对齐：作业已结束或已被清理也返回成功，
		// 前端可以据此关闭进度弹窗，而不是卡在 running。
		writeJSON(response, http.StatusOK, jobResponse{OK: true, Job: JobSnapshot{
			ID: jobID, Status: "cancelled", GoStatus: string(accountauth.StatusCancelled),
			AuthProgressState: progressCancelled,
			FailureCode:       "job_not_found",
		}})
		return
	}
	// Node 的 cancelJob 对「已不在运行」的作业直接返回 ok + 快照；这里保持同一结论。
	if errors.Is(err, accountauth.ErrJobNotPending) || errors.Is(err, accountauth.ErrJobExpired) {
		writeJSON(response, http.StatusOK, jobResponse{OK: true, Job: job})
		return
	}
	writeCallbackError(response, err, nil)
}

// handleLocalImport 说明 Go 作业没有本机导入实现，由 Node 对本地作业执行。
func (handler *Handler) handleLocalImport(response http.ResponseWriter, request *http.Request, jobID string) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 POST", nil)
		return
	}
	payload, err := decodeJSON[localImportRequest](request)
	if err != nil || strings.TrimSpace(payload.SourceID) == "" {
		writeError(response, http.StatusBadRequest, "missing_source_id", "sourceId 不能为空", nil)
		return
	}
	sourceID := strings.TrimSpace(payload.SourceID)
	job, lookupErr := handler.jobs.GetJob(request.Context(), jobID)
	if lookupErr != nil {
		writeLookupError(response, lookupErr, nil)
		return
	}
	if handler.localImporter == nil {
		writeError(
			response,
			http.StatusNotImplemented,
			"local_import_unsupported",
			"未装配本机登录态导入端口，暂不支持对 Go 作业执行本机导入。",
			&job,
		)
		return
	}
	if job.Status != "running" {
		writeError(response, http.StatusConflict, "job_not_pending", "OAuth Job 已被处理或结束", &job)
		return
	}
	completed, importErr := handler.localImporter.CompleteLocalImport(request.Context(), job, sourceID)
	if importErr != nil {
		latest := &job
		if current, getErr := handler.jobs.GetJob(request.Context(), jobID); getErr == nil {
			latest = &current
		}
		switch {
		case errors.Is(importErr, ErrUnsupportedLocalSource):
			writeError(response, http.StatusBadRequest, "unsupported_auth_source", "该本机登录态来源不受支持", latest)
		case errors.Is(importErr, ErrLocalSourceUnavailable):
			writeJSON(response, http.StatusConflict, errorResponse{
				OK:      false,
				Error:   "auth_source_unavailable",
				Code:    "auth_source_unavailable:" + sourceID,
				Message: "未检测到可用的本机登录态，请确认客户端已登录。",
				Job:     latest,
			})
		default:
			writeCallbackError(response, importErr, latest)
		}
		return
	}
	writeJSON(response, http.StatusOK, jobResponse{OK: true, Job: completed})
}

// handleInstall 明确 Go 作业不需要 CLI 安装确认。
func (handler *Handler) handleInstall(response http.ResponseWriter, request *http.Request, jobID string) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 POST", nil)
		return
	}
	job, lookupErr := handler.jobs.GetJob(request.Context(), jobID)
	if lookupErr != nil {
		writeLookupError(response, lookupErr, nil)
		return
	}
	writeError(response, http.StatusBadRequest, "install_not_required", "该登录任务不需要安装本地 CLI。", &job)
}

// NewJobView 把应用层快照翻译成 Node 词汇的公开视图。
func NewJobView(job accountauth.Job) JobSnapshot {
	account := job.Account()
	return JobSnapshot{
		ID:                job.ID(),
		Provider:          job.ProviderID(),
		Purpose:           string(job.Purpose()),
		Status:            NodeStatus(job.Status()),
		GoStatus:          string(job.Status()),
		AuthMode:          job.AuthMode(),
		AuthStrategy:      job.AuthStrategy(),
		AuthProgressState: progressState(job.Status(), job.AuthMode()),
		AccountRef:        job.AccountRef().String(),
		CLIAccountID:      job.CLIAccountID().Int64(),
		FailureCode:       job.FailureCode(),
		Email:             account.Email,
		DisplayName:       account.DisplayName,
		PlanType:          account.PlanType,
		CreatedAt:         Millis(job.CreatedAt()),
		UpdatedAt:         Millis(job.FinishedAt()),
		FinishedAt:        Millis(job.FinishedAt()),
		ExpiresAt:         Millis(job.ExpiresAt()),
	}
}

// NodeStatus 把 Go 的作业状态翻译成 Node 公开状态。
func NodeStatus(status accountauth.Status) string {
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

// progressState 与 Node 的 resolveProgressState 逐项对齐。
func progressState(status accountauth.Status, authMode string) string {
	switch status {
	case accountauth.StatusProcessing:
		return progressSubmittedCode
	case accountauth.StatusCompleted:
		return progressCompleted
	case accountauth.StatusFailed:
		return progressFailed
	case accountauth.StatusCancelled:
		return progressCancelled
	case accountauth.StatusExpired:
		return progressExpired
	case accountauth.StatusPending:
		if authMode == "oauth-device" || authMode == "oauth-refresh-token" {
			return progressAwaitingCode
		}
		return progressAuthURLReady
	default:
		return progressAuthURLReady
	}
}

// pollInterval 与 Node 的展示间隔一致：浏览器回调用 1s，设备码用 2s。
func pollInterval(authMode string) int {
	if authMode == "oauth-device" {
		return 2000
	}
	return 1000
}

// deriveRedirectURI 从授权地址里取回调地址；Node 用同一个参数驱动 loopback 捕获。
func deriveRedirectURI(authorizationURL string) string {
	raw := strings.TrimSpace(authorizationURL)
	if raw == "" {
		return ""
	}
	parsed, err := url.Parse(raw)
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

// normalizeLoginProvider 把「默认登录方式」的别名归一成空串。
//
// WebUI 对 kiro 的 Builder ID 发的是 builder-id；Go 的作业只描述协议（Builder ID =
// 默认 OIDC），不记录这个展示值。认不出的值原样返回，交给调用方拒绝。
func normalizeLoginProvider(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "builder-id", "builderid", "builder", "aws-builder-id", "awsbuilderid", "idc":
		return ""
	default:
		return strings.TrimSpace(raw)
	}
}

// resolveStartOptions 按 Provider 校验并归一 authStrategy / loginProvider。
func resolveStartOptions(provider, authMode, rawStrategy, rawLoginProvider string) (string, string, string, string) {
	strategy := strings.TrimSpace(rawStrategy)
	lowerStrategy := strings.ToLower(strategy)
	loginProvider := strings.TrimSpace(rawLoginProvider)

	switch provider {
	case "agy":
		if strategy != "" && strategy != "aih-google-oauth" {
			return "", "", "unsupported_auth_strategy", "Go 只承接直连 Google 登录策略"
		}
		if normalizeLoginProvider(loginProvider) != "" {
			return "", "", "unsupported_login_provider", "Antigravity 不支持该登录提供方"
		}
		return strategy, "", "", ""
	case "zcode":
		switch lowerStrategy {
		case "", "zai", "zai:custom-scheme", "zai:cli-flow", "bigmodel", "bigmodel:custom-scheme", "bigmodel:cli-flow":
		default:
			return "", "", "unsupported_auth_strategy", "不支持的 ZCode 登录策略"
		}
		if normalizeLoginProvider(loginProvider) != "" {
			return "", "", "unsupported_login_provider", "ZCode 不支持该登录提供方"
		}
		return lowerStrategy, "", "", ""
	case "opencode":
		if lowerStrategy != "" && lowerStrategy != "opencode:device" {
			return "", "", "unsupported_auth_strategy", "不支持的 OpenCode 登录策略"
		}
		if normalizeLoginProvider(loginProvider) != "" {
			return "", "", "unsupported_login_provider", "OpenCode 不支持该登录提供方"
		}
		return lowerStrategy, "", "", ""
	case "kiro":
		normLogin, isBuilderID, ok := normalizeKiroLoginProvider(loginProvider)
		if !ok {
			return "", "", "unsupported_login_provider", "不支持的 Kiro 登录提供方"
		}
		if authMode == "oauth-refresh-token" {
			if lowerStrategy != "" && lowerStrategy != "oauth-refresh-token" {
				return "", "", "unsupported_auth_strategy", "refresh_token 模式不支持自定义策略"
			}
			return "oauth-refresh-token", normLogin, "", ""
		}
		switch lowerStrategy {
		case "", "oauth-device", "builder-id", "social", "social-oauth-device":
		default:
			return "", "", "unsupported_auth_strategy", "不支持的 Kiro 登录策略"
		}
		if isBuilderID && (lowerStrategy == "social" || lowerStrategy == "social-oauth-device") {
			return "", "", "unsupported_login_provider", "social 登录需要选择 Google 或 GitHub"
		}
		return lowerStrategy, normLogin, "", ""
	default:
		if strategy != "" {
			return "", "", "unsupported_auth_strategy", "Go 只承接默认 OAuth 策略"
		}
		if normalizeLoginProvider(loginProvider) != "" {
			return "", "", "unsupported_login_provider", "Go 只承接默认登录方式"
		}
		return "", "", "", ""
	}
}

func normalizeKiroLoginProvider(raw string) (normalized string, isBuilderID bool, ok bool) {
	if normalizeLoginProvider(raw) == "" {
		return "", true, true
	}
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "google":
		return "Google", false, true
	case "github":
		return "Github", false, true
	default:
		return "", false, false
	}
}

// normalizeAuthMode 只接受 Go 承接的交互/粘贴认证形态；其它返回空串。
func normalizeAuthMode(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "", "oauth-browser", "browser":
		return "oauth-browser"
	case "oauth-device", "device", "device-code":
		return "oauth-device"
	case "oauth-refresh-token", "refresh-token", "oauth_refresh_token":
		return "oauth-refresh-token"
	default:
		return ""
	}
}

// Millis 输出 Node 侧使用的毫秒时间戳；零值输出 0。
func Millis(value time.Time) int64 {
	if value.IsZero() {
		return 0
	}
	return value.UTC().UnixMilli()
}

// decodeJSON 读取受限请求体并解析为 T。
func decodeJSON[T any](request *http.Request) (T, error) {
	var value T
	body, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes))
	if err != nil {
		return value, err
	}
	if len(strings.TrimSpace(string(body))) == 0 {
		return value, nil
	}
	if err := json.Unmarshal(body, &value); err != nil {
		return value, err
	}
	return value, nil
}

// writeStartError 映射创建作业的失败。
func writeStartError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, accountauth.ErrUnsupportedProvider):
		writeError(response, http.StatusBadRequest, "unsupported_provider", "Go 尚未承接该 Provider 的 OAuth 登录", nil)
	case errors.Is(err, accountauth.ErrActiveJobExists):
		writeError(response, http.StatusConflict, "oauth_job_already_running", "该 Provider 已有进行中的登录任务", nil)
	case errors.Is(err, accountauth.ErrJobCapacity):
		writeError(response, http.StatusServiceUnavailable, "job_capacity_exhausted", "登录任务服务暂时繁忙", nil)
	case errors.Is(err, accountauth.ErrUnsupportedAuthStrategy):
		writeError(response, http.StatusBadRequest, "unsupported_auth_strategy", "不支持的 OAuth 登录策略", nil)
	case errors.Is(err, accountauth.ErrUnsupportedLoginProvider):
		writeError(response, http.StatusBadRequest, "unsupported_login_provider", "不支持的上游登录提供方", nil)
	case errors.Is(err, accountauth.ErrInvalidStartRequest):
		writeError(response, http.StatusBadRequest, "invalid_request", "登录任务请求无效", nil)
	case errors.Is(err, accountauth.ErrProviderUnavailable):
		writeError(response, http.StatusBadGateway, "provider_unavailable", "OAuth Provider 暂时不可用", nil)
	case errors.Is(err, accountauth.ErrProviderRejected):
		writeError(response, http.StatusBadGateway, "provider_rejected", "OAuth Provider 拒绝授权", nil)
	default:
		writeError(response, http.StatusInternalServerError, "internal_error", "登录任务服务内部错误", nil)
	}
}

// writeCallbackError 映射完成回调的失败。
func writeCallbackError(response http.ResponseWriter, err error, job *JobSnapshot) {
	switch {
	case errors.Is(err, accountauth.ErrJobNotFound):
		writeError(response, http.StatusNotFound, "job_not_found", "OAuth Job 不存在", job)
	case errors.Is(err, accountauth.ErrJobExpired):
		writeError(response, http.StatusGone, "job_expired", "OAuth Job 已过期", job)
	case errors.Is(err, accountauth.ErrJobNotPending):
		writeError(response, http.StatusConflict, "job_not_pending", "OAuth Job 已被处理或结束", job)
	case errors.Is(err, accountauth.ErrInvalidCallback):
		writeError(response, http.StatusBadRequest, "invalid_callback", "OAuth 回调格式无效", job)
	case errors.Is(err, accountauth.ErrStateMismatch):
		writeError(response, http.StatusBadRequest, "state_mismatch", "OAuth 回调与当前 Job 不匹配", job)
	case errors.Is(err, accountauth.ErrProviderRejected):
		writeError(response, http.StatusBadGateway, "provider_rejected", "OAuth Provider 拒绝授权", job)
	case errors.Is(err, accountauth.ErrProviderUnavailable):
		writeError(response, http.StatusBadGateway, "provider_unavailable", "OAuth Provider 暂时不可用", job)
	case errors.Is(err, accountauth.ErrInvalidArtifacts):
		writeError(response, http.StatusInternalServerError, "invalid_artifacts", "OAuth 官方 artifact 无效", job)
	case errors.Is(err, accountapp.ErrAccountConflict):
		writeError(response, http.StatusConflict, "account_conflict", "该 Provider 账号已经存在", job)
	case errors.Is(err, accountapp.ErrCLIAccountIDExhausted):
		writeError(response, http.StatusConflict, "cli_account_id_exhausted", "Provider 数字别名已经耗尽", job)
	default:
		writeError(response, http.StatusInternalServerError, "internal_error", "登录任务服务内部错误", job)
	}
}

// writeLookupError 映射查询失败。
func writeLookupError(response http.ResponseWriter, err error, job *JobSnapshot) {
	if errors.Is(err, accountauth.ErrJobNotFound) {
		writeError(response, http.StatusNotFound, "job_not_found", "OAuth Job 不存在", job)
		return
	}
	writeError(response, http.StatusInternalServerError, "internal_error", "登录任务服务内部错误", job)
}

// writeError 输出与 Node 同形的失败 envelope。
func writeError(response http.ResponseWriter, status int, code, message string, job *JobSnapshot) {
	writeJSON(response, status, errorResponse{
		OK: false, Error: code, Code: code, Message: message, Job: job,
	})
}

// writeJSON 输出 no-store JSON 响应。
func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}
