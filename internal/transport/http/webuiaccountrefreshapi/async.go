package webuiaccountrefreshapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/webuirefreshjobstore"
)

const (
	// jobIDParam 是作业查询路由里的路径参数名。
	//
	//	GET /v1/management/webui/accounts/refresh-jobs/{jobId}
	jobIDParam = "jobId"

	// codeRefreshJobNotFound 表示作业表里没有这个作业（不存在或已过保留期）。
	codeRefreshJobNotFound = "refresh_job_not_found"
	// codeInvalidRefreshJobPath 表示作业路径里没有可用的作业标识。
	codeInvalidRefreshJobPath = "invalid_refresh_job_path"
)

// ErrInvalidAsyncDependencies 表示异步包装缺少执行器或作业表。
var ErrInvalidAsyncDependencies = errors.New("账号刷新作业接口依赖无效")

// AsyncJob 是作业表快照的序列化形状，字段名与 Node 的 serializeAccountRefreshJob 一致。
//
// 与同步执行器的 Job 分开定义，是因为异步入口多两个口径：
//   - finishedAt 未完成时为 null（指针，避免 0 被读成「1970 年已完成」）；
//   - branches 只在 scope=account 时出现，usage 作业没有分段明细。
//
// recovered 与 failedBranches 按 Node 的 omitempty 口径只在有值时出现。
type AsyncJob struct {
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
	Branches       map[string]JobBranch `json:"branches,omitempty"`
}

// AsyncResponse 是异步刷新入口的 202 响应，与 Node 同形（不含 durationMs）。
type AsyncResponse struct {
	OK             bool     `json:"ok"`
	Accepted       bool     `json:"accepted"`
	AlreadyRunning bool     `json:"alreadyRunning"`
	Job            AsyncJob `json:"job"`
}

// AsyncJobResponse 是作业查询的 200 响应。
type AsyncJobResponse struct {
	OK  bool     `json:"ok"`
	Job AsyncJob `json:"job"`
}

// AsyncHandler 把同步三段刷新执行器包成异步作业入口。
//
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/refresh        -> 202 queued
//	GET  /v1/management/webui/accounts/refresh-jobs/{jobId}                  -> 200 / 404
//
// 请求校验与响应形状沿用同步执行器；作业的创建、去重与保留交给作业表，
// 本层只负责「校验 -> 起作业 -> 立刻回 queued 快照」和「按 id 读快照」。
type AsyncHandler struct {
	executor *Handler
	jobs     *webuirefreshjobstore.Store
}

// NewAsyncHandler 校验依赖并创建异步包装。
//
// 执行器自身的鉴权/账号端口也必须可用：否则作业会先被接受、再在后台失败，
// 界面只能看到一个没有意义的失败终态。
func NewAsyncHandler(executor *Handler, jobs *webuirefreshjobstore.Store) (*AsyncHandler, error) {
	if executor == nil || jobs == nil ||
		executor.authorizer == nil || executor.accounts == nil {
		return nil, ErrInvalidAsyncDependencies
	}
	return &AsyncHandler{executor: executor, jobs: jobs}, nil
}

// ServeHTTP 只接受 POST：鉴权、方法、路径与账号归属校验逐条对齐同步执行器，
// 通过后把执行体交给作业表异步执行，立即返回 queued 快照。
//
// 校验逻辑是复刻而不是调用：handler.go 的 ServeHTTP 会在请求内跑完三段刷新，
// 不能复用；同包内又没有抽出的校验函数，所以这里按同一顺序重放，
// 每条分支的状态码与错误码都必须与同步入口一致。
func (handler *AsyncHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.executor == nil || handler.jobs == nil {
		writeError(response, http.StatusServiceUnavailable,
			"account_refresh_unavailable", "账号刷新服务不可用")
		return
	}
	if !handler.executor.authorizer.Authorized(request) {
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

	account, err := handler.executor.accounts.GetByRef(request.Context(), accountRef)
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

	snapshot, alreadyRunning := handler.jobs.Start(request.Context(), webuirefreshjobstore.StartRequest{
		Provider:   provider,
		AccountRef: accountRef.String(),
		Scope:      JobScopeAccount,
		Run: func(ctx context.Context) (webuirefreshjobstore.Snapshot, error) {
			// 刷新本体跑在 WithoutCancel 上：客户端断开或作业表取消都不该把已经
			// 发出的上游探测掐断（与同步执行器同一取舍）。执行器内部的
			// alreadyRunning 去重在这里没有意义——异步层以作业表为准，忽略该标志。
			job, _ := handler.executor.refresh(context.WithoutCancel(ctx), provider, accountRef)
			return snapshotFromJob(job), nil
		},
	})
	writeJSON(response, http.StatusAccepted, AsyncResponse{
		OK:             true,
		Accepted:       true,
		AlreadyRunning: alreadyRunning,
		Job:            jobFromSnapshot(snapshot),
	})
}

// ServeJob 返回作业快照：作业表里没有（或已过保留期）按 404 处理。
func (handler *AsyncHandler) ServeJob(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.executor == nil || handler.jobs == nil {
		writeError(response, http.StatusServiceUnavailable,
			"account_refresh_unavailable", "账号刷新服务不可用")
		return
	}
	if !handler.executor.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}
	writeNoStoreHeaders(response)

	jobID := strings.TrimSpace(request.PathValue(jobIDParam))
	if jobID == "" {
		writeError(response, http.StatusBadRequest, codeInvalidRefreshJobPath, "无效的作业路径")
		return
	}
	snapshot, found := handler.jobs.Get(jobID)
	if !found {
		writeError(response, http.StatusNotFound, codeRefreshJobNotFound, "刷新作业不存在")
		return
	}
	writeJSON(response, http.StatusOK, AsyncJobResponse{OK: true, Job: jobFromSnapshot(snapshot)})
}

// snapshotFromJob 把同步执行器产出的终态作业转成作业表快照。
//
// Recovered 由作业表或上层恢复逻辑设置，这里不覆盖（同步执行器没有这个概念）。
func snapshotFromJob(job Job) webuirefreshjobstore.Snapshot {
	branches := make(map[string]webuirefreshjobstore.Branch, len(job.Branches))
	for name, branch := range job.Branches {
		branches[name] = webuirefreshjobstore.Branch{Status: branch.Status, Error: branch.Error}
	}
	// 同步执行器的 truncateText 在没有失败时会兜底成「刷新失败」；异步作业按 Node
	// 口径给空串，否则成功的作业也带着一条错误文案。
	errorText := job.Error
	if len(job.FailedBranches) == 0 {
		errorText = ""
	}
	return webuirefreshjobstore.Snapshot{
		ID:             job.ID,
		Provider:       job.Provider,
		AccountRef:     job.AccountRef,
		Status:         job.Status,
		CreatedAt:      job.CreatedAt,
		UpdatedAt:      job.UpdatedAt,
		FinishedAt:     job.FinishedAt,
		Error:          errorText,
		FailedBranches: job.FailedBranches,
		Scope:          job.Scope,
		Branches:       branches,
	}
}

// jobFromSnapshot 把作业表快照序列化成 Node 同形 JSON。
//
// branches 只在 scope=account 时输出：usage 作业没有分段明细，空表也不该出现。
// 队列中的快照同样没有分段，此时按 omitempty 省略（Node 的 202 也不带 branches）。
func jobFromSnapshot(snapshot webuirefreshjobstore.Snapshot) AsyncJob {
	job := AsyncJob{
		ID:             snapshot.ID,
		Provider:       snapshot.Provider,
		AccountRef:     snapshot.AccountRef,
		Status:         snapshot.Status,
		CreatedAt:      snapshot.CreatedAt,
		UpdatedAt:      snapshot.UpdatedAt,
		FinishedAt:     snapshot.FinishedAt,
		Error:          snapshot.Error,
		Recovered:      snapshot.Recovered,
		FailedBranches: snapshot.FailedBranches,
		Scope:          snapshot.Scope,
	}
	if snapshot.Scope != JobScopeAccount {
		return job
	}
	branches := make(map[string]JobBranch, len(snapshot.Branches))
	for name, branch := range snapshot.Branches {
		branches[name] = JobBranch{Status: branch.Status, Error: branch.Error}
	}
	job.Branches = branches
	return job
}
