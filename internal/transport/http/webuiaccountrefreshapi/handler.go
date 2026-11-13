// Package webuiaccountrefreshapi 提供账号「三段并发刷新」的 WebUI 管理入口。
//
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/refresh
//
// 契约：**响应形状与 Node 的 handleRefreshAccountRequest 逐字段一致**——
// `{ok, accepted, alreadyRunning, job}`，job 是 scope=account 的作业快照
// （branches 里逐段 status/error，failedBranches 列出失败段，finishedAt 为终态时间）。
//
// 执行模型是同步的：Node 返回 202 后靠 SSE 推进度，Go 在一次请求内并发跑完三段，
// 直接回一个**终态** job。前端 handleAccountRefreshJobUpdate 对终态 job 会立刻收尾
// （清 spinner、按 failedBranches 提示），所以不需要作业表、事件流或轮询。
//
// 稳定性取舍：
//   - 三段并发、单段失败隔离，只有全部失败时 job.status 才是 failed；
//   - 整体超时（默认 20s）时未完成段标 timeout，已完成的段原样保留；
//   - 刷新跑在 context.WithoutCancel 上：客户端断开不会中止已经开始的探测，
//     避免「界面关了、账号状态刷一半」；
//   - 同一账号的并发请求复用同一次执行（alreadyRunning=true），不会重复打上游。
//
// 三个 Refresher 都是可选端口，未接线的段标 refresh_unavailable，不用成功掩盖「没刷新」。
package webuiaccountrefreshapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
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

	// JobScopeAccount 与 Node 的 job.scope 同值：账号级刷新（含 branches 明细）。
	JobScopeAccount = "account"

	// jobStatusSucceeded / jobStatusFailed 是作业终态，与 Node 序列化口径一致。
	jobStatusSucceeded = "succeeded"
	jobStatusFailed    = "failed"
	// branchStatusSucceeded / branchStatusFailed / branchStatusSkipped 是单段终态。
	branchStatusSucceeded = "succeeded"
	branchStatusFailed    = "failed"
	branchStatusSkipped   = "skipped"

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

// branchLabels 与 Node 的 BRANCH_LABELS 同文案，用于拼 job.error。
var branchLabels = map[string]string{
	BranchStatus: "状态",
	BranchModels: "模型",
	BranchUsage:  "额度",
}

// errRefreshUnavailable 由未接线的段返回，统一翻成 refresh_unavailable。
var errRefreshUnavailable = errors.New("刷新端口未接线")

// errBranchSkipped 表示该 Provider 或认证方式不适用此段刷新（如非模型目录 Provider 或 API Key 账号）。
var errBranchSkipped = errors.New("refresh_branch_skipped")

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
	// SupportsModelCatalog 判定 Provider 是否支持模型目录段；nil 时默认支持。
	SupportsModelCatalog func(provider string) bool
	// IsAPIKeyAccount 判定账号是否处于 API Key 模式（跳过额度段）；nil 时不跳过。
	IsAPIKeyAccount func(ctx context.Context, accountRef accountcore.AccountRef) bool
	// ReadRuntimeStatus 读取刷新前后的账号运行态词，用于判定是否从阻塞自动恢复。
	ReadRuntimeStatus func(ctx context.Context, accountRef accountcore.AccountRef) string
	Timeout           time.Duration
}

// BranchResult 是单段刷新的结果（内部用）。
//
// ok=false 时 code 一定存在：refresh_unavailable（未接线）、refresh_failed（执行
// 失败）或 timeout（整体超时未完成）；error 是给人看的摘要。
type BranchResult struct {
	OK      bool   `json:"ok"`
	Skipped bool   `json:"skipped,omitempty"`
	Code    string `json:"code,omitempty"`
	Error   string `json:"error,omitempty"`
}

// JobBranch 是作业里单段的状态，字段名与 Node 的 serializeAccountRefreshJob 一致。
type JobBranch struct {
	Status string `json:"status"`
	Error  string `json:"error"`
}

// Job 是账号刷新作业快照，形状对齐 Node 的 scope=account 序列化结果。
//
// FinishedAt 用指针：Node 在未完成时输出 null，用 0 会变成「1970 年已完成」。
type Job struct {
	ID             string               `json:"id"`
	Provider       string               `json:"provider"`
	AccountRef     string               `json:"accountRef"`
	Status         string               `json:"status"`
	CreatedAt      int64                `json:"createdAt"`
	UpdatedAt      int64                `json:"updatedAt"`
	FinishedAt     *int64               `json:"finishedAt"`
	Error          string               `json:"error"`
	Recovered      bool                 `json:"recovered,omitempty"`
	FailedBranches []string             `json:"failedBranches,omitempty"`
	Scope          string               `json:"scope"`
	Branches       map[string]JobBranch `json:"branches"`
}

// Response 是刷新接口的完整响应，与 Node 的 202 响应同形。
type Response struct {
	OK             bool  `json:"ok"`
	Accepted       bool  `json:"accepted"`
	AlreadyRunning bool  `json:"alreadyRunning"`
	Job            Job   `json:"job"`
	DurationMS     int64 `json:"durationMs"`
}

type errorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// Handler 是账号三段刷新的 HTTP 入站适配器。
type Handler struct {
	authorizer           Authorizer
	accounts             AccountDirectory
	statusRefresher      StatusRefresher
	modelRefresher       ModelRefresher
	quotaRefresher       QuotaRefresher
	supportsModelCatalog func(provider string) bool
	isAPIKeyAccount      func(ctx context.Context, accountRef accountcore.AccountRef) bool
	readRuntimeStatus    func(ctx context.Context, accountRef accountcore.AccountRef) string
	timeout              time.Duration

	// inflight 让同一账号的并发刷新复用同一次执行：第二个请求等第一个跑完，
	// 拿同一份 job 并标 alreadyRunning=true，避免重复打上游。
	inflightMu sync.Mutex
	inflight   map[string]*inflightRun
}

// inflightRun 是一次进行中的刷新。
type inflightRun struct {
	done chan struct{}
	job  Job
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
		authorizer:           dependencies.Authorizer,
		accounts:             dependencies.Accounts,
		statusRefresher:      dependencies.StatusRefresher,
		modelRefresher:       dependencies.ModelRefresher,
		quotaRefresher:       dependencies.QuotaRefresher,
		supportsModelCatalog: dependencies.SupportsModelCatalog,
		isAPIKeyAccount:      dependencies.IsAPIKeyAccount,
		readRuntimeStatus:    dependencies.ReadRuntimeStatus,
		timeout:              timeout,
		inflight:             make(map[string]*inflightRun),
	}, nil
}

// ServeHTTP 只接受 POST，校验账号后并发执行三段刷新并返回终态作业。
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
	job, alreadyRunning := handler.refresh(request.Context(), provider, accountRef)
	writeJSON(response, http.StatusAccepted, Response{
		OK:             true,
		Accepted:       true,
		AlreadyRunning: alreadyRunning,
		Job:            job,
		DurationMS:     time.Since(startedAt).Milliseconds(),
	})
}

// refresh 执行一次刷新；同一账号已有执行在跑时等待并复用它的结果。
//
// 刷新本体跑在 context.WithoutCancel 上：客户端断开不该把已经发出的上游探测掐断，
// 否则账号状态会停在刷一半的样子。整体上限仍由 handler.timeout 控制。
func (handler *Handler) refresh(
	parent context.Context,
	provider string,
	accountRef accountcore.AccountRef,
) (Job, bool) {
	key := provider + "\x00" + accountRef.String()

	handler.inflightMu.Lock()
	if running, found := handler.inflight[key]; found {
		handler.inflightMu.Unlock()
		select {
		case <-running.done:
		case <-time.After(handler.timeout + time.Second):
			// 极端情况下上一次执行卡住：给一个超时终态，不让调用方无限等。
		}
		return running.job, true
	}
	running := &inflightRun{done: make(chan struct{})}
	handler.inflight[key] = running
	handler.inflightMu.Unlock()

	job := handler.runOnce(context.WithoutCancel(parent), provider, accountRef)

	handler.inflightMu.Lock()
	running.job = job
	delete(handler.inflight, key)
	handler.inflightMu.Unlock()
	close(running.done)
	return job, false
}

// runOnce 并发跑三段并组装终态作业。
func (handler *Handler) runOnce(
	parent context.Context,
	provider string,
	accountRef accountcore.AccountRef,
) Job {
	now := time.Now().UnixMilli()
	statusBefore := ""
	if handler.readRuntimeStatus != nil {
		statusBefore = strings.TrimSpace(handler.readRuntimeStatus(parent, accountRef))
	}
	specs := handler.branches(provider, accountRef)
	results := runBranches(parent, handler.timeout, specs)

	branches := make(map[string]JobBranch, len(specs))
	failedBranches := make([]string, 0, len(specs))
	failures := make([]string, 0, len(specs))
	succeededCount := 0
	for _, spec := range specs {
		result := results[spec.name]
		if result.Skipped {
			branches[spec.name] = JobBranch{Status: branchStatusSkipped}
			continue
		}
		if result.OK {
			branches[spec.name] = JobBranch{Status: branchStatusSucceeded}
			succeededCount++
			continue
		}
		branches[spec.name] = JobBranch{Status: branchStatusFailed, Error: result.Error}
		failedBranches = append(failedBranches, spec.name)
		label := branchLabels[spec.name]
		if label == "" {
			label = spec.name
		}
		failures = append(failures, label+"："+result.Error)
	}

	// 与 Node 同口径：只有非跳过段全部失败（succeededCount==0 且存在 failedBranches）才算作业失败。
	status := jobStatusSucceeded
	if len(failedBranches) > 0 && succeededCount == 0 {
		status = jobStatusFailed
	}
	recovered := false
	if statusBefore != "" && statusBefore != "healthy" && handler.readRuntimeStatus != nil {
		modelsRecovered := results[BranchModels].OK && !results[BranchModels].Skipped
		usageRecovered := results[BranchUsage].OK && !results[BranchUsage].Skipped
		if (modelsRecovered || usageRecovered) &&
			strings.TrimSpace(handler.readRuntimeStatus(parent, accountRef)) == "healthy" {
			recovered = true
		}
	}
	// 全部成功时 job.error 必须为空：Node 的 serializeAccountRefreshJob 输出 error: ''，
	// 而 truncateText 的「刷新失败」兜底只该用在真正的失败摘要上。
	errorText := ""
	if len(failures) > 0 {
		errorText = truncateText(strings.Join(failures, "；"))
	}
	finishedAt := time.Now().UnixMilli()
	job := Job{
		ID:         makeJobID(provider, accountRef.String(), now),
		Provider:   provider,
		AccountRef: accountRef.String(),
		Status:     status,
		CreatedAt:  now,
		UpdatedAt:  finishedAt,
		FinishedAt: &finishedAt,
		Error:      errorText,
		Recovered:  recovered,
		Scope:      JobScopeAccount,
		Branches:   branches,
	}
	if len(failedBranches) > 0 {
		job.FailedBranches = failedBranches
	}
	return job
}

// makeJobID 生成与 Node 同前缀的作业标识；同步执行下它只用于前端去重与展示。
func makeJobID(provider string, accountRef string, nowMS int64) string {
	return strings.Join([]string{
		"acct-refresh",
		provider,
		accountRef,
		strconv.FormatInt(nowMS, 36),
	}, "-")
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
func (handler *Handler) branches(provider string, accountRef accountcore.AccountRef) []branchSpec {
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
				if handler.supportsModelCatalog != nil && !handler.supportsModelCatalog(provider) {
					return errBranchSkipped
				}
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
				if handler.isAPIKeyAccount != nil && handler.isAPIKeyAccount(ctx, accountRef) {
					return errBranchSkipped
				}
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
) map[string]BranchResult {
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
	for len(results) < len(specs) {
		select {
		case item := <-outcomes:
			results[item.name] = item.result
		case <-ctx.Done():
			for _, spec := range specs {
				if _, done := results[spec.name]; !done {
					results[spec.name] = BranchResult{
						Code:  codeTimeout,
						Error: "刷新超时（timeout），该段未在限定时间内完成",
					}
				}
			}
		}
	}
	return results
}

// resultOfError 把一段刷新的错误收敛成稳定错误码。
func resultOfError(err error) BranchResult {
	switch {
	case errors.Is(err, errBranchSkipped):
		return BranchResult{OK: true, Skipped: true}
	case err == nil:
		return BranchResult{OK: true}
	case errors.Is(err, errRefreshUnavailable):
		// 作业 JSON 只暴露 status/error：把错误码写进文案，前端和排障才认得出是哪一类失败。
		return BranchResult{
			Code:  codeRefreshUnavailable,
			Error: "该段刷新端口未接线（refresh_unavailable），无法执行",
		}
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		return BranchResult{
			Code:  codeTimeout,
			Error: "刷新超时（timeout），该段未在限定时间内完成",
		}
	default:
		return BranchResult{Code: codeRefreshFailed, Error: truncateText(err.Error())}
	}
}

// truncateText 截断错误摘要，按 rune 截断以免切断多字节字符。
func truncateText(text string) string {
	text = strings.TrimSpace(text)
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
