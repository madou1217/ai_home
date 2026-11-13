package environment

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sort"
	"strings"
	"sync"
	"time"
)

// JobRetention 与 Node JOB_RETENTION_MS 一致：终态任务保留 30 分钟。
const JobRetention = 30 * time.Minute

// JobEnvironment 是一个执行目标交给作业管理器的事实集合。
//
// 本机与 SSH 远端只在「怎么探测、怎么跑计划」上不同；作业状态机、去重、
// 校验与事件都在作业管理器里，只有一份。
type JobEnvironment struct {
	Key   string
	Kind  string
	Label string
	// Host 返回探测用的宿主视图（远端每次重新构造快照）。
	Host func(ctx context.Context) (Host, error)
	// Refresh 丢弃探测快照（执行后复查必须看到新状态）。
	Refresh func()
	// Run 执行一个计划；onOutput 把流式输出交给作业进度。
	Run func(ctx context.Context, plan Plan, onOutput func(stream string, chunk string)) RunResult
}

// JobAttempt 是回退链里单条计划的执行与校验结果。
type JobAttempt struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

// JobProgress 是作业进度。
type JobProgress struct {
	Percent int    `json:"percent"`
	Label   string `json:"label"`
}

// JobResult 是成功后的工具状态摘要。
type JobResult struct {
	Installed      bool   `json:"installed"`
	ExecutablePath string `json:"executablePath"`
	Version        string `json:"version"`
}

// JobView 是作业的公开快照（字段与 Node serializeEnvironmentJob 逐字段一致）。
type JobView struct {
	ID          string       `json:"id"`
	Source      string       `json:"source"`
	TaskName    string       `json:"taskName"`
	AppID       string       `json:"appId"`
	Provider    string       `json:"provider"`
	ToolID      string       `json:"toolId"`
	Kind        string       `json:"kind"`
	Target      string       `json:"target"`
	TargetLabel string       `json:"targetLabel"`
	Platform    string       `json:"platform"`
	Action      string       `json:"action"`
	Status      string       `json:"status"`
	Phase       string       `json:"phase"`
	Progress    JobProgress  `json:"progress"`
	Attempts    []JobAttempt `json:"attempts"`
	Result      *JobResult   `json:"result"`
	Error       string       `json:"error"`
	CreatedAt   int64        `json:"createdAt"`
	UpdatedAt   int64        `json:"updatedAt"`
	FinishedAt  *int64       `json:"finishedAt"`
}

// JobStartResult 是 POST /environments/execute（按工具）的响应。
type JobStartResult struct {
	OK             bool     `json:"ok"`
	Accepted       bool     `json:"accepted,omitempty"`
	AlreadyRunning bool     `json:"alreadyRunning,omitempty"`
	Error          string   `json:"error,omitempty"`
	Message        string   `json:"message,omitempty"`
	Job            *JobView `json:"job,omitempty"`
}

// JobCancelResult 是取消作业的响应。
type JobCancelResult struct {
	OK    bool     `json:"ok"`
	Error string   `json:"error,omitempty"`
	Job   *JobView `json:"job"`
}

type jobState struct {
	view        JobView
	toolID      string
	activeKey   string
	environment JobEnvironment
	plans       []Plan
}

// JobEvent 是作业变更事件（SSE 帧与 Node 任务队列桥共用）。
type JobEvent struct {
	Type string  `json:"type"`
	Job  JobView `json:"job"`
}

// JobManager 持有运行中的环境作业。
type JobManager struct {
	mu        sync.Mutex
	jobs      map[string]*jobState
	active    map[string]string
	watchers  map[chan JobEvent]struct{}
	now       func() time.Time
	retention time.Duration
}

// NewJobManager 创建作业管理器。
func NewJobManager() *JobManager {
	return &JobManager{
		jobs:      map[string]*jobState{},
		active:    map[string]string{},
		watchers:  map[chan JobEvent]struct{}{},
		now:       time.Now,
		retention: JobRetention,
	}
}

func (manager *JobManager) timestamp() int64 { return manager.now().UnixMilli() }

func isTerminalStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "succeeded", "failed", "cancelled":
		return true
	}
	return false
}

func (manager *JobManager) pruneLocked() {
	cutoff := manager.timestamp() - manager.retention.Milliseconds()
	for id, job := range manager.jobs {
		if !isTerminalStatus(job.view.Status) {
			continue
		}
		if job.view.FinishedAt != nil && *job.view.FinishedAt > cutoff {
			continue
		}
		delete(manager.jobs, id)
	}
}

func (manager *JobManager) notifyLocked(job JobView) {
	if len(manager.watchers) == 0 {
		return
	}
	event := JobEvent{Type: "environment-job", Job: job}
	for watcher := range manager.watchers {
		select {
		case watcher <- event:
		default:
			// 慢消费者不阻塞作业：丢一帧，下一次变更会带完整快照。
		}
	}
}

func (manager *JobManager) publish(job JobView) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	manager.notifyLocked(job)
}

func (manager *JobManager) setProgress(job *jobState, percent int, label string, phase string) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}
	if strings.TrimSpace(label) == "" {
		label = job.view.Progress.Label
	}
	job.view.Progress = JobProgress{Percent: percent, Label: label}
	if phase != "" {
		job.view.Phase = phase
	}
	job.view.UpdatedAt = manager.timestamp()
	manager.notifyLocked(job.view)
}

func (manager *JobManager) snapshot(job *jobState) JobView {
	view := job.view
	view.Attempts = append([]JobAttempt{}, job.view.Attempts...)
	if job.view.Result != nil {
		result := *job.view.Result
		view.Result = &result
	}
	if job.view.FinishedAt != nil {
		finished := *job.view.FinishedAt
		view.FinishedAt = &finished
	}
	return view
}

// Start 按工具启动异步作业；同一目标 + 工具只允许一个运行中的作业。
func (manager *JobManager) Start(ctx context.Context, environment JobEnvironment, input ToolInput, confirmed bool) (JobStartResult, error) {
	if !confirmed {
		return JobStartResult{OK: false, Error: "confirmation_required"}, nil
	}
	host, err := environment.Host(ctx)
	if err != nil {
		return JobStartResult{OK: false, Error: "environment_host_unavailable", Message: err.Error()}, nil
	}
	buildOptions := BuildOptions{Platform: host.Platform, HomeDir: host.HomeDir}
	planned := PlanToolAction(ctx, input, host, buildOptions)
	if !planned.OK {
		return JobStartResult{OK: false, Error: planned.Error, Message: planned.Message}, nil
	}
	if planned.Tool == nil {
		return JobStartResult{OK: false, Error: "environment_tool_not_found", Message: "运行环境工具不存在。"}, nil
	}
	toolID := strings.ToLower(strings.TrimSpace(planned.Tool.ID))
	activeKey := environment.Key + "\x00" + toolID
	manager.mu.Lock()
	manager.pruneLocked()
	if activeID, exists := manager.active[activeKey]; exists {
		if active, ok := manager.jobs[activeID]; ok && !isTerminalStatus(active.view.Status) {
			view := manager.snapshot(active)
			manager.mu.Unlock()
			return JobStartResult{OK: true, Accepted: true, AlreadyRunning: true, Job: &view}, nil
		}
		delete(manager.active, activeKey)
	}
	taskName := planned.Label
	if taskName == "" {
		taskName = planned.Action + " " + planned.Tool.Name
	}
	if environment.Kind != "" && environment.Kind != "local" && environment.Label != "" {
		taskName = taskName + "（" + environment.Label + "）"
	}
	now := manager.timestamp()
	targetLabel := ""
	targetKey := environment.Key
	if targetKey == "" {
		targetKey = "local"
	}
	if environment.Kind != "" && environment.Kind != "local" {
		targetLabel = environment.Label
	}
	job := &jobState{
		view: JobView{
			ID:          "environment-action-" + newUUID(),
			Source:      "environment",
			TaskName:    taskName,
			AppID:       toolID,
			Provider:    toolID,
			ToolID:      toolID,
			Kind:        "environment",
			Target:      targetKey,
			TargetLabel: targetLabel,
			Platform:    planned.Platform,
			Action:      planned.Action,
			Status:      "queued",
			Phase:       "queued",
			Progress:    JobProgress{Percent: 0, Label: "等待运行环境操作开始"},
			Attempts:    []JobAttempt{},
			CreatedAt:   now,
			UpdatedAt:   now,
		},
		toolID:      toolID,
		activeKey:   activeKey,
		environment: environment,
		plans:       planned.Plans,
	}
	manager.jobs[job.view.ID] = job
	manager.active[activeKey] = job.view.ID
	view := manager.snapshot(job)
	manager.notifyLocked(view)
	manager.mu.Unlock()

	go manager.run(job)
	return JobStartResult{OK: true, Accepted: true, AlreadyRunning: false, Job: &view}, nil
}

func (manager *JobManager) run(job *jobState) {
	manager.mu.Lock()
	job.view.Status = "running"
	job.view.Phase = "executing"
	job.view.Progress = JobProgress{Percent: 5, Label: job.view.TaskName + "已开始"}
	job.view.UpdatedAt = manager.timestamp()
	manager.notifyLocked(job.view)
	manager.mu.Unlock()
	tool, _ := ToolByID(job.toolID)
	for index, plan := range job.plans {
		percent := 10 + int(float64(index)/float64(maxInt(len(job.plans), 1))*70)
		manager.setProgress(job, percent, plan.Label, "executing")
		outcome := job.environment.Run(context.Background(), plan, func(stream string, chunk string) {})
		attempt := manager.verify(job, tool, plan, outcome)
		manager.mu.Lock()
		job.view.Attempts = append(job.view.Attempts, attempt)
		manager.mu.Unlock()
		if !attempt.OK {
			continue
		}
		observed, observedOK := manager.observe(job, tool)
		manager.mu.Lock()
		job.view.Status = "succeeded"
		job.view.Phase = "completed"
		result := JobResult{Installed: job.view.Action != "uninstall"}
		if observedOK {
			result.ExecutablePath = observed.ExecutablePath
			result.Version = observed.Version
		}
		job.view.Result = &result
		job.view.Error = ""
		manager.mu.Unlock()
		break
	}
	manager.mu.Lock()
	if job.view.Status != "succeeded" {
		job.view.Status = "failed"
		job.view.Phase = "failed"
		messages := make([]string, 0, len(job.view.Attempts))
		for _, attempt := range job.view.Attempts {
			if attempt.Error != "" {
				messages = append(messages, attempt.Error)
			}
		}
		job.view.Error = strings.Join(messages, "; ")
		if job.view.Error == "" {
			job.view.Error = "运行环境操作失败。"
		}
	}
	if job.view.Status == "succeeded" {
		job.view.Progress = JobProgress{Percent: 100, Label: job.view.TaskName + "完成"}
	} else {
		job.view.Progress = JobProgress{Percent: job.view.Progress.Percent, Label: job.view.Error}
	}
	finished := manager.timestamp()
	job.view.UpdatedAt = finished
	job.view.FinishedAt = &finished
	delete(manager.active, job.activeKey)
	view := manager.snapshot(job)
	manager.notifyLocked(view)
	manager.mu.Unlock()
}

// observe 重新探测工具状态；失败时返回 false（校验失败而不是作业崩溃）。
func (manager *JobManager) observe(job *jobState, tool ToolSpec) (ProbeResult, bool) {
	if job.environment.Refresh != nil {
		job.environment.Refresh()
	}
	host, err := job.environment.Host(context.Background())
	if err != nil {
		return ProbeResult{}, false
	}
	return Probe(context.Background(), tool, host), true
}

// verify 判定一条计划是否达到期望状态。
func (manager *JobManager) verify(job *jobState, tool ToolSpec, plan Plan, outcome RunResult) JobAttempt {
	if !outcome.OK {
		message := outcome.Message
		if message == "" {
			message = outcome.Stderr
		}
		if message == "" {
			message = "environment_action_failed"
		}
		return JobAttempt{ID: plan.ID, Label: plan.Label, OK: false, Error: truncate(message, 500)}
	}
	observed, ok := manager.observe(job, tool)
	if !ok {
		return JobAttempt{
			ID: plan.ID, Label: plan.Label, OK: false,
			Error: truncate(plan.Label+" 已执行，但工具状态校验失败：无法重新探测运行环境", 500),
		}
	}
	reached := observed.Installed
	if job.view.Action == "uninstall" {
		reached = !observed.Installed
	}
	if !reached {
		return JobAttempt{
			ID: plan.ID, Label: plan.Label, OK: false,
			Error: truncate(plan.Label+" 已执行，但工具状态校验未达到预期。", 500),
		}
	}
	return JobAttempt{ID: plan.ID, Label: plan.Label, OK: true}
}

// Get 返回单个作业快照。
func (manager *JobManager) Get(jobID string) (JobView, bool) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	manager.pruneLocked()
	job, ok := manager.jobs[strings.TrimSpace(jobID)]
	if !ok {
		return JobView{}, false
	}
	return manager.snapshot(job), true
}

// ListActive 返回全部未结束作业（按创建时间升序，与 Node 一致）。
func (manager *JobManager) ListActive() []JobView {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	manager.pruneLocked()
	result := make([]JobView, 0, len(manager.jobs))
	for _, job := range manager.jobs {
		if isTerminalStatus(job.view.Status) {
			continue
		}
		result = append(result, manager.snapshot(job))
	}
	sort.SliceStable(result, func(left, right int) bool {
		if result[left].CreatedAt == result[right].CreatedAt {
			return result[left].ID < result[right].ID
		}
		return result[left].CreatedAt < result[right].CreatedAt
	})
	return result
}

// Cancel 取消尚未开始的作业；运行中的作业不可取消（与 Node 一致）。
func (manager *JobManager) Cancel(jobID string) JobCancelResult {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	job, ok := manager.jobs[strings.TrimSpace(jobID)]
	if !ok {
		return JobCancelResult{OK: false, Error: "job_not_found"}
	}
	if job.view.Status != "queued" {
		view := manager.snapshot(job)
		return JobCancelResult{OK: false, Error: "job_not_cancellable", Job: &view}
	}
	job.view.Status = "cancelled"
	job.view.Phase = "cancelled"
	job.view.Error = "运行环境任务已取消。"
	finished := manager.timestamp()
	job.view.FinishedAt = &finished
	job.view.UpdatedAt = finished
	delete(manager.active, job.activeKey)
	view := manager.snapshot(job)
	manager.notifyLocked(view)
	return JobCancelResult{OK: true, Job: &view}
}

// Subscribe 订阅作业变更；返回取消函数。
func (manager *JobManager) Subscribe() (<-chan JobEvent, func()) {
	ch := make(chan JobEvent, 32)
	manager.mu.Lock()
	manager.watchers[ch] = struct{}{}
	manager.mu.Unlock()
	cancel := func() {
		manager.mu.Lock()
		if _, ok := manager.watchers[ch]; ok {
			delete(manager.watchers, ch)
			close(ch)
		}
		manager.mu.Unlock()
	}
	return ch, cancel
}

func truncate(value string, limit int) string {
	value = strings.TrimSpace(value)
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

func maxInt(left int, right int) int {
	if left > right {
		return left
	}
	return right
}

// newUUID 生成 v4 UUID（与 Node crypto.randomUUID 同格式）。
func newUUID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		// 随机源不可用时应立即失败，而不是生成可预测的 ID。
		panic("environment: crypto/rand unavailable: " + err.Error())
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	encoded := hex.EncodeToString(bytes[:])
	return encoded[0:8] + "-" + encoded[8:12] + "-" + encoded[12:16] + "-" + encoded[16:20] + "-" + encoded[20:32]
}
