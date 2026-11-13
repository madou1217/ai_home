package geo

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"
)

// JobRetention 与 Node toolkit-resource-job-manager 对齐：终态任务保留 30 分钟。
const JobRetention = 30 * time.Minute

const (
	jobSource       = "geo-resource"
	jobKind         = "geo-resource"
	jobEventType    = "geo-resource-job"
	waitingLabel    = "等待 GeoIP 数据操作开始"
	failureLabel    = "GeoIP 数据操作失败。"
	cancelledLabel  = "GeoIP 数据任务已取消。"
)

// JobProgress 描述任务执行百分比与可读阶段提示。
type JobProgress struct {
	Percent int    `json:"percent"`
	Label   string `json:"label"`
}

// JobAttempt 记录一次执行尝试（与托管工具作业契约对齐）。
type JobAttempt struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

// JobResult 是作业成功后的摘要字段。
type JobResult struct {
	Installed      bool   `json:"installed"`
	ExecutablePath string `json:"executablePath"`
	Version        string `json:"version"`
}

// JobView 是 GeoIP 资源作业的公开快照（字段与前端 GeoResourceJob 逐字段一致）。
type JobView struct {
	ID         string       `json:"id"`
	Source     string       `json:"source"`
	TaskName   string       `json:"taskName"`
	AppID      string       `json:"appId"`
	Provider   string       `json:"provider"`
	ToolID     string       `json:"toolId"`
	Kind       string       `json:"kind"`
	Platform   string       `json:"platform"`
	Action     string       `json:"action"`
	Status     string       `json:"status"`
	Phase      string       `json:"phase"`
	Progress   JobProgress  `json:"progress"`
	Attempts   []JobAttempt `json:"attempts"`
	Result     *JobResult   `json:"result"`
	Error      string       `json:"error"`
	CreatedAt  int64        `json:"createdAt"`
	UpdatedAt  int64        `json:"updatedAt"`
	FinishedAt *int64       `json:"finishedAt"`
}

// JobStartRequest 是启动 GeoIP 资源作业的输入参数。
type JobStartRequest struct {
	ResourceID string `json:"resourceId"`
	Action     string `json:"action"`
}

// JobStartResult 是 POST /geo-resources/jobs 的响应结构。
type JobStartResult struct {
	OK             bool     `json:"ok"`
	Accepted       bool     `json:"accepted,omitempty"`
	AlreadyRunning bool     `json:"alreadyRunning,omitempty"`
	Error          string   `json:"error,omitempty"`
	Message        string   `json:"message,omitempty"`
	Job            *JobView `json:"job,omitempty"`
}

// JobCancelResult 是 POST /geo-resources/jobs/{id}/cancel 的响应结构。
type JobCancelResult struct {
	OK    bool     `json:"ok"`
	Error string   `json:"error,omitempty"`
	Job   *JobView `json:"job"`
}

// JobEvent 是作业状态变更时向 SSE 订阅者推送的事件帧。
type JobEvent struct {
	Type string  `json:"type"`
	Job  JobView `json:"job"`
}

// JobManagerOptions 配置 GeoIP 资源作业管理器。
type JobManagerOptions struct {
	AIHomeDir   string
	HomeDir     string
	URLTemplate string
	HTTPClient  *http.Client
	Now         func() time.Time
	Retention   time.Duration
}

type jobEntry struct {
	view       JobView
	resourceID string
	action     string
	label      string
	cancel     context.CancelFunc
}

// JobManager 负责 GeoIP 数据文件的异步下载/更新/删除作业、去重与进度广播。
type JobManager struct {
	mu          sync.Mutex
	aiHomeDir   string
	homeDir     string
	urlTemplate string
	httpClient  *http.Client
	now         func() time.Time
	retention   time.Duration

	jobs     map[string]*jobEntry
	active   map[string]string
	watchers map[chan JobEvent]struct{}
}

// NewJobManager 创建一个 GeoIP 资源作业管理器实例。
func NewJobManager(options JobManagerOptions) *JobManager {
	nowFn := options.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	retention := options.Retention
	if retention <= 0 {
		retention = JobRetention
	}
	return &JobManager{
		aiHomeDir:   strings.TrimSpace(options.AIHomeDir),
		homeDir:     strings.TrimSpace(options.HomeDir),
		urlTemplate: strings.TrimSpace(options.URLTemplate),
		httpClient:  options.HTTPClient,
		now:         nowFn,
		retention:   retention,
		jobs:        make(map[string]*jobEntry),
		active:      make(map[string]string),
		watchers:    make(map[chan JobEvent]struct{}),
	}
}

// AIHomeDir 返回作业管理器绑定的 aiHome 目录。
func (m *JobManager) AIHomeDir() string {
	return m.aiHomeDir
}

// HomeDir 返回作业管理器绑定的宿主机用户目录。
func (m *JobManager) HomeDir() string {
	return m.homeDir
}

// Start 校验并启动或复用一个资源作业。
func (m *JobManager) Start(req JobStartRequest) JobStartResult {
	resourceID := strings.ToLower(strings.TrimSpace(req.ResourceID))
	action := strings.ToLower(strings.TrimSpace(req.Action))
	if action == "" {
		action = "install"
	}
	spec, found := findResourceSpec(resourceID)
	if !found {
		return JobStartResult{OK: false, Error: "geo_resource_not_found"}
	}
	if action != "install" && action != "update" && action != "uninstall" {
		return JobStartResult{OK: false, Error: "geo_action_unsupported"}
	}
	if strings.TrimSpace(m.aiHomeDir) == "" {
		return JobStartResult{OK: false, Error: "ai_home_dir_required"}
	}

	label := fmt.Sprintf("删除 %s", spec.name)
	if action != "uninstall" {
		verb := "下载"
		if action == "update" {
			verb = "更新"
		}
		label = fmt.Sprintf("%s %s（%s）", verb, spec.name, spec.sizeHint)
	}

	m.mu.Lock()
	m.pruneLocked()
	if existingID, ok := m.active[spec.id]; ok {
		if entry, exists := m.jobs[existingID]; exists && !isTerminalJobStatus(entry.view.Status) {
			snapshot := cloneJobView(entry.view)
			m.mu.Unlock()
			return JobStartResult{
				OK:             true,
				Accepted:       true,
				AlreadyRunning: true,
				Job:            &snapshot,
			}
		}
		delete(m.active, spec.id)
	}

	nowMS := m.now().UnixMilli()
	jobID := fmt.Sprintf("geo-resource_%d_%s", nowMS, randomHex(4))
	runCtx, cancelFn := context.WithCancel(context.Background())
	entry := &jobEntry{
		resourceID: spec.id,
		action:     action,
		label:      label,
		cancel:     cancelFn,
		view: JobView{
			ID:        jobID,
			Source:    jobSource,
			TaskName:  label,
			AppID:     spec.id,
			Provider:  spec.id,
			ToolID:    spec.id,
			Kind:      jobKind,
			Platform:  "",
			Action:    action,
			Status:    "queued",
			Phase:     "queued",
			Progress:  JobProgress{Percent: 0, Label: waitingLabel},
			Attempts:  make([]JobAttempt, 0),
			Result:    nil,
			Error:     "",
			CreatedAt: nowMS,
			UpdatedAt: nowMS,
		},
	}
	m.jobs[jobID] = entry
	m.active[spec.id] = jobID
	initial := cloneJobView(entry.view)
	m.broadcastLocked(JobEvent{Type: jobEventType, Job: initial})
	m.mu.Unlock()
	go m.run(runCtx, jobID)

	return JobStartResult{
		OK:             true,
		Accepted:       true,
		AlreadyRunning: false,
		Job:            &initial,
	}
}

// Get 查询单个作业的当前快照。
func (m *JobManager) Get(jobID string) (JobView, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneLocked()
	entry, ok := m.jobs[strings.TrimSpace(jobID)]
	if !ok {
		return JobView{}, false
	}
	return cloneJobView(entry.view), true
}

// ListActive 返回未进入终态的活跃作业（按创建时间升序）。
func (m *JobManager) ListActive() []JobView {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.pruneLocked()
	out := make([]JobView, 0)
	for _, entry := range m.jobs {
		if !isTerminalJobStatus(entry.view.Status) {
			out = append(out, cloneJobView(entry.view))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].CreatedAt < out[j].CreatedAt
	})
	return out
}

// Cancel 取消尚未完成（queued 或 running）的作业。
func (m *JobManager) Cancel(jobID string) JobCancelResult {
	m.mu.Lock()
	entry, ok := m.jobs[strings.TrimSpace(jobID)]
	if !ok {
		m.mu.Unlock()
		return JobCancelResult{OK: false, Error: "job_not_found", Job: nil}
	}
	if isTerminalJobStatus(entry.view.Status) {
		snapshot := cloneJobView(entry.view)
		m.mu.Unlock()
		return JobCancelResult{OK: false, Error: "job_not_cancellable", Job: &snapshot}
	}
	cancelFn := entry.cancel
	nowMS := m.now().UnixMilli()
	entry.view.Status = "cancelled"
	entry.view.Phase = "cancelled"
	entry.view.Error = cancelledLabel
	entry.view.UpdatedAt = nowMS
	entry.view.FinishedAt = &nowMS
	if currentID, exists := m.active[entry.resourceID]; exists && currentID == entry.view.ID {
		delete(m.active, entry.resourceID)
	}
	snapshot := cloneJobView(entry.view)
	m.broadcastLocked(JobEvent{Type: jobEventType, Job: snapshot})
	m.mu.Unlock()

	if cancelFn != nil {
		cancelFn()
	}
	return JobCancelResult{OK: true, Job: &snapshot}
}

// Subscribe 订阅作业状态变更事件；调用方负责在退出时执行返回的 cancel 函数。
func (m *JobManager) Subscribe() (<-chan JobEvent, func()) {
	ch := make(chan JobEvent, 32)
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

func (m *JobManager) run(ctx context.Context, jobID string) {
	m.mu.Lock()
	entry, ok := m.jobs[jobID]
	if !ok || isTerminalJobStatus(entry.view.Status) {
		m.mu.Unlock()
		return
	}
	resourceID := entry.resourceID
	action := entry.action
	label := entry.label
	planID := fmt.Sprintf("%s:%s", resourceID, action)
	nowMS := m.now().UnixMilli()
	entry.view.Status = "running"
	entry.view.Phase = "running"
	entry.view.UpdatedAt = nowMS
	entry.view.Progress = JobProgress{Percent: 5, Label: label}
	runningSnap := cloneJobView(entry.view)
	m.broadcastLocked(JobEvent{Type: jobEventType, Job: runningSnap})
	m.mu.Unlock()

	var (
		outcomeOK  bool
		outcomeErr string
		version    string
	)
	if action == "uninstall" {
		target := ManagedDBIPPath(m.aiHomeDir)
		if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
			outcomeErr = err.Error()
		} else {
			outcomeOK = true
		}
	} else {
		m.updateProgress(jobID, 5, "downloading", "正在连接下载源")
		res := DownloadDBIPCity(ctx, DownloadOptions{
			AIHomeDir:   m.aiHomeDir,
			URLTemplate: m.urlTemplate,
			HTTPClient:  m.httpClient,
			Now:         m.now,
			OnProgress: func(progress DownloadProgress) {
				percent := 5 + int(float64(progress.Percent)*0.9)
				if progress.Phase == "done" {
					percent = 95
				}
				progressLabel := "下载中"
				if progress.TotalBytes > 0 {
					progressLabel = fmt.Sprintf("下载中 %d/%d MB", progress.ReceivedBytes/1048576, progress.TotalBytes/1048576)
				}
				m.updateProgress(jobID, percent, "downloading", progressLabel)
			},
		})
		if res.OK {
			outcomeOK = true
			version = res.Month
		} else {
			outcomeErr = res.Error
		}
	}

	probed, found := ProbeResource(m.aiHomeDir, resourceID)
	desiredOK := found && desiredStateReached(action, probed.Installed)

	attempt := JobAttempt{
		ID:    planID,
		Label: label,
		OK:    outcomeOK && desiredOK,
	}
	if !attempt.OK {
		if outcomeErr != "" {
			attempt.Error = outcomeErr
		} else if !desiredOK {
			attempt.Error = "geo_desired_state_not_reached"
		} else {
			attempt.Error = failureLabel
		}
	}

	m.mu.Lock()
	entry, ok = m.jobs[jobID]
	if !ok {
		m.mu.Unlock()
		return
	}
	if entry.view.Status == "cancelled" || ctx.Err() != nil {
		// 已被取消：保留取消态并确保清理 active 映射。
		if currentID, exists := m.active[entry.resourceID]; exists && currentID == jobID {
			delete(m.active, entry.resourceID)
		}
		m.mu.Unlock()
		return
	}

	finishMS := m.now().UnixMilli()
	entry.view.Attempts = append(entry.view.Attempts, attempt)
	entry.view.UpdatedAt = finishMS
	entry.view.FinishedAt = &finishMS
	if currentID, exists := m.active[entry.resourceID]; exists && currentID == jobID {
		delete(m.active, entry.resourceID)
	}

	if attempt.OK {
		entry.view.Status = "succeeded"
		entry.view.Phase = "done"
		entry.view.Progress = JobProgress{Percent: 100, Label: "已完成"}
		entry.view.Result = &JobResult{
			Installed:      probed.Installed,
			ExecutablePath: "",
			Version:        version,
		}
		entry.view.Error = ""
	} else {
		entry.view.Status = "failed"
		entry.view.Phase = "failed"
		entry.view.Error = trimError(attempt.Error)
		if entry.view.Error == "" {
			entry.view.Error = failureLabel
		}
	}
	finalSnap := cloneJobView(entry.view)
	m.broadcastLocked(JobEvent{Type: jobEventType, Job: finalSnap})
	m.mu.Unlock()
}

func (m *JobManager) updateProgress(jobID string, percent int, phase string, label string) {
	if percent < 0 {
		percent = 0
	} else if percent > 100 {
		percent = 100
	}
	m.mu.Lock()
	entry, ok := m.jobs[jobID]
	if !ok || isTerminalJobStatus(entry.view.Status) {
		m.mu.Unlock()
		return
	}
	// 同进度、同文案不重复推送 SSE。
	if entry.view.Progress.Percent == percent && entry.view.Progress.Label == label && entry.view.Phase == phase {
		m.mu.Unlock()
		return
	}
	entry.view.Phase = phase
	entry.view.Progress = JobProgress{Percent: percent, Label: label}
	entry.view.UpdatedAt = m.now().UnixMilli()
	snap := cloneJobView(entry.view)
	m.broadcastLocked(JobEvent{Type: jobEventType, Job: snap})
	m.mu.Unlock()
}

func (m *JobManager) pruneLocked() {
	cutoffMS := m.now().Add(-m.retention).UnixMilli()
	for id, entry := range m.jobs {
		if !isTerminalJobStatus(entry.view.Status) || entry.view.FinishedAt == nil {
			continue
		}
		if *entry.view.FinishedAt <= cutoffMS {
			delete(m.jobs, id)
		}
	}
}

// broadcastLocked 在持有 m.mu 时以非阻塞发送通知全部订阅者，避免与 cancel() 的 close(ch) 产生竞态。
func (m *JobManager) broadcastLocked(event JobEvent) {
	for ch := range m.watchers {
		select {
		case ch <- event:
		default:
		}
	}
}

func cloneJobView(view JobView) JobView {
	cloned := view
	cloned.Attempts = append([]JobAttempt(nil), view.Attempts...)
	if view.Result != nil {
		resultCopy := *view.Result
		cloned.Result = &resultCopy
	}
	if view.FinishedAt != nil {
		ts := *view.FinishedAt
		cloned.FinishedAt = &ts
	}
	return cloned
}

func desiredStateReached(action string, installed bool) bool {
	if action == "uninstall" {
		return !installed
	}
	return installed
}

func isTerminalJobStatus(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "succeeded", "failed", "cancelled":
		return true
	default:
		return false
	}
}

func trimError(value string) string {
	trimmed := strings.TrimSpace(value)
	if len(trimmed) > 500 {
		return trimmed[:500]
	}
	return trimmed
}

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "0000"
	}
	return hex.EncodeToString(buf)
}
