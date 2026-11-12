package accountactivity

// 账号活动的异步执行器：WebUI 领取请求只负责「开始」，真正的签到 / 领套餐在后台
// 队列里跑。与 lib/server/account-activity-job-manager.js 同语义，状态落在 Go 进程内。
//
// 为什么必须是后台任务：ZCode 每个账号要过一次无痕验证码（约 10–20s），账号一多，
// 一个同步 HTTP 请求会轻易越过浏览器 / 代理超时；即使没超时，页面也只能干等。
//
// 队列是**全局串行**的（一个 worker）：验证码会启动本机 Chrome，账号出口也可能共用，
// 并发只会自造 429。同一个 (actionId + providers + 参数指纹) 正在跑时复用现有任务，
// 避免用户连点造成同一批账号重复领取。

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// 任务状态。
const (
	JobQueued    = "queued"
	JobRunning   = "running"
	JobSucceeded = "succeeded"
	JobPartial   = "partial"
	JobFailed    = "failed"
)

// JobRetention 是终态任务的保留时间（页面晚到的事件仍可读）。
const JobRetention = 30 * time.Minute

// MaxQueuedJobs 是排队上限：超过就明确拒绝，而不是让内存无界增长。
const MaxQueuedJobs = 64

// Target 是一次领取的目标账号；Missing 表示请求里点名了但账号不存在。
type Target struct {
	Provider   string
	AccountRef string
	Missing    bool
}

// ExecuteFunc 执行单个目标并返回结构化结果。
type ExecuteFunc func(ctx context.Context, target Target) map[string]any

// Progress 是任务进度。
type Progress struct {
	Total             int
	Completed         int
	CurrentProvider   string
	CurrentAccountRef string
}

// Job 是一个领取任务。
type Job struct {
	ID           string
	Providers    []string
	ActionID     string
	ActionLabel  string
	Params       map[string]any
	Status       string
	Phase        string
	Progress     Progress
	Results      []map[string]any
	Summary      *Summary
	Error        string
	ErrorCode    string
	ErrorSummary string
	Failures     *Failures
	CreatedAt    int64
	UpdatedAt    int64
	FinishedAt   int64

	targetKey string
	targets   []Target
	execute   ExecuteFunc
	onSettled func(*Job)
}

// JobView 是任务的线上形状（字段名与 Node serializeJob 逐字一致）。
type JobView struct {
	ID           string           `json:"id"`
	Providers    []string         `json:"providers"`
	ActionID     string           `json:"actionId"`
	ActionLabel  string           `json:"actionLabel"`
	Params       map[string]any   `json:"params"`
	Status       string           `json:"status"`
	Phase        string           `json:"phase"`
	Progress     ProgressView     `json:"progress"`
	Results      []map[string]any `json:"results"`
	Summary      *Summary         `json:"summary"`
	Error        string           `json:"error"`
	ErrorCode    string           `json:"errorCode"`
	ErrorSummary string           `json:"errorSummary"`
	Failures     *Failures        `json:"failures"`
	CreatedAt    int64            `json:"createdAt"`
	UpdatedAt    int64            `json:"updatedAt"`
	FinishedAt   *int64           `json:"finishedAt"`
}

// ProgressView 是进度的线上形状。
type ProgressView struct {
	Total             int    `json:"total"`
	Completed         int    `json:"completed"`
	Percent           int    `json:"percent"`
	CurrentProvider   string `json:"currentProvider"`
	CurrentAccountRef string `json:"currentAccountRef"`
}

// IsTerminalStatus 判断任务是否已经结束。
func IsTerminalStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case JobSucceeded, JobPartial, JobFailed:
		return true
	default:
		return false
	}
}

// View 返回可序列化的任务快照。
func (job *Job) View() JobView {
	if job == nil {
		return JobView{}
	}
	total := job.Progress.Total
	completed := job.Progress.Completed
	if completed > total {
		completed = total
	}
	percent := 0
	if total > 0 {
		percent = int(float64(completed)/float64(total)*100 + 0.5)
	}
	view := JobView{
		ID:           job.ID,
		Providers:    append([]string(nil), job.Providers...),
		ActionID:     job.ActionID,
		ActionLabel:  job.ActionLabel,
		Params:       copyParams(job.Params),
		Status:       job.Status,
		Phase:        job.Phase,
		Progress:     ProgressView{Total: total, Completed: completed, Percent: percent, CurrentProvider: job.Progress.CurrentProvider, CurrentAccountRef: job.Progress.CurrentAccountRef},
		Results:      append([]map[string]any{}, job.Results...),
		Summary:      job.Summary,
		Error:        job.Error,
		ErrorCode:    job.ErrorCode,
		ErrorSummary: job.ErrorSummary,
		Failures:     job.Failures,
		CreatedAt:    job.CreatedAt,
		UpdatedAt:    job.UpdatedAt,
	}
	if job.FinishedAt > 0 {
		finished := job.FinishedAt
		view.FinishedAt = &finished
	}
	return view
}

// StartRequest 是开始任务的输入。
type StartRequest struct {
	Providers   []string
	ActionID    string
	ActionLabel string
	Params      map[string]any
	Targets     []Target
	Execute     ExecuteFunc
	// OnSettled 在任务结算后调用，用来释放跨路径运行权。
	OnSettled func(*Job)
}

// StartResult 是开始任务的结果。
type StartResult struct {
	AlreadyRunning bool
	Job            JobView
}

// JobManager 是进程内的任务队列。
type JobManager struct {
	mu        sync.Mutex
	jobs      map[string]*Job
	queue     chan *Job
	retention time.Duration
	now       func() time.Time
	onChanged func(JobView)
	startOnce sync.Once
}

// NewJobManager 创建任务队列。
func NewJobManager(now func() time.Time, onChanged func(JobView)) *JobManager {
	if now == nil {
		now = time.Now
	}
	return &JobManager{
		jobs:      map[string]*Job{},
		queue:     make(chan *Job, MaxQueuedJobs),
		retention: JobRetention,
		now:       now,
		onChanged: onChanged,
	}
}

func (manager *JobManager) change(job JobView) {
	if manager.onChanged == nil {
		return
	}
	defer func() { _ = recover() }()
	manager.onChanged(job)
}

// Start 入队一个任务；同一目标键存在未结束任务时复用。
func (manager *JobManager) Start(request StartRequest) (StartResult, string) {
	providers := normalizeProviders(request.Providers)
	actionID := strings.ToLower(strings.TrimSpace(request.ActionID))
	if len(providers) == 0 || actionID == "" || len(request.Targets) == 0 {
		return StartResult{}, "activity_selection_empty"
	}
	params := copyParams(request.Params)
	targetKey := targetKeyOf(actionID, providers, params)
	manager.prune()
	manager.mu.Lock()
	for _, job := range manager.jobs {
		if IsTerminalStatus(job.Status) {
			continue
		}
		if job.targetKey == targetKey {
			view := job.View()
			manager.mu.Unlock()
			return StartResult{AlreadyRunning: true, Job: view}, ""
		}
	}
	timestamp := manager.now().UnixMilli()
	job := &Job{
		ID:          "activity-job-" + newJobID(),
		Providers:   providers,
		ActionID:    actionID,
		ActionLabel: request.ActionLabel,
		Params:      params,
		Status:      JobQueued,
		Phase:       JobQueued,
		Progress:    Progress{Total: len(request.Targets)},
		Results:     []map[string]any{},
		CreatedAt:   timestamp,
		UpdatedAt:   timestamp,
		targetKey:   targetKey,
		targets:     append([]Target(nil), request.Targets...),
		execute:     request.Execute,
		onSettled:   request.OnSettled,
	}
	if job.ActionLabel == "" {
		job.ActionLabel = actionID
	}
	manager.jobs[job.ID] = job
	view := job.View()
	manager.mu.Unlock()

	select {
	case manager.queue <- job:
	default:
		manager.mu.Lock()
		delete(manager.jobs, job.ID)
		manager.mu.Unlock()
		return StartResult{}, "activity_queue_full"
	}
	manager.change(view)
	manager.startOnce.Do(func() { go manager.work() })
	return StartResult{Job: view}, ""
}

// Get 读取任务快照。
func (manager *JobManager) Get(jobID string) (JobView, bool) {
	manager.prune()
	manager.mu.Lock()
	defer manager.mu.Unlock()
	job := manager.jobs[strings.TrimSpace(jobID)]
	if job == nil {
		return JobView{}, false
	}
	return job.View(), true
}

// ListActive 返回未结束任务（按创建时间升序）。
func (manager *JobManager) ListActive() []JobView {
	manager.prune()
	manager.mu.Lock()
	defer manager.mu.Unlock()
	views := make([]JobView, 0, len(manager.jobs))
	for _, job := range manager.jobs {
		if IsTerminalStatus(job.Status) {
			continue
		}
		views = append(views, job.View())
	}
	sort.Slice(views, func(left, right int) bool {
		if views[left].CreatedAt != views[right].CreatedAt {
			return views[left].CreatedAt < views[right].CreatedAt
		}
		return views[left].ID < views[right].ID
	})
	return views
}

func (manager *JobManager) prune() {
	cutoff := manager.now().Add(-manager.retention).UnixMilli()
	manager.mu.Lock()
	defer manager.mu.Unlock()
	for id, job := range manager.jobs {
		if !IsTerminalStatus(job.Status) || job.FinishedAt > cutoff {
			continue
		}
		delete(manager.jobs, id)
	}
}

func (manager *JobManager) work() {
	for job := range manager.queue {
		manager.run(job)
	}
}

func (manager *JobManager) run(job *Job) {
	manager.mu.Lock()
	job.Status = JobRunning
	job.Phase = "claiming"
	job.UpdatedAt = manager.now().UnixMilli()
	view := job.View()
	manager.mu.Unlock()
	manager.change(view)

	defer func() {
		manager.mu.Lock()
		job.Progress.CurrentProvider = ""
		job.Progress.CurrentAccountRef = ""
		job.UpdatedAt = manager.now().UnixMilli()
		job.FinishedAt = job.UpdatedAt
		job.execute = nil
		job.targets = nil
		settled := job.onSettled
		job.onSettled = nil
		resultView := job.View()
		manager.mu.Unlock()
		manager.change(resultView)
		if settled != nil {
			func() {
				defer func() { _ = recover() }()
				settled(job)
			}()
		}
	}()

	executed := make([]map[string]any, 0, len(job.targets))
	for _, target := range job.targets {
		manager.mu.Lock()
		job.Progress.CurrentProvider = target.Provider
		job.Progress.CurrentAccountRef = target.AccountRef
		job.UpdatedAt = manager.now().UnixMilli()
		progressView := job.View()
		manager.mu.Unlock()
		manager.change(progressView)

		result := manager.executeTarget(job, target)
		errorCode := ErrorCodeOf(result)
		if errorCode != "" {
			result["errorCode"] = errorCode
		}
		executed = append(executed, result)

		manager.mu.Lock()
		job.Results = append(job.Results, result)
		job.Progress.Completed++
		job.UpdatedAt = manager.now().UnixMilli()
		stepView := job.View()
		manager.mu.Unlock()
		manager.change(stepView)
	}

	summary := Summarize(executed)
	manager.mu.Lock()
	job.Summary = &summary
	failures := summary.Failures
	job.Failures = &failures
	job.ErrorSummary = summary.ErrorSummary
	job.ErrorCode = DominantErrorCode(summary)
	switch {
	case summary.Failed == 0:
		job.Status = JobSucceeded
		job.Phase = "completed"
	case summary.Failed < summary.Accounts:
		job.Status = JobPartial
		job.Phase = "completed"
	default:
		job.Status = JobFailed
		job.Phase = "failed"
		job.Error = "all_accounts_failed"
	}
	job.UpdatedAt = manager.now().UnixMilli()
	summaryView := job.View()
	manager.mu.Unlock()
	manager.change(summaryView)
}

func (manager *JobManager) executeTarget(job *Job, target Target) (result map[string]any) {
	execute := job.execute
	if execute == nil {
		return failureResult(target, job.ActionID, "activity_empty_result")
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			result = failureResult(target, job.ActionID, "activity_failed:panic")
		}
	}()
	produced := execute(context.Background(), target)
	return normalizeResult(target, job.ActionID, produced)
}

func failureResult(target Target, actionID string, code string) map[string]any {
	return map[string]any{
		"provider":   target.Provider,
		"accountRef": target.AccountRef,
		"actionId":   actionID,
		"status":     StatusError,
		"error":      code,
	}
}

func normalizeResult(target Target, actionID string, produced map[string]any) map[string]any {
	if produced == nil {
		return failureResult(target, actionID, "activity_empty_result")
	}
	result := produced
	if strings.TrimSpace(textOf(result["provider"])) == "" {
		result["provider"] = target.Provider
	}
	if strings.TrimSpace(textOf(result["accountRef"])) == "" {
		result["accountRef"] = target.AccountRef
	}
	if strings.TrimSpace(textOf(result["actionId"])) == "" {
		result["actionId"] = actionID
	}
	if strings.TrimSpace(textOf(result["status"])) == "" {
		result["status"] = StatusError
		result["error"] = "activity_empty_result"
	}
	return result
}

func normalizeProviders(providers []string) []string {
	seen := map[string]struct{}{}
	normalized := make([]string, 0, len(providers))
	for _, provider := range providers {
		key := strings.ToLower(strings.TrimSpace(provider))
		if key == "" {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		normalized = append(normalized, key)
	}
	sort.Strings(normalized)
	return normalized
}

func targetKeyOf(actionID string, providers []string, params map[string]any) string {
	fingerprint := StableFingerprint(params)
	key := actionID + ":" + strings.Join(providers, ",")
	if fingerprint == "" {
		return key
	}
	return key + "#" + fingerprint
}

func copyParams(params map[string]any) map[string]any {
	if len(params) == 0 {
		return map[string]any{}
	}
	copied := make(map[string]any, len(params))
	for key, value := range params {
		copied[key] = value
	}
	return copied
}

func newJobID() string {
	var buffer [16]byte
	if _, err := rand.Read(buffer[:]); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 16)
	}
	return hex.EncodeToString(buffer[:])
}
