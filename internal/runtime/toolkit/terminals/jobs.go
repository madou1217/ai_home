package terminals

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"sync"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

const jobRetentionMillis = int64(30 * 60 * 1000)

// JobProgress 表示终端异步作业进度。
type JobProgress struct {
	Percent int    `json:"percent"`
	Label   string `json:"label"`
}

// JobOutcome 是终端异步作业完成后的 result 字段结构（未完成时为 null）。
type JobOutcome struct {
	Installed      bool   `json:"installed"`
	ExecutablePath string `json:"executablePath"`
}

// Job 是客户端终端安装/更新/卸载异步作业快照，字段与原 Node client-terminal-job-manager 对齐。
type Job struct {
	ID         string      `json:"id"`
	Source     string      `json:"source"`
	TaskName   string      `json:"taskName"`
	AppID      string      `json:"appId"`
	Provider   string      `json:"provider"`
	Kind       string      `json:"kind"`
	Action     string      `json:"action"`
	Status     string      `json:"status"`
	Phase      string      `json:"phase"`
	Progress   JobProgress `json:"progress"`
	Attempts   []any       `json:"attempts"`
	Result     *JobOutcome `json:"result"`
	Error      string      `json:"error"`
	CreatedAt  int64       `json:"createdAt"`
	UpdatedAt  int64       `json:"updatedAt"`
	FinishedAt *int64      `json:"finishedAt"`
}

// StartRequest 描述启动终端动作异步作业的输入。
type StartRequest struct {
	TerminalID string `json:"terminalId"`
	Action     string `json:"action"`
	Confirmed  bool   `json:"confirmed"`
}

// StartResult 是 POST /toolkit/terminals/execute 的响应体。
type StartResult struct {
	OK             bool   `json:"ok"`
	Accepted       bool   `json:"accepted,omitempty"`
	AlreadyRunning bool   `json:"alreadyRunning,omitempty"`
	Error          string `json:"error,omitempty"`
	Job            *Job   `json:"job,omitempty"`
}

type jobEntry struct {
	job        Job
	terminalID string
	plan       ActionPlan
}

// JobManager 负责管理客户端终端生命周期异步作业、状态广播与活跃任务汇总。
type JobManager struct {
	opts           Options
	mu             sync.Mutex
	jobs           map[string]*jobEntry
	activeByTarget map[string]string
	watchers       map[string]map[chan Job]struct{}
	allWatchers    map[chan Job]struct{}
	onJobChanged   func(Job)
}

// NewJobManager 创建客户端终端作业管理器。
func NewJobManager(opts Options) *JobManager {
	return &JobManager{
		opts:           opts.withDefaults(),
		jobs:           make(map[string]*jobEntry),
		activeByTarget: make(map[string]string),
		watchers:       make(map[string]map[chan Job]struct{}),
		allWatchers:    make(map[chan Job]struct{}),
	}
}

// SetOnJobChanged 注册作业变更回调（供统一任务中心实时同步使用）。
func (m *JobManager) SetOnJobChanged(fn func(Job)) {
	m.mu.Lock()
	m.onJobChanged = fn
	m.mu.Unlock()
}

func isJobTerminalStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "succeeded", "failed", "cancelled":
		return true
	default:
		return false
	}
}

func cloneJob(src Job) Job {
	out := src
	out.Attempts = []any{}
	if src.Result != nil {
		r := *src.Result
		out.Result = &r
	}
	if src.FinishedAt != nil {
		f := *src.FinishedAt
		out.FinishedAt = &f
	}
	return out
}

func (m *JobManager) pruneLocked(nowMs int64) {
	cutoff := nowMs - jobRetentionMillis
	for id, entry := range m.jobs {
		if !isJobTerminalStatus(entry.job.Status) {
			continue
		}
		if entry.job.FinishedAt == nil || *entry.job.FinishedAt > cutoff {
			continue
		}
		delete(m.jobs, id)
	}
}

func (m *JobManager) notify(snap Job, fn func(Job), subs []chan Job, global []chan Job) {
	if fn != nil {
		fn(cloneJob(snap))
	}
	for _, ch := range subs {
		select {
		case ch <- cloneJob(snap):
		default:
		}
	}
	for _, ch := range global {
		select {
		case ch <- cloneJob(snap):
		default:
		}
	}
}

func (m *JobManager) collectSubscribersLocked(jobID string) (func(Job), []chan Job, []chan Job) {
	var subs []chan Job
	if set := m.watchers[jobID]; len(set) > 0 {
		subs = make([]chan Job, 0, len(set))
		for ch := range set {
			subs = append(subs, ch)
		}
	}
	var global []chan Job
	if len(m.allWatchers) > 0 {
		global = make([]chan Job, 0, len(m.allWatchers))
		for ch := range m.allWatchers {
			global = append(global, ch)
		}
	}
	return m.onJobChanged, subs, global
}

// Start 校验确认与动作计划并异步执行终端安装/更新/卸载。
func (m *JobManager) Start(ctx context.Context, req StartRequest) StartResult {
	if !req.Confirmed {
		return StartResult{OK: false, Error: "confirmation_required"}
	}
	normID := strings.ToLower(strings.TrimSpace(req.TerminalID))
	normAction := strings.ToLower(strings.TrimSpace(req.Action))
	plan := ResolveTerminalActionPlan(normID, normAction, m.opts)
	if !plan.OK {
		return StartResult{OK: false, Error: plan.Error}
	}

	targetKey := normID + ":" + normAction
	nowMs := m.opts.Now()

	m.mu.Lock()
	m.pruneLocked(nowMs)
	if activeID, ok := m.activeByTarget[targetKey]; ok {
		if existing := m.jobs[activeID]; existing != nil && !isJobTerminalStatus(existing.job.Status) {
			snap := cloneJob(existing.job)
			m.mu.Unlock()
			return StartResult{OK: true, Accepted: true, AlreadyRunning: true, Job: &snap}
		}
		delete(m.activeByTarget, targetKey)
	}

	jobID := "terminal-action-" + newTerminalUUID()
	entry := &jobEntry{
		terminalID: normID,
		plan:       plan,
		job: Job{
			ID:        jobID,
			Source:    "terminal",
			TaskName:  firstNonEmpty(plan.Label, normAction+" "+normID),
			AppID:     normID,
			Provider:  normID,
			Kind:      "terminal",
			Action:    normAction,
			Status:    "queued",
			Phase:     "queued",
			Progress:  JobProgress{Percent: 0, Label: "等待终端操作开始"},
			Attempts:  []any{},
			CreatedAt: nowMs,
			UpdatedAt: nowMs,
		},
	}
	m.jobs[jobID] = entry
	m.activeByTarget[targetKey] = jobID
	snap := cloneJob(entry.job)
	fn, subs, global := m.collectSubscribersLocked(jobID)
	m.mu.Unlock()

	m.notify(snap, fn, subs, global)
	go m.run(ctx, entry, targetKey)
	return StartResult{OK: true, Accepted: true, AlreadyRunning: false, Job: &snap}
}

func (m *JobManager) run(_ context.Context, entry *jobEntry, targetKey string) {
	jobID := entry.job.ID
	m.mu.Lock()
	entry.job.Status = "running"
	entry.job.Phase = "executing"
	entry.job.Progress = JobProgress{Percent: 10, Label: "正在执行官方终端命令"}
	entry.job.UpdatedAt = m.opts.Now()
	snap := cloneJob(entry.job)
	fn, subs, global := m.collectSubscribersLocked(jobID)
	m.mu.Unlock()
	m.notify(snap, fn, subs, global)

	errMsg := m.executePlan(context.Background(), entry.plan)

	finished := m.opts.Now()
	m.mu.Lock()
	if errMsg == "" {
		entry.job.Status = "succeeded"
		entry.job.Phase = "completed"
		entry.job.Result = &JobOutcome{Installed: true}
		entry.job.Error = ""
		entry.job.Progress = JobProgress{Percent: 100, Label: "终端操作完成"}
	} else {
		if len(errMsg) > 500 {
			errMsg = errMsg[:500]
		}
		entry.job.Status = "failed"
		entry.job.Phase = "failed"
		entry.job.Error = errMsg
		entry.job.Progress = JobProgress{Percent: entry.job.Progress.Percent, Label: errMsg}
	}
	entry.job.UpdatedAt = finished
	entry.job.FinishedAt = &finished
	delete(m.activeByTarget, targetKey)
	finalSnap := cloneJob(entry.job)
	fn, subs, global = m.collectSubscribersLocked(jobID)
	m.mu.Unlock()
	m.notify(finalSnap, fn, subs, global)
}

func (m *JobManager) executePlan(ctx context.Context, plan ActionPlan) string {
	if m.opts.Exec != nil {
		res := m.opts.Exec.Run(ctx, plan.File, append([]string(nil), plan.Args...), environment.ExecOptions{})
		if res.OK {
			return ""
		}
		if res.ExitCode != nil {
			return fmt.Sprintf("terminal_action_exit_%d", *res.ExitCode)
		}
		return firstNonEmpty(strings.TrimSpace(res.Message), strings.TrimSpace(res.Stderr), "terminal_action_failed")
	}
	cmd := exec.CommandContext(ctx, plan.File, plan.Args...)
	if err := cmd.Run(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return fmt.Sprintf("terminal_action_exit_%d", exitErr.ExitCode())
		}
		return err.Error()
	}
	return ""
}

// Get 返回指定作业快照；不存在返回 nil。
func (m *JobManager) Get(jobID string) *Job {
	norm := strings.TrimSpace(jobID)
	nowMs := m.opts.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneLocked(nowMs)
	entry := m.jobs[norm]
	if entry == nil {
		return nil
	}
	snap := cloneJob(entry.job)
	return &snap
}

// ListActive 按创建时间升序返回全部未完成终端作业。
func (m *JobManager) ListActive() []Job {
	nowMs := m.opts.Now()
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneLocked(nowMs)
	out := make([]Job, 0)
	for _, entry := range m.jobs {
		if !isJobTerminalStatus(entry.job.Status) {
			out = append(out, cloneJob(entry.job))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].CreatedAt < out[j].CreatedAt
	})
	return out
}

// Subscribe 订阅单个终端作业的 SSE 事件推送。
func (m *JobManager) Subscribe(jobID string) (<-chan Job, func(), bool) {
	norm := strings.TrimSpace(jobID)
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.jobs[norm] == nil {
		return nil, nil, false
	}
	ch := make(chan Job, 32)
	set := m.watchers[norm]
	if set == nil {
		set = make(map[chan Job]struct{})
		m.watchers[norm] = set
	}
	set[ch] = struct{}{}
	cancel := func() {
		m.mu.Lock()
		if s := m.watchers[norm]; s != nil {
			delete(s, ch)
			if len(s) == 0 {
				delete(m.watchers, norm)
			}
		}
		m.mu.Unlock()
	}
	return ch, cancel, true
}

// SubscribeAll 订阅全部终端作业变更（用于全局 taskhub/jobs-watch）。
func (m *JobManager) SubscribeAll() (<-chan Job, func()) {
	m.mu.Lock()
	ch := make(chan Job, 64)
	m.allWatchers[ch] = struct{}{}
	m.mu.Unlock()
	cancel := func() {
		m.mu.Lock()
		delete(m.allWatchers, ch)
		m.mu.Unlock()
	}
	return ch, cancel
}

func newTerminalUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	hx := hex.EncodeToString(b)
	return fmt.Sprintf("%s-%s-%s-%s-%s", hx[:8], hx[8:12], hx[12:16], hx[16:20], hx[20:32])
}
