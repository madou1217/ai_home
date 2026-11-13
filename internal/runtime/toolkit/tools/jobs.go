package tools

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

const toolJobRetention = 30 * time.Minute

// ToolJobAttempt 记录单步计划执行与验证结果。
type ToolJobAttempt struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

// ToolJobProgress 记录作业进度。
type ToolJobProgress struct {
	Percent int    `json:"percent"`
	Label   string `json:"label"`
}

// ToolJobResult 记录成功后的工具状态摘要。
type ToolJobResult struct {
	Installed      bool   `json:"installed"`
	ExecutablePath string `json:"executablePath"`
	Version        string `json:"version"`
}

// ToolJobView 对齐 Node serializeToolkitResourceJob 输出结构。
type ToolJobView struct {
	ID         string           `json:"id"`
	Source     string           `json:"source"`
	TaskName   string           `json:"taskName"`
	AppID      string           `json:"appId"`
	Provider   string           `json:"provider"`
	ToolID     string           `json:"toolId"`
	Kind       string           `json:"kind"`
	Platform   string           `json:"platform"`
	Action     string           `json:"action"`
	Status     string           `json:"status"`
	Phase      string           `json:"phase"`
	Progress   ToolJobProgress  `json:"progress"`
	Attempts   []ToolJobAttempt `json:"attempts"`
	Result     *ToolJobResult   `json:"result"`
	Error      string           `json:"error"`
	CreatedAt  int64            `json:"createdAt"`
	UpdatedAt  int64            `json:"updatedAt"`
	FinishedAt *int64           `json:"finishedAt"`
}

// ToolJobStartResult 是 Start 返回的结构。
type ToolJobStartResult struct {
	OK             bool         `json:"ok"`
	Error          string       `json:"error,omitempty"`
	Message        string       `json:"message,omitempty"`
	Accepted       bool         `json:"accepted,omitempty"`
	AlreadyRunning bool         `json:"alreadyRunning,omitempty"`
	Job            *ToolJobView `json:"job,omitempty"`
}

// ToolJobCancelResult 是 Cancel 返回的结构。
type ToolJobCancelResult struct {
	OK    bool         `json:"ok"`
	Error string       `json:"error,omitempty"`
	Job   *ToolJobView `json:"job,omitempty"`
}

// ToolJobEvent 推送给单作业或全局 SSE watcher。
type ToolJobEvent struct {
	Type string      `json:"type"`
	Job  ToolJobView `json:"job"`
}

type toolJobState struct {
	view  ToolJobView
	plans []environment.Plan
	opts  Options
}

// JobManager 管理受管工具生命周期异步作业。
type JobManager struct {
	mu              sync.Mutex
	jobs            map[string]*toolJobState
	activeByTool    map[string]string
	watchers        map[chan ToolJobEvent]struct{}
	defaultOpts     Options
	RunPlanOverride func(ctx context.Context, plan environment.Plan, opts Options) environment.RunResult
	ProbeOverride   func(ctx context.Context, toolID string, opts Options) *ToolView
}

// NewJobManager 创建受管工具作业管理器。
func NewJobManager(opts Options) *JobManager {
	return &JobManager{
		jobs:         make(map[string]*toolJobState),
		activeByTool: make(map[string]string),
		watchers:     make(map[chan ToolJobEvent]struct{}),
		defaultOpts:  opts.withDefaults(),
	}
}

func isToolJobTerminal(status string) bool {
	switch status {
	case "succeeded", "failed", "cancelled":
		return true
	}
	return false
}

func (m *JobManager) nowMillis() int64 {
	return m.defaultOpts.Now().UnixMilli()
}

func (m *JobManager) pruneLocked() {
	cutoff := m.nowMillis() - toolJobRetention.Milliseconds()
	for id, job := range m.jobs {
		if !isToolJobTerminal(job.view.Status) || job.view.FinishedAt == nil {
			continue
		}
		if *job.view.FinishedAt <= cutoff {
			delete(m.jobs, id)
		}
	}
}

func (m *JobManager) notifyLocked(view ToolJobView) {
	evt := ToolJobEvent{Type: "managed-tool-job", Job: snapshotToolJob(view)}
	for ch := range m.watchers {
		select {
		case ch <- evt:
		default:
		}
	}
}

func snapshotToolJob(v ToolJobView) ToolJobView {
	out := v
	out.Attempts = append([]ToolJobAttempt{}, v.Attempts...)
	if v.Result != nil {
		res := *v.Result
		out.Result = &res
	}
	if v.FinishedAt != nil {
		fin := *v.FinishedAt
		out.FinishedAt = &fin
	}
	return out
}

// Start 启动受管工具生命周期异步作业。
func (m *JobManager) Start(ctx context.Context, toolID string, action string, confirmed bool, optsOverride *Options) ToolJobStartResult {
	if !confirmed {
		return ToolJobStartResult{OK: false, Error: "confirmation_required"}
	}
	opts := m.defaultOpts
	if optsOverride != nil {
		opts = optsOverride.withDefaults()
	}
	planned := PlanManagedToolAction(ctx, toolID, action, opts)
	if !planned.OK || planned.Tool == nil {
		return ToolJobStartResult{
			OK:      false,
			Error:   firstNonEmpty(planned.Error, "managed_tool_plan_failed"),
			Message: planned.Message,
		}
	}
	resourceID := strings.ToLower(strings.TrimSpace(planned.Tool.ID))
	if resourceID == "" {
		return ToolJobStartResult{OK: false, Error: "managed_tool_resource_required"}
	}

	m.mu.Lock()
	m.pruneLocked()
	if activeID, ok := m.activeByTool[resourceID]; ok {
		if active, exists := m.jobs[activeID]; exists && !isToolJobTerminal(active.view.Status) {
			view := snapshotToolJob(active.view)
			m.mu.Unlock()
			return ToolJobStartResult{OK: true, Accepted: true, AlreadyRunning: true, Job: &view}
		}
		delete(m.activeByTool, resourceID)
	}

	ts := m.nowMillis()
	taskName := strings.TrimSpace(planned.Label)
	if taskName == "" {
		taskName = planned.Action + " " + planned.Tool.Name
	}
	job := &toolJobState{
		view: ToolJobView{
			ID:        "managed-tool-action-" + newToolUUID(),
			Source:    "managed-tool",
			TaskName:  taskName,
			AppID:     resourceID,
			Provider:  resourceID,
			ToolID:    resourceID,
			Kind:      "managed-tool",
			Platform:  planned.Platform,
			Action:    planned.Action,
			Status:    "queued",
			Phase:     "queued",
			Progress:  ToolJobProgress{Percent: 0, Label: "等待网络工具操作开始"},
			Attempts:  []ToolJobAttempt{},
			CreatedAt: ts,
			UpdatedAt: ts,
		},
		plans: append([]environment.Plan{}, planned.Plans...),
		opts:  opts,
	}
	m.jobs[job.view.ID] = job
	m.activeByTool[resourceID] = job.view.ID
	view := snapshotToolJob(job.view)
	m.notifyLocked(view)
	m.mu.Unlock()

	go m.run(job)
	return ToolJobStartResult{OK: true, Accepted: true, AlreadyRunning: false, Job: &view}
}

func (m *JobManager) setProgress(job *toolJobState, percent int, label string, phase string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if percent < 0 {
		percent = 0
	}
	if percent > 100 {
		percent = 100
	}
	if strings.TrimSpace(label) == "" {
		label = job.view.Progress.Label
	}
	job.view.Progress = ToolJobProgress{Percent: percent, Label: label}
	if phase != "" {
		job.view.Phase = phase
	}
	job.view.UpdatedAt = m.nowMillis()
	m.notifyLocked(job.view)
}

func (m *JobManager) run(job *toolJobState) {
	m.mu.Lock()
	job.view.Status = "running"
	job.view.Phase = "executing"
	job.view.Progress = ToolJobProgress{Percent: 5, Label: job.view.TaskName + "已开始"}
	job.view.UpdatedAt = m.nowMillis()
	m.notifyLocked(job.view)
	m.mu.Unlock()

	total := len(job.plans)
	if total < 1 {
		total = 1
	}
	for i, plan := range job.plans {
		percent := 10 + int(float64(i)/float64(total)*70)
		label := strings.TrimSpace(plan.Label)
		if label == "" {
			label = job.view.TaskName
		}
		m.setProgress(job, percent, label, "executing")

		var outcome environment.RunResult
		if m.RunPlanOverride != nil {
			outcome = m.RunPlanOverride(context.Background(), plan, job.opts)
		} else {
			outcome = RunToolPlan(context.Background(), plan, job.opts)
		}
		attempt, observed := m.verifyPlanResult(job, plan, outcome)
		m.mu.Lock()
		job.view.Attempts = append(job.view.Attempts, attempt)
		m.mu.Unlock()
		if !attempt.OK {
			continue
		}

		m.mu.Lock()
		job.view.Status = "succeeded"
		job.view.Phase = "completed"
		res := ToolJobResult{Installed: job.view.Action != "uninstall"}
		if observed != nil {
			res.ExecutablePath = observed.ExecutablePath
			res.Version = observed.Version
		}
		job.view.Result = &res
		job.view.Error = ""
		m.mu.Unlock()
		break
	}

	m.mu.Lock()
	if job.view.Status != "succeeded" {
		job.view.Status = "failed"
		job.view.Phase = "failed"
		var errs []string
		for _, a := range job.view.Attempts {
			if a.Error != "" {
				errs = append(errs, a.Error)
			}
		}
		job.view.Error = truncateJobStr(strings.Join(errs, "; "), 500)
		if job.view.Error == "" {
			job.view.Error = "网络工具操作失败。"
		}
	}
	if job.view.Status == "succeeded" {
		job.view.Progress = ToolJobProgress{Percent: 100, Label: job.view.TaskName + "完成"}
	} else {
		job.view.Progress = ToolJobProgress{Percent: job.view.Progress.Percent, Label: job.view.Error}
	}
	fin := m.nowMillis()
	job.view.UpdatedAt = fin
	job.view.FinishedAt = &fin
	delete(m.activeByTool, job.view.ToolID)
	view := snapshotToolJob(job.view)
	m.notifyLocked(view)
	m.mu.Unlock()
}

func (m *JobManager) verifyPlanResult(job *toolJobState, plan environment.Plan, outcome environment.RunResult) (ToolJobAttempt, *ToolView) {
	if !outcome.OK {
		msg := firstNonEmpty(outcome.Message, outcome.Stderr, "managed_tool_action_failed")
		return ToolJobAttempt{ID: plan.ID, Label: plan.Label, OK: false, Error: truncateJobStr(msg, 500)}, nil
	}
	var observed *ToolView
	if m.ProbeOverride != nil {
		observed = m.ProbeOverride(context.Background(), job.view.ToolID, job.opts)
	} else {
		noSvc := false
		probeOpts := job.opts
		probeOpts.IncludeService = &noSvc
		for _, t := range ListManagedTools(context.Background(), probeOpts, nil).Tools {
			if t.ID == job.view.ToolID {
				cp := t
				observed = &cp
				break
			}
		}
	}
	ok := false
	if observed != nil {
		if job.view.Action == "uninstall" {
			ok = !observed.Installed
		} else {
			ok = observed.Installed
		}
	}
	errText := ""
	if !ok {
		errText = truncateJobStr(plan.Label+" 已执行，但工具状态校验未达到预期。", 500)
	}
	return ToolJobAttempt{ID: plan.ID, Label: plan.Label, OK: ok, Error: errText}, observed
}

// Get 获取单个作业快照。
func (m *JobManager) Get(jobID string) (ToolJobView, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneLocked()
	job, ok := m.jobs[strings.TrimSpace(jobID)]
	if !ok {
		return ToolJobView{}, false
	}
	return snapshotToolJob(job.view), true
}

// ListActive 返回未进入终态的活动作业列表。
func (m *JobManager) ListActive() []ToolJobView {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneLocked()
	var list []ToolJobView
	for _, job := range m.jobs {
		if !isToolJobTerminal(job.view.Status) {
			list = append(list, snapshotToolJob(job.view))
		}
	}
	sort.Slice(list, func(i, j int) bool {
		return list[i].CreatedAt < list[j].CreatedAt
	})
	if list == nil {
		return []ToolJobView{}
	}
	return list
}

// Cancel 取消尚未开始执行的排队作业。
func (m *JobManager) Cancel(jobID string) ToolJobCancelResult {
	m.mu.Lock()
	defer m.mu.Unlock()
	job, ok := m.jobs[strings.TrimSpace(jobID)]
	if !ok {
		return ToolJobCancelResult{OK: false, Error: "job_not_found"}
	}
	if job.view.Status != "queued" {
		view := snapshotToolJob(job.view)
		return ToolJobCancelResult{OK: false, Error: "job_not_cancellable", Job: &view}
	}
	fin := m.nowMillis()
	job.view.Status = "cancelled"
	job.view.Phase = "cancelled"
	job.view.Error = "网络工具任务已取消。"
	job.view.FinishedAt = &fin
	job.view.UpdatedAt = fin
	delete(m.activeByTool, job.view.ToolID)
	view := snapshotToolJob(job.view)
	m.notifyLocked(view)
	return ToolJobCancelResult{OK: true, Job: &view}
}

// Subscribe 订阅作业事件通道。
func (m *JobManager) Subscribe() (<-chan ToolJobEvent, func()) {
	ch := make(chan ToolJobEvent, 32)
	m.mu.Lock()
	m.watchers[ch] = struct{}{}
	m.mu.Unlock()
	cancel := func() {
		m.mu.Lock()
		if _, ok := m.watchers[ch]; ok {
			delete(m.watchers, ch)
			close(ch)
		}
		m.mu.Unlock()
	}
	return ch, cancel
}

func truncateJobStr(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return s[:max]
}

func newToolUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	hx := hex.EncodeToString(b[:])
	return hx[0:8] + "-" + hx[8:12] + "-" + hx[12:16] + "-" + hx[16:20] + "-" + hx[20:32]
}
