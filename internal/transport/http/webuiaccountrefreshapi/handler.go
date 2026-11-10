// Package webuiaccountrefreshapi 提供账号「三段并发刷新」的 WebUI 管理入口。
//
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/refresh
//
// 与 Node 的 handleRefreshAccountRequest 相比，本切片是同步实现：Node 返回 202 与
// job 句柄，再由 SSE 推送逐段进度；Go 入口在一次请求内并发执行状态 / 模型 / 额度
// 三段，逐段返回 {ok, code, error}，HTTP 状态恒为 200（鉴权、方法、路径与账号不存在
// 除外），调用方一次就能拿到全部结果，不需要额外的作业表与事件流。
//
// 三段互相独立：单段失败只写进自己那一段，不影响其它段；整体超时（默认 20s）时
// 未完成段标 timeout，已完成的段原样返回。三个 Refresher 都是可选端口，未接线的
// 段返回 refresh_unavailable，不用成功状态掩盖「没有刷新」。
//
// 装配（路由注册、Node 代理切换）不在本包内：本切片只提供可挂载的 http.Handler。
package webuiaccountrefreshapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const (
	// Path 是账号管理契约前缀。
	Path = "/v1/management/webui/accounts"
	// RefreshSuffix 由共享 wiring 拼在 Path 之后，构成管理路由模式。
	//
	//	POST /v1/management/webui/accounts/{provider}/{accountRef}/refresh
	RefreshSuffix = "/{provider}/{accountRef}/refresh"

	// BranchStatus 是运行态刷新段的键名。
	BranchStatus = "status"
	// BranchModels 是模型目录刷新段的键名。
	BranchModels = "models"
	// BranchUsage 是额度刷新段的键名。
	BranchUsage = "usage"

	// codeRefreshUnavailable 表示该段刷新端口没有接线。
	codeRefreshUnavailable = "refresh_unavailable"
	// codeRefreshFailed 表示该段刷新执行失败。
	codeRefreshFailed = "refresh_failed"
	// codeTimeout 表示整体超时后该段仍未完成。
	codeTimeout = "timeout"

	// defaultTimeout 是整体刷新的默认上限。
	defaultTimeout = 20 * time.Second

	// maxErrorRunes 与 Node 的 slice(0, 500) 对齐，避免把上游长报文整段带回界面。
	maxErrorRunes = 500
)

// errRefreshUnavailable 由未接线的段返回，统一翻成 refresh_unavailable。
var errRefreshUnavailable = errors.New("刷新端口未接线")

// ErrInvalidDependencies 表示 Handler 缺少鉴权或账号读端口。
var ErrInvalidDependencies = errors.New("账号刷新接口依赖无效")

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// AccountDirectory 是账号读端口，用于把路径里的 provider 与真实账号对上。
// accountapp.AccountLifecycleStore 的存储实现直接满足本接口。
type AccountDirectory interface {
	GetByRef(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountcore.Account, error)
}

// StatusRefresher 刷新单个账号的运行态（凭据可用性、阻塞原因）。
type StatusRefresher interface {
	RefreshAccountStatus(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) error
}

// ModelRefresher 刷新单个账号的模型目录。
//
// 方法签名与 accountapp.AccountModelRefresher 一致，既有刷新实现可直接接线。
type ModelRefresher interface {
	RefreshAccountModels(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) ([]accountapp.AccountModel, error)
}

// QuotaRefresher 刷新单个账号的额度快照。
//
// 方法签名与 accountusage.UsageRefresher 一致，既有刷新实现可直接接线。
type QuotaRefresher interface {
	RefreshUsage(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountusage.ReadResult, error)
}

// 编译期确认既有端口仍然满足本包的最小依赖。
var (
	_ ModelRefresher = accountapp.AccountModelRefresher(nil)
	_ QuotaRefresher = accountusage.UsageRefresher(nil)
)

// Dependencies 汇总账号刷新的依赖。
//
// Authorizer 与 Accounts 是必需端口；三个 Refresher 与 Timeout 可选：缺失的段
// 返回 refresh_unavailable，Timeout 为零时使用 defaultTimeout。
type Dependencies struct {
	Authorizer Authorizer
	// AIHomeDir 是 AIH 数据目录；本包不读盘，保留给接线方构造 Refresher 适配器，
	// 与其它 WebUI 管理包的依赖形态保持一致。
	AIHomeDir       string
	Accounts        AccountDirectory
	StatusRefresher StatusRefresher
	ModelRefresher  ModelRefresher
	QuotaRefresher  QuotaRefresher
	Timeout         time.Duration
}

// BranchResult 是单段刷新的结果。
//
// ok=false 时 code 一定存在：refresh_unavailable（未接线）、refresh_failed（执行
// 失败）或 timeout（整体超时未完成）；error 是给人看的摘要。
type BranchResult struct {
	OK    bool   `json:"ok"`
	Code  string `json:"code,omitempty"`
	Error string `json:"error,omitempty"`
}

// Response 是一次账号刷新的完整结果。
//
// OK 沿用 Node 的作业口径：只要有一段成功就为 true，三段全部失败才是 false；
// failedBranches 如实列出失败段，避免「整体成功」掩盖某一面没刷到。
type Response struct {
	OK             bool                    `json:"ok"`
	Provider       string                  `json:"provider"`
	AccountRef     string                  `json:"accountRef"`
	Branches       map[string]BranchResult `json:"branches"`
	FailedBranches []string                `json:"failedBranches,omitempty"`
	TimedOut       bool                    `json:"timedOut"`
	DurationMS     int64                   `json:"durationMs"`
}

type errorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// Handler 是账号三段刷新的 HTTP 入站适配器。
type Handler struct {
	authorizer      Authorizer
	accounts        AccountDirectory
	statusRefresher StatusRefresher
	modelRefresher  ModelRefresher
	quotaRefresher  QuotaRefresher
	timeout         time.Duration
}

// NewHandler 校验必需依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Accounts == nil {
		return nil, ErrInvalidDependencies
	}
	timeout := dependencies.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	return &Handler{
		authorizer:      dependencies.Authorizer,
		accounts:        dependencies.Accounts,
		statusRefresher: dependencies.StatusRefresher,
		modelRefresher:  dependencies.ModelRefresher,
		quotaRefresher:  dependencies.QuotaRefresher,
		timeout:         timeout,
	}, nil
}

// ServeHTTP 只接受 POST，校验账号后并发执行三段刷新。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.accounts == nil {
		writeError(response, http.StatusServiceUnavailable,
			"account_refresh_unavailable", "账号刷新服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
		return
	}
	writeNoStoreHeaders(response)

	provider := strings.ToLower(strings.TrimSpace(request.PathValue("provider")))
	rawRef := strings.TrimSpace(request.PathValue("accountRef"))
	accountRef, err := accountcore.ParseAccountRef(rawRef)
	if !validProviderToken(provider) || err != nil {
		writeError(response, http.StatusBadRequest, "invalid_account_path", "无效的账号路径")
		return
	}

	account, err := handler.accounts.GetByRef(request.Context(), accountRef)
	if err != nil {
		if errors.Is(err, accountapp.ErrAccountNotFound) {
			writeError(response, http.StatusNotFound, "account_not_found", "账号不存在")
			return
		}
		writeError(response, http.StatusInternalServerError,
			"account_refresh_read_failed", "读取账号失败")
		return
	}
	// provider 与账号归属不一致时按「不存在」处理：避免用 A 的路径刷新 B 的账号。
	if account.ProviderID() != provider {
		writeError(response, http.StatusNotFound, "account_not_found", "账号不存在")
		return
	}

	startedAt := time.Now()
	specs := handler.branches(accountRef)
	results, timedOut := runBranches(request.Context(), handler.timeout, specs)

	failedBranches := make([]string, 0, len(specs))
	anySucceeded := false
	for _, spec := range specs {
		if results[spec.name].OK {
			anySucceeded = true
			continue
		}
		failedBranches = append(failedBranches, spec.name)
	}

	writeJSON(response, http.StatusOK, Response{
		OK:             anySucceeded,
		Provider:       provider,
		AccountRef:     accountRef.String(),
		Branches:       results,
		FailedBranches: failedBranches,
		TimedOut:       timedOut,
		DurationMS:     time.Since(startedAt).Milliseconds(),
	})
}

// branchSpec 是一段刷新的执行体。
type branchSpec struct {
	name string
	run  func(ctx context.Context) error
}

// branches 按固定顺序返回三段刷新。
//
// 未接线的段返回 errRefreshUnavailable，由 resultOfError 统一翻译，而不是在这里
// 直接伪造成功或空结果。
func (handler *Handler) branches(accountRef accountcore.AccountRef) []branchSpec {
	return []branchSpec{
		{
			name: BranchStatus,
			run: func(ctx context.Context) error {
				if handler.statusRefresher == nil {
					return errRefreshUnavailable
				}
				return handler.statusRefresher.RefreshAccountStatus(ctx, accountRef)
			},
		},
		{
			name: BranchModels,
			run: func(ctx context.Context) error {
				if handler.modelRefresher == nil {
					return errRefreshUnavailable
				}
				_, err := handler.modelRefresher.RefreshAccountModels(ctx, accountRef)
				return err
			},
		},
		{
			name: BranchUsage,
			run: func(ctx context.Context) error {
				if handler.quotaRefresher == nil {
					return errRefreshUnavailable
				}
				_, err := handler.quotaRefresher.RefreshUsage(ctx, accountRef)
				return err
			},
		},
	}
}

// runBranches 并发执行全部段并收集结果。
//
// 每个 goroutine 只往带缓冲的 channel 写自己的结果，不碰共享切片：整体超时返回时
// 未读到的结果不会与主协程读结果产生数据竞争；缓冲容量等于段数也保证 goroutine
// 不会因为无人接收而泄漏。
func runBranches(
	parent context.Context,
	timeout time.Duration,
	specs []branchSpec,
) (map[string]BranchResult, bool) {
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()

	type outcome struct {
		name   string
		result BranchResult
	}
	outcomes := make(chan outcome, len(specs))
	for _, spec := range specs {
		spec := spec
		go func() {
			outcomes <- outcome{name: spec.name, result: resultOfError(spec.run(ctx))}
		}()
	}

	results := make(map[string]BranchResult, len(specs))
	timedOut := false
	for len(results) < len(specs) {
		select {
		case item := <-outcomes:
			results[item.name] = item.result
		case <-ctx.Done():
			timedOut = true
			for _, spec := range specs {
				if _, done := results[spec.name]; !done {
					results[spec.name] = BranchResult{
						Code:  codeTimeout,
						Error: "刷新超时，该段未在限定时间内完成",
					}
				}
			}
		}
	}
	return results, timedOut
}

// resultOfError 把一段刷新的错误收敛成稳定错误码。
func resultOfError(err error) BranchResult {
	switch {
	case err == nil:
		return BranchResult{OK: true}
	case errors.Is(err, errRefreshUnavailable):
		return BranchResult{
			Code:  codeRefreshUnavailable,
			Error: "该段刷新端口未接线，无法执行",
		}
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		return BranchResult{
			Code:  codeTimeout,
			Error: "刷新超时，该段未在限定时间内完成",
		}
	default:
		return BranchResult{Code: codeRefreshFailed, Error: truncateError(err)}
	}
}

// truncateError 截断错误摘要，按 rune 截断以免切断多字节字符。
func truncateError(err error) string {
	text := strings.TrimSpace(err.Error())
	if text == "" {
		return "刷新失败"
	}
	runes := []rune(text)
	if len(runes) <= maxErrorRunes {
		return text
	}
	return string(runes[:maxErrorRunes]) + "…"
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

func writeNoStoreHeaders(response http.ResponseWriter) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Pragma", "no-cache")
	response.Header().Set("Referrer-Policy", "no-referrer")
	response.Header().Set("X-Content-Type-Options", "nosniff")
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorResponse{OK: false, Error: code, Message: message})
}
