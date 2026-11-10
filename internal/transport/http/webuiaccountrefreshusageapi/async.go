// 本文件把 handler.go 的同步额度刷新执行器包成 Node 同形的异步作业入口。
//
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/refresh-usage -> 202 queued
//
// 与同步入口的差异只在执行时机：请求校验通过后立刻登记作业并返回 queued 快照，
// 探测在 Go 进程内异步跑，调用方用共享的 refresh-jobs 查询入口看终态。校验顺序、
// 状态码与错误码逐条沿用 handler.go 的 ServeHTTP，避免两个入口对同一路径给出
// 不同结论。
package webuiaccountrefreshusageapi

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/webuirefreshjobstore"
)

const (
	// UsageJobScope 是额度刷新作业的 scope；与 Node 的缺省 scope 同值。
	UsageJobScope = webuirefreshjobstore.ScopeUsage

	// maxJobErrorRunes 与 Node 的 slice(0, 500) 对齐，避免把上游长报文整段带回界面。
	maxJobErrorRunes = 500
)

// ErrInvalidAsyncDependencies 表示异步包装缺少执行器或作业表。
var ErrInvalidAsyncDependencies = errors.New("额度刷新作业接口依赖无效")

// AsyncJob 是作业快照的序列化形状，字段名与 Node 的 serializeAccountRefreshJob 一致。
//
// 与同步执行器的响应分开定义，是因为异步入口多两个口径：
//   - finishedAt 未完成时为 null（指针，避免 0 被读成「1970 年已完成」）；
//   - branches 只在 scope=account 时出现，usage 作业没有分段明细。
//
// recovered 与 failedBranches 按 Node 的 omitempty 口径只在有值时出现。
type AsyncJob struct {
	ID             string                                 `json:"id"`
	Provider       string                                 `json:"provider"`
	AccountRef     string                                 `json:"accountRef"`
	Status         string                                 `json:"status"`
	CreatedAt      int64                                  `json:"createdAt"`
	UpdatedAt      int64                                  `json:"updatedAt"`
	FinishedAt     *int64                                 `json:"finishedAt"`
	Error          string                                 `json:"error"`
	Recovered      bool                                   `json:"recovered,omitempty"`
	FailedBranches []string                               `json:"failedBranches,omitempty"`
	Scope          string                                 `json:"scope"`
	Branches       map[string]webuirefreshjobstore.Branch `json:"branches,omitempty"`
}

// AsyncResponse 是异步刷新入口的 202 响应，与 Node 同形（不含 durationMs）。
type AsyncResponse struct {
	OK             bool     `json:"ok"`
	Accepted       bool     `json:"accepted"`
	AlreadyRunning bool     `json:"alreadyRunning"`
	Job            AsyncJob `json:"job"`
}

// AsyncHandler 把同步额度刷新执行器包成异步作业入口。
//
// 作业的创建、同目标去重与保留策略都交给共享作业表，本层只负责「校验 -> 起作业 ->
// 立刻回 queued 快照」；执行器保持原样，不在本层复制它的探测逻辑。
type AsyncHandler struct {
	executor *Handler
	jobs     *webuirefreshjobstore.Store
}

// NewAsyncHandler 校验依赖并创建异步包装。
//
// 执行器自身的鉴权与账号读端口必须可用：否则作业会先被接受、再在后台失败，界面
// 只能看到一个没有意义的失败终态。QuotaProbe 允许为 nil——那是「Go 侧还没接入
// 探测」的合法配置，由 ServeHTTP 直接回 501，不会创建作业。
func NewAsyncHandler(executor *Handler, jobs *webuirefreshjobstore.Store) (*AsyncHandler, error) {
	if executor == nil || jobs == nil ||
		executor.authorizer == nil || executor.accounts == nil {
		return nil, ErrInvalidAsyncDependencies
	}
	return &AsyncHandler{executor: executor, jobs: jobs}, nil
}

// ServeHTTP 只接受 POST：鉴权、方法、路径与账号归属校验逐条对齐同步执行器，
// 通过后把探测交给作业表异步执行，立即返回 queued 快照。
//
// 校验逻辑是复刻而不是调用：handler.go 的 ServeHTTP 会在请求内跑完探测，不能复用；
// 同包内也没有抽出的校验函数，所以这里按同一顺序重放，每条分支的状态码与错误码
// 都必须与同步入口一致。
func (handler *AsyncHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.executor == nil || handler.jobs == nil ||
		handler.executor.authorizer == nil || handler.executor.accounts == nil {
		writeError(response, http.StatusServiceUnavailable,
			"quota_refresh_unavailable", "额度刷新服务不可用")
		return
	}
	// 额度数据属于账号隐私：成功与失败响应（含 4xx/5xx）都禁止缓存。
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Pragma", "no-cache")

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

	provider := strings.ToLower(strings.TrimSpace(request.PathValue("provider")))
	accountRef := strings.TrimSpace(request.PathValue("accountRef"))
	if provider == "" || accountRef == "" {
		writeError(response, http.StatusBadRequest, "invalid_account_path", "")
		return
	}

	owner, found, err := handler.executor.accounts.LookupProvider(request.Context(), accountRef)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "account_lookup_failed", "")
		return
	}
	if !found || strings.ToLower(strings.TrimSpace(owner)) != provider {
		writeError(response, http.StatusNotFound, "account_not_found",
			"未找到 "+provider+" 账号 "+accountRef)
		return
	}

	// 探测端口未接线时必须在登记作业之前拒绝：先建作业再失败会让界面看到一条
	// 没有任何意义的失败记录。
	if handler.executor.probe == nil {
		writeError(response, http.StatusNotImplemented, "quota_refresh_unavailable",
			"Go 侧尚未接入额度探测，未刷新任何额度。")
		return
	}

	snapshot, alreadyRunning := handler.jobs.Start(request.Context(), webuirefreshjobstore.StartRequest{
		Provider:   provider,
		AccountRef: accountRef,
		Scope:      UsageJobScope,
		Run: func(ctx context.Context) (webuirefreshjobstore.Snapshot, error) {
			return handler.runUsageProbe(ctx, provider, accountRef), nil
		},
	})
	writeJSON(response, http.StatusAccepted, AsyncResponse{
		OK:             true,
		Accepted:       true,
		AlreadyRunning: alreadyRunning,
		Job:            jobFromSnapshot(snapshot),
	})
}

// runUsageProbe 在作业上下文里执行一次额度探测，把结果收敛成作业终态。
//
// 作业只表达「这次刷新有没有执行成功」：成功不校验窗口明细（额度事实以探测方
// 落库的为准），失败则把错误摘要写进 job.error——绝不把上一份快照当成功。
// 超时由执行器的 timeout 控制，探测方拿到的 ctx 一定带截止时间。
func (handler *AsyncHandler) runUsageProbe(
	ctx context.Context,
	provider string,
	accountRef string,
) webuirefreshjobstore.Snapshot {
	probeCtx, cancel := context.WithTimeout(ctx, handler.executor.timeout)
	defer cancel()
	if _, err := handler.executor.probe.ProbeQuota(probeCtx, provider, accountRef); err != nil {
		return webuirefreshjobstore.Snapshot{
			Status: webuirefreshjobstore.StatusFailed,
			Error:  truncateJobError(err.Error()),
		}
	}
	return webuirefreshjobstore.Snapshot{Status: webuirefreshjobstore.StatusSucceeded}
}

// jobFromSnapshot 把作业表快照序列化成 Node 同形 JSON。
//
// branches 只在 scope=account 时输出：额度作业没有分段明细，空表也不该出现。
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
	if snapshot.Scope != webuirefreshjobstore.ScopeAccount || len(snapshot.Branches) == 0 {
		return job
	}
	branches := make(map[string]webuirefreshjobstore.Branch, len(snapshot.Branches))
	for name, branch := range snapshot.Branches {
		branches[name] = branch
	}
	job.Branches = branches
	return job
}

// truncateJobError 按 rune 截断错误摘要，避免切断多字节字符；不追加省略号，
// 与 Node 的 slice(0, 500) 保持同样的长度口径。
func truncateJobError(message string) string {
	message = strings.TrimSpace(message)
	if message == "" {
		return "额度探测失败"
	}
	runes := []rune(message)
	if len(runes) <= maxJobErrorRunes {
		return message
	}
	return string(runes[:maxJobErrorRunes])
}
