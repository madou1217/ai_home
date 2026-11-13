package subaggregator

import (
	"crypto/rand"
	"encoding/hex"
	"sort"
	"sync"
	"time"
)

const (
	DefaultSyncJobRetention   = 10 * time.Minute
	MaxFinishedSyncJobs       = 20
	DefaultSyncRunConcurrency = 4
)

// SyncJobEntry 描述一次待同步订阅源的输入信息。
type SyncJobEntry struct {
	ID   string
	Name string
}

// SyncOutcome 描述单个订阅源一次同步完成或进行中的状态。
type SyncOutcome struct {
	SourceID   string `json:"sourceId,omitempty"`
	Name       string `json:"name,omitempty"`
	State      string `json:"state"`
	StartedAt  *int64 `json:"startedAt"`
	FinishedAt *int64 `json:"finishedAt"`
	Count      int    `json:"count"`
	Error      string `json:"error"`
	Message    string `json:"message"`
}

// SyncJobCounts 描述任务条目进度统计。
type SyncJobCounts struct {
	Total     int `json:"total"`
	Done      int `json:"done"`
	Failed    int `json:"failed"`
	Succeeded int `json:"succeeded"`
}

// SyncJobView 描述序列化给前端或 SSE 的任务快照。
type SyncJobView struct {
	ID         string        `json:"id"`
	TaskName   string        `json:"taskName"`
	Status     string        `json:"status"`
	Counts     SyncJobCounts `json:"counts"`
	Items      []SyncOutcome `json:"items"`
	CreatedAt  int64         `json:"createdAt"`
	UpdatedAt  int64         `json:"updatedAt"`
	FinishedAt *int64        `json:"finishedAt"`
}

// SyncEvent 描述推送给 SSE 订阅者的任务事件。
type SyncEvent struct {
	Type string      `json:"type"`
	Job  SyncJobView `json:"job"`
}

// SyncSourceState 描述某个订阅源最近一次的同步状态（快照用）。
type SyncSourceState struct {
	State      string `json:"state"`
	StartedAt  *int64 `json:"startedAt"`
	FinishedAt *int64 `json:"finishedAt,omitempty"`
	Count      int    `json:"count,omitempty"`
	Error      string `json:"error,omitempty"`
	Message    string `json:"message,omitempty"`
	UpdatedAt  int64  `json:"updatedAt"`
}

type syncJob struct {
	id         string
	taskName   string
	status     string
	itemOrder  []string
	items      map[string]*SyncOutcome
	createdAt  int64
	updatedAt  int64
	finishedAt *int64
}

type activeSourceRun struct {
	started bool
	done    chan SyncOutcome
}

// SourceSyncFunc 执行单个订阅源的同步并返回标准化结果。
type SourceSyncFunc func(sourceID string) SourceSyncResult

// SourceSyncResult 统一封装单源同步返回。
type SourceSyncResult struct {
	OK      bool   `json:"ok"`
	Applied bool   `json:"applied"`
	Count   int    `json:"count"`
	Error   string `json:"error,omitempty"`
	Message string `json:"message,omitempty"`
}

// SourceSyncRunner 管理订阅源异步批量同步队列、并发去重及 SSE 事件推送。
type SourceSyncRunner struct {
	syncFn      SourceSyncFunc
	now         func() time.Time
	concurrency int
	retention   time.Duration

	mu           sync.Mutex
	jobs         map[string]*syncJob
	sourceStates map[string]SyncSourceState
	runs         map[string]*activeSourceRun
	queue        []func()
	active       int
	nextSubID    int
	listeners    map[int]func(SyncEvent)
}

// NewSourceSyncRunner 构造订阅源异步同步执行器。
func NewSourceSyncRunner(syncFn SourceSyncFunc) *SourceSyncRunner {
	return &SourceSyncRunner{
		syncFn:       syncFn,
		now:          time.Now,
		concurrency:  DefaultSyncRunConcurrency,
		retention:    DefaultSyncJobRetention,
		jobs:         make(map[string]*syncJob),
		sourceStates: make(map[string]SyncSourceState),
		runs:         make(map[string]*activeSourceRun),
		listeners:    make(map[int]func(SyncEvent)),
	}
}

func newSyncJobID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return "sync_" + hex.EncodeToString(b)
}

func (r *SourceSyncRunner) nowMs() int64 {
	if r.now != nil {
		return r.now().UnixMilli()
	}
	return time.Now().UnixMilli()
}

// OnChange 注册同步任务状态变更监听器并返回取消订阅函数。
func (r *SourceSyncRunner) OnChange(listener func(SyncEvent)) func() {
	if listener == nil {
		return func() {}
	}
	r.mu.Lock()
	r.nextSubID++
	id := r.nextSubID
	r.listeners[id] = listener
	r.mu.Unlock()
	return func() {
		r.mu.Lock()
		delete(r.listeners, id)
		r.mu.Unlock()
	}
}

func (r *SourceSyncRunner) snapshotListenersLocked() []func(SyncEvent) {
	out := make([]func(SyncEvent), 0, len(r.listeners))
	for _, l := range r.listeners {
		out = append(out, l)
	}
	return out
}

func (r *SourceSyncRunner) serializeJobLocked(job *syncJob) SyncJobView {
	items := make([]SyncOutcome, 0, len(job.itemOrder))
	done := 0
	failed := 0
	for _, sid := range job.itemOrder {
		it := job.items[sid]
		cp := *it
		items = append(items, cp)
		if cp.State == "succeeded" || cp.State == "failed" {
			done++
		}
		if cp.State == "failed" {
			failed++
		}
	}
	return SyncJobView{
		ID:       job.id,
		TaskName: job.taskName,
		Status:   job.status,
		Counts: SyncJobCounts{
			Total:     len(items),
			Done:      done,
			Failed:    failed,
			Succeeded: done - failed,
		},
		Items:      items,
		CreatedAt:  job.createdAt,
		UpdatedAt:  job.updatedAt,
		FinishedAt: job.finishedAt,
	}
}

func (r *SourceSyncRunner) pruneLocked(nowMs int64) {
	cutoff := nowMs - r.retention.Milliseconds()
	var finished []*syncJob
	for _, j := range r.jobs {
		if j.finishedAt != nil {
			finished = append(finished, j)
		}
	}
	sort.Slice(finished, func(i, k int) bool {
		return *finished[i].finishedAt > *finished[k].finishedAt
	})
	for idx, j := range finished {
		if *j.finishedAt <= cutoff || idx >= MaxFinishedSyncJobs {
			delete(r.jobs, j.id)
		}
	}
}

func (r *SourceSyncRunner) emitJobLocked(job *syncJob, pendingEvents *[]SyncEvent) {
	job.updatedAt = r.nowMs()
	*pendingEvents = append(*pendingEvents, SyncEvent{
		Type: "job",
		Job:  r.serializeJobLocked(job),
	})
}

func dispatchSyncEvents(listeners []func(SyncEvent), events []SyncEvent) {
	for _, ev := range events {
		for _, fn := range listeners {
			func() {
				defer func() { _ = recover() }()
				fn(ev)
			}()
		}
	}
}

func (r *SourceSyncRunner) activeJobsForLocked(sourceID string) []*syncJob {
	var out []*syncJob
	for _, j := range r.jobs {
		if j.finishedAt != nil {
			continue
		}
		if _, ok := j.items[sourceID]; ok {
			out = append(out, j)
		}
	}
	return out
}

func (r *SourceSyncRunner) settleIfDoneLocked(job *syncJob, nowMs int64) {
	if job.finishedAt != nil {
		return
	}
	failed := 0
	for _, sid := range job.itemOrder {
		st := job.items[sid].State
		if st != "succeeded" && st != "failed" {
			return
		}
		if st == "failed" {
			failed++
		}
	}
	switch {
	case failed == 0:
		job.status = "succeeded"
	case failed == len(job.itemOrder):
		job.status = "failed"
	default:
		job.status = "partial"
	}
	fin := nowMs
	job.finishedAt = &fin
}

func (r *SourceSyncRunner) updateItemsLocked(sourceID string, patch SyncOutcome, nowMs int64, events *[]SyncEvent) {
	for _, j := range r.activeJobsForLocked(sourceID) {
		item := j.items[sourceID]
		if item.State == "succeeded" || item.State == "failed" {
			continue
		}
		item.State = patch.State
		item.StartedAt = patch.StartedAt
		item.FinishedAt = patch.FinishedAt
		item.Count = patch.Count
		item.Error = patch.Error
		item.Message = patch.Message
		if patch.State == "running" {
			j.status = "running"
		}
		r.settleIfDoneLocked(j, nowMs)
		r.emitJobLocked(j, events)
	}
}

func (r *SourceSyncRunner) pumpLocked() {
	for r.active < r.concurrency && len(r.queue) > 0 {
		task := r.queue[0]
		r.queue = r.queue[1:]
		r.active++
		go func(fn func()) {
			defer func() {
				_ = recover()
				r.mu.Lock()
				r.active--
				r.pumpLocked()
				r.mu.Unlock()
			}()
			fn()
		}(task)
	}
}

func (r *SourceSyncRunner) scheduleLocked(sourceID string) {
	if _, exists := r.runs[sourceID]; exists {
		return
	}
	run := &activeSourceRun{done: make(chan SyncOutcome, 1)}
	r.runs[sourceID] = run
	r.queue = append(r.queue, func() {
		startedAt := r.nowMs()
		r.mu.Lock()
		run.started = true
		r.sourceStates[sourceID] = SyncSourceState{
			State:     "running",
			StartedAt: &startedAt,
			UpdatedAt: startedAt,
		}
		var events []SyncEvent
		r.updateItemsLocked(sourceID, SyncOutcome{
			State:     "running",
			StartedAt: &startedAt,
		}, startedAt, &events)
		listeners := r.snapshotListenersLocked()
		r.mu.Unlock()
		dispatchSyncEvents(listeners, events)

		var outcome SyncOutcome
		res := SourceSyncResult{OK: false, Error: "subscription_sync_failed"}
		if r.syncFn != nil {
			res = r.syncFn(sourceID)
		}
		finAt := r.nowMs()
		if res.OK {
			outcome = SyncOutcome{
				State:      "succeeded",
				StartedAt:  &startedAt,
				FinishedAt: &finAt,
				Count:      res.Count,
			}
		} else {
			errCode := res.Error
			if errCode == "" {
				errCode = "subscription_sync_failed"
			}
			outcome = SyncOutcome{
				State:      "failed",
				StartedAt:  &startedAt,
				FinishedAt: &finAt,
				Error:      errCode,
				Message:    res.Message,
			}
		}

		r.mu.Lock()
		delete(r.runs, sourceID)
		r.sourceStates[sourceID] = SyncSourceState{
			State:      outcome.State,
			StartedAt:  outcome.StartedAt,
			FinishedAt: outcome.FinishedAt,
			Count:      outcome.Count,
			Error:      outcome.Error,
			Message:    outcome.Message,
			UpdatedAt:  finAt,
		}
		var endEvents []SyncEvent
		r.updateItemsLocked(sourceID, outcome, finAt, &endEvents)
		endListeners := r.snapshotListenersLocked()
		r.mu.Unlock()
		dispatchSyncEvents(endListeners, endEvents)
		run.done <- outcome
		close(run.done)
	})
	r.pumpLocked()
}

// Start 创建新的同步任务并异步排入队列。
func (r *SourceSyncRunner) Start(entries []SyncJobEntry, taskName string) (SyncJobView, bool, error) {
	if taskName == "" {
		taskName = "同步订阅源"
	}
	seen := map[string]bool{}
	var list []SyncJobEntry
	for _, e := range entries {
		if e.ID == "" || seen[e.ID] {
			continue
		}
		seen[e.ID] = true
		name := e.Name
		if name == "" {
			name = e.ID
		}
		list = append(list, SyncJobEntry{ID: e.ID, Name: name})
	}
	if len(list) == 0 {
		return SyncJobView{}, false, errInvalid("subscription_source_required")
	}

	r.mu.Lock()
	nowMs := r.nowMs()
	r.pruneLocked(nowMs)

	job := &syncJob{
		id:        newSyncJobID(),
		taskName:  taskName,
		status:    "queued",
		itemOrder: make([]string, 0, len(list)),
		items:     make(map[string]*SyncOutcome, len(list)),
		createdAt: nowMs,
		updatedAt: nowMs,
	}
	for _, e := range list {
		job.itemOrder = append(job.itemOrder, e.ID)
		run := r.runs[e.ID]
		running := run != nil && run.started
		state := "queued"
		var startedAt *int64
		if running {
			state = "running"
			if st, ok := r.sourceStates[e.ID]; ok {
				startedAt = st.StartedAt
			}
			job.status = "running"
		} else {
			r.sourceStates[e.ID] = SyncSourceState{State: "queued", UpdatedAt: nowMs}
		}
		job.items[e.ID] = &SyncOutcome{
			SourceID:  e.ID,
			Name:      e.Name,
			State:     state,
			StartedAt: startedAt,
		}
	}
	r.jobs[job.id] = job
	var events []SyncEvent
	r.emitJobLocked(job, &events)
	view := r.serializeJobLocked(job)
	listeners := r.snapshotListenersLocked()
	for _, e := range list {
		r.scheduleLocked(e.ID)
	}
	r.mu.Unlock()
	dispatchSyncEvents(listeners, events)
	return view, false, nil
}

// StartOne 对单个订阅源发起同步任务；若已在执行或排队中则复用现有任务。
func (r *SourceSyncRunner) StartOne(entry SyncJobEntry) (SyncJobView, bool, error) {
	if entry.ID == "" {
		return SyncJobView{}, false, errInvalid("subscription_source_required")
	}
	r.mu.Lock()
	active := r.activeJobsForLocked(entry.ID)
	if len(active) > 0 {
		view := r.serializeJobLocked(active[0])
		r.mu.Unlock()
		return view, true, nil
	}
	r.mu.Unlock()
	label := entry.Name
	if label == "" {
		label = entry.ID
	}
	return r.Start([]SyncJobEntry{entry}, "同步 "+label)
}

// GetJob 查询单个任务快照。
func (r *SourceSyncRunner) GetJob(id string) (SyncJobView, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	j, ok := r.jobs[id]
	if !ok {
		return SyncJobView{}, false
	}
	return r.serializeJobLocked(j), true
}

// SyncSnapshot 表示首屏/SSE 重连快照。
type SyncSnapshot struct {
	Sources map[string]SyncSourceState `json:"sources"`
	Jobs    []SyncJobView              `json:"jobs"`
}

// Snapshot 返回当前各订阅源同步状态及近期任务列表（新任务在前）。
func (r *SourceSyncRunner) Snapshot() SyncSnapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	nowMs := r.nowMs()
	r.pruneLocked(nowMs)
	sources := make(map[string]SyncSourceState, len(r.sourceStates))
	for k, v := range r.sourceStates {
		sources[k] = v
	}
	jobs := make([]SyncJobView, 0, len(r.jobs))
	jobPtrs := make([]*syncJob, 0, len(r.jobs))
	for _, j := range r.jobs {
		jobPtrs = append(jobPtrs, j)
	}
	sort.Slice(jobPtrs, func(i, k int) bool {
		return jobPtrs[i].createdAt > jobPtrs[k].createdAt
	})
	for _, j := range jobPtrs {
		jobs = append(jobs, r.serializeJobLocked(j))
	}
	return SyncSnapshot{Sources: sources, Jobs: jobs}
}
