// Package webuiaccountreauthapi 提供「对已有账号按原方式重新认证」的 WebUI 写入口。
//
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/reauth
//
// 本包只做路径校验、账号归属确认、作业幂等与错误映射：OAuth 作业由
// application/accountauth 的 Service 创建，传输层不接触授权码、PKCE 或 Token。
//
// 与 Node 的边界：Node 的 handleReauthAccountRequest 还会推断 authMode、检查
// 运行中的会话与原生进程、写 account_state 投影；这些仍归 Node。本切片只返回
// Go 能证明的字段，其余键在 unfilledFields 中显式列出，避免调用方把部分形状
// 当成 Node 全量响应。
package webuiaccountreauthapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	accountauth "github.com/madou1217/ai_home/application/accountauth"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// Path 是账号管理 WebUI 契约前缀。
	Path = "/v1/management/webui/accounts"
	// ReauthSuffix 由共享 wiring 拼在 Path 之后，构成管理路由模式。
	//
	//	POST /v1/management/webui/accounts/{provider}/{accountRef}/reauth
	ReauthSuffix = "/{provider}/{accountRef}/reauth"

	// derivedByGo 标注响应只包含 Go 能证明的字段。
	derivedByGo = "go"
)

// ErrInvalidDependencies 表示 Handler 缺少鉴权策略或账号读端口。
var ErrInvalidDependencies = errors.New("账号重新认证接口依赖无效")

// unfilledFields 是 Node 的 reauth 响应有、而本切片没有可信来源的键。
//
// authMode / authStrategy 由 Node 按账号状态推断；其余是 Node 侧回调捕获与
// CLI 安装流程的运行态。Go 不伪造这些值。
var unfilledFields = []string{
	"authMode",
	"authStrategy",
	"pollIntervalMs",
	"redirectUri",
	"callbackCaptureStatus",
	"callbackListeningUrl",
	"callbackCaptureError",
	"authProgressState",
	"setupPhase",
	"installRequired",
}

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// AccountDirectory 提供账号归属校验，避免路径里的 provider 与真实账号不一致时
// 仍然对一个不属于该 Provider 的账号发起重新认证。
//
// 该接口由 *sqliteaccount.Store 满足，与账号编辑切片共用同一份读端口。
type AccountDirectory interface {
	GetAccountOverview(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountapp.AccountOverview, error)
}

// Request 是一次重新认证作业的起始命令。账号引用必填，表示原地重新认证。
type Request struct {
	ProviderID string
	AccountRef accountcore.AccountRef
}

// Job 是一次作业的公开快照，只含传输层需要的字段。
//
// AuthorizationURL 是只在创建响应里交付的一次性授权地址；UserCode 只对设备码
// 流程非空。两者都不是凭据，也不参与换码。
type Job struct {
	ID               string
	ProviderID       string
	Purpose          string
	Status           string
	AuthorizationURL string
	UserCode         string
	ExpiresAt        time.Time
}

// JobStarter 创建一次 OAuth 作业。
//
// 端口刻意使用本包的最小形状而不是应用层类型：应用层 Job 没有公开构造函数，
// 传输层测试无法伪造；同时也能保证响应字段的取舍只发生在一个适配器里。
type JobStarter interface {
	Start(ctx context.Context, request Request) (Job, error)
}

// JobReader 是可选的作业读端口，与 JobStarter 由同一个适配器实现。
//
// 它用来确认「本 Handler 记录的那次作业」是否仍在进行：只有仍然活动时才把重复
// 请求收敛到同一个作业，已经进入终态就重新起一次。
type JobReader interface {
	Active(jobID string) (bool, error)
}

// Dependencies 汇总重新认证的依赖。
//
// Jobs 为 nil 时路由仍可装配，但请求返回 501 reauth_unavailable；这样 Node 侧
// 登录流程尚未接入 Go 时不会阻塞整个管理面启动。
type Dependencies struct {
	Authorizer Authorizer
	// AIHomeDir 是 AI Home 根目录；本切片只做作业编排，不读磁盘状态。
	AIHomeDir string
	Accounts  AccountDirectory
	Jobs      JobStarter
}

// activeJob 记录本 Handler 起过、且可能仍在进行中的作业。
//
// 只保存公开快照：Job ID、目标账号、响应体和过期时刻。它不是作业真相源
// （真相源是 accountauth.Service），只用于把重复点击收敛到同一个作业。
type activeJob struct {
	jobID      string
	accountRef accountcore.AccountRef
	expiresAt  time.Time
	response   successResponse
}

// isExpired 判断记录的作业是否已经超过授权窗口。
func (job activeJob) isExpired(now time.Time) bool {
	return !job.expiresAt.IsZero() && !now.Before(job.expiresAt)
}

// Handler 是账号重新认证的 HTTP 入站适配器。
type Handler struct {
	authorizer Authorizer
	aiHomeDir  string
	accounts   AccountDirectory
	jobs       JobStarter

	mu     sync.Mutex
	active map[string]activeJob
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Accounts == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		aiHomeDir:  strings.TrimSpace(dependencies.AIHomeDir),
		accounts:   dependencies.Accounts,
		jobs:       dependencies.Jobs,
		active:     make(map[string]activeJob),
	}, nil
}

// successResponse 是一次重新认证受理的公开形状。
//
// 字段名沿用 Node 的 buildPendingOauthResponse（camelCase），只保留 Go 能证明的键；
// Node 独有的键列在 unfilledFields。
type successResponse struct {
	OK               bool   `json:"ok"`
	Provider         string `json:"provider"`
	AccountRef       string `json:"accountRef"`
	AccountLabel     string `json:"accountLabel"`
	Purpose          string `json:"purpose"`
	Status           string `json:"status"`
	JobID            string `json:"jobId"`
	AuthorizationURL string `json:"authorizationUrl"`
	// UserCode 只对设备码流程非空：用户在验证页核对的短码，不是凭据。
	UserCode       string   `json:"userCode,omitempty"`
	ExpiresAtMS    int64    `json:"expiresAt"`
	AlreadyRunning bool     `json:"alreadyRunning"`
	DerivedBy      string   `json:"derivedBy"`
	Partial        bool     `json:"partial"`
	UnfilledFields []string `json:"unfilledFields"`
}

// errorView 与 Node 的 reauth 失败响应同名：error 是稳定错误族，code 是具体原因。
type errorView struct {
	OK         bool   `json:"ok"`
	Error      string `json:"error"`
	Code       string `json:"code,omitempty"`
	Message    string `json:"message,omitempty"`
	JobID      string `json:"jobId,omitempty"`
	AccountRef string `json:"accountRef,omitempty"`
}

// failure 是已经收敛好的错误响应。
type failure struct {
	status int
	body   errorView
}

// ServeHTTP 只接受 POST，并把重新认证意图交给 OAuth 作业服务。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.accounts == nil {
		writeFailure(response, failure{
			status: http.StatusServiceUnavailable,
			body:   errorView{Error: "reauth_unavailable", Message: "重新认证服务不可用"},
		})
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeFailure(response, failure{
			status: http.StatusUnauthorized,
			body:   errorView{Error: "unauthorized", Message: "需要管理密钥"},
		})
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeFailure(response, failure{
			status: http.StatusMethodNotAllowed,
			body:   errorView{Error: "method_not_allowed", Message: "仅支持 POST"},
		})
		return
	}
	// 作业端口未装配时明确失败：不伪造一个只有 Go 自己知道的本地作业。
	if handler.jobs == nil {
		writeFailure(response, failure{
			status: http.StatusNotImplemented,
			body:   errorView{Error: "reauth_unavailable", Message: "重新认证作业服务未装配"},
		})
		return
	}

	provider := strings.ToLower(strings.TrimSpace(request.PathValue("provider")))
	accountRef, refErr := accountcore.ParseAccountRef(
		strings.TrimSpace(request.PathValue("accountRef")),
	)
	if !validProviderToken(provider) || refErr != nil {
		writeFailure(response, failure{
			status: http.StatusBadRequest,
			body:   errorView{Error: "invalid_account_path", Message: "无效的账号路径"},
		})
		return
	}

	overview, err := handler.accounts.GetAccountOverview(request.Context(), accountRef)
	if err != nil {
		writeFailure(response, accountLookupFailure(err))
		return
	}
	// provider 与账号不一致按「不存在」处理：Node 的 accountExists 也是按
	// (provider, accountRef) 成对查找，不区分「账号在别的 Provider」。
	if overview.Account().ProviderID() != provider {
		writeFailure(response, failure{
			status: http.StatusNotFound,
			body:   errorView{Error: "account_not_found", Message: "账号不存在"},
		})
		return
	}

	result, startFailure := handler.startReauth(request.Context(), provider, overview)
	if startFailure != nil {
		writeFailure(response, *startFailure)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

// startReauth 发起作业；重复请求收敛到同一个进行中的作业。
func (handler *Handler) startReauth(
	ctx context.Context,
	provider string,
	overview accountapp.AccountOverview,
) (successResponse, *failure) {
	accountRef := overview.Account().Ref()
	result, err := handler.jobs.Start(ctx, Request{
		ProviderID: provider,
		AccountRef: accountRef,
	})
	if err == nil {
		response := newSuccessResponse(provider, overview, result)
		handler.remember(provider, accountRef, response, result.ExpiresAt)
		return response, nil
	}
	if !errors.Is(err, accountauth.ErrActiveJobExists) {
		mapped := mapStartFailure(err)
		return successResponse{}, &mapped
	}
	// 同一 Provider 已有进行中的作业：如果是本 Handler 起的那一次，直接返回它，
	// 让重复点击拿到同一个 Job ID 而不是第二次 OAuth 流程。
	if replayed, ok := handler.replay(provider, accountRef); ok {
		return replayed, nil
	}
	body := errorView{
		Error:   "reauth_account_failed",
		Code:    "oauth_job_already_running",
		Message: "该 Provider 已有进行中的登录作业",
	}
	if entry, found := handler.activeEntry(provider); found {
		body.JobID = entry.jobID
		body.AccountRef = entry.accountRef.String()
	}
	return successResponse{}, &failure{status: http.StatusConflict, body: body}
}

// replay 返回仍在进行中的同一个作业；目标账号不同或作业已终态时返回 false。
func (handler *Handler) replay(
	provider string,
	accountRef accountcore.AccountRef,
) (successResponse, bool) {
	entry, found := handler.activeEntry(provider)
	if !found || entry.accountRef != accountRef {
		return successResponse{}, false
	}
	// 有读端口时以作业真相为准，避免把已经完成的作业当成「仍在进行」。
	if reader, ok := handler.jobs.(JobReader); ok {
		active, err := reader.Active(entry.jobID)
		if err != nil || !active {
			handler.forget(provider, entry.jobID)
			return successResponse{}, false
		}
	}
	entry.response.AlreadyRunning = true
	return entry.response, true
}

// activeEntry 读取未过期的记录。
func (handler *Handler) activeEntry(provider string) (activeJob, bool) {
	handler.mu.Lock()
	defer handler.mu.Unlock()
	entry, found := handler.active[provider]
	if !found || entry.isExpired(time.Now()) {
		return activeJob{}, false
	}
	return entry, true
}

// remember 记录刚起的作业，并顺手清掉已过期的记录（Job 上限由应用层控制）。
func (handler *Handler) remember(
	provider string,
	accountRef accountcore.AccountRef,
	response successResponse,
	expiresAt time.Time,
) {
	handler.mu.Lock()
	defer handler.mu.Unlock()
	now := time.Now()
	for key, entry := range handler.active {
		if entry.isExpired(now) {
			delete(handler.active, key)
		}
	}
	handler.active[provider] = activeJob{
		jobID:      response.JobID,
		accountRef: accountRef,
		expiresAt:  expiresAt,
		response:   response,
	}
}

// forget 只删除仍然指向同一个 Job 的记录，避免并发下抹掉更新的作业。
func (handler *Handler) forget(provider string, jobID string) {
	handler.mu.Lock()
	defer handler.mu.Unlock()
	if entry, found := handler.active[provider]; found && entry.jobID == jobID {
		delete(handler.active, provider)
	}
}

// newSuccessResponse 把作业快照翻译成 WebUI 响应。
func newSuccessResponse(
	provider string,
	overview accountapp.AccountOverview,
	job Job,
) successResponse {
	accountRef := overview.Account().Ref()
	return successResponse{
		OK:               true,
		Provider:         provider,
		AccountRef:       accountRef.String(),
		AccountLabel:     accountLabel(overview),
		Purpose:          job.Purpose,
		Status:           job.Status,
		JobID:            job.ID,
		AuthorizationURL: job.AuthorizationURL,
		UserCode:         job.UserCode,
		ExpiresAtMS:      job.ExpiresAt.UnixMilli(),
		AlreadyRunning:   false,
		DerivedBy:        derivedByGo,
		Partial:          true,
		UnfilledFields:   append([]string(nil), unfilledFields...),
	}
}

// accountLabel 与 Node 的 accountLabel 同口径：展示名 > 邮箱 > 账号引用。
func accountLabel(overview accountapp.AccountOverview) string {
	for _, candidate := range []string{overview.DisplayName(), overview.Email()} {
		if trimmed := strings.TrimSpace(candidate); trimmed != "" {
			return trimmed
		}
	}
	return overview.Account().Ref().String()
}

// accountLookupFailure 把账号读错误收敛成稳定响应。
func accountLookupFailure(err error) failure {
	if errors.Is(err, accountapp.ErrAccountNotFound) {
		return failure{
			status: http.StatusNotFound,
			body:   errorView{Error: "account_not_found", Message: "账号不存在"},
		}
	}
	return failure{
		status: http.StatusServiceUnavailable,
		body:   errorView{Error: "reauth_account_lookup_failed", Message: "账号读取失败"},
	}
}

// mapStartFailure 把应用层作业错误映射成 WebUI 错误码，不泄漏内部细节。
func mapStartFailure(err error) failure {
	switch {
	case errors.Is(err, accountauth.ErrUnsupportedProvider):
		return failure{
			status: http.StatusBadRequest,
			body: errorView{
				Error:   "reauth_unsupported",
				Code:    "unsupported_provider",
				Message: "该 Provider 还没有 Go 侧登录流程",
			},
		}
	case errors.Is(err, accountauth.ErrInvalidStartRequest),
		errors.Is(err, accountapp.ErrInvalidReauthentication):
		return failure{
			status: http.StatusBadRequest,
			body:   errorView{Error: "invalid_request", Message: "重新认证请求无效"},
		}
	case errors.Is(err, accountapp.ErrAccountNotFound):
		return failure{
			status: http.StatusNotFound,
			body:   errorView{Error: "account_not_found", Message: "账号不存在"},
		}
	case errors.Is(err, accountapp.ErrReauthenticationUnsupported):
		return failure{
			status: http.StatusBadRequest,
			body: errorView{
				Error:   "reauth_unsupported",
				Code:    "reauth_unsupported",
				Message: "账号凭据不支持原地重新认证",
			},
		}
	case errors.Is(err, accountapp.ErrReauthenticationIdentityMismatch):
		return failure{
			status: http.StatusConflict,
			body: errorView{
				Error:   "reauth_account_failed",
				Code:    "reauth_identity_mismatch",
				Message: "重新认证身份与目标账号不匹配",
			},
		}
	case errors.Is(err, accountauth.ErrJobCapacity):
		return failure{
			status: http.StatusServiceUnavailable,
			body: errorView{
				Error:   "reauth_unavailable",
				Code:    "oauth_job_capacity",
				Message: "登录作业容量已满，请稍后重试",
			},
		}
	default:
		return failure{
			status: http.StatusInternalServerError,
			body:   errorView{Error: "reauth_account_failed", Message: "重新认证作业创建失败"},
		}
	}
}

// validProviderToken 只校验结构，不维护 provider 名单：上游新增 provider 时零改动通过。
func validProviderToken(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	for index, character := range value {
		isLower := character >= 'a' && character <= 'z'
		isDigit := character >= '0' && character <= '9'
		if isLower || isDigit {
			continue
		}
		if index == 0 {
			return false
		}
		if character != '-' && character != '_' && character != '.' {
			return false
		}
	}
	return true
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Pragma", "no-cache")
	response.Header().Set("Referrer-Policy", "no-referrer")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeFailure(response http.ResponseWriter, problem failure) {
	writeJSON(response, problem.status, problem.body)
}
