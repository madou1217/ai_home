package scheduledtasks

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/accountactivity"
)

const (
	// TickInterval 是调度循环扫描到期任务的默认间隔。
	TickInterval = 30 * time.Second
	// MaxRunDuration 是单次计划任务执行的兜底超时。
	MaxRunDuration = 30 * time.Minute

	// TriggerManual 表示手动触发运行。
	TriggerManual = "manual"
	// TriggerSchedule 表示调度器按计划触发运行。
	TriggerSchedule = "schedule"
)

// ErrInvalidDependencies 表示缺少必需依赖（aiHomeDir 为空）。
var ErrInvalidDependencies = errors.New("计划任务服务缺少 aiHomeDir")

// ServiceDependencies 汇总计划任务服务所需的外部依赖。
type ServiceDependencies struct {
	AIHomeDir        string
	Catalog          *accountactivity.Catalog
	ActivityService  *accountactivity.Service
	ActivityAccounts accountactivity.AccountLister
	CustomRunner     CustomCommandRunner
	Guard            *accountactivity.Guard
	Now              func() time.Time
	Location         *time.Location
	TickInterval     time.Duration
}

// UpsertInput 表示新建或更新计划任务的请求体。
type UpsertInput struct {
	ID          string         `json:"id"`
	Name        string         `json:"name"`
	EventID     string         `json:"eventId"`
	EventParams map[string]any `json:"eventParams"`
	Schedule    *ScheduleInput `json:"schedule"`
	Enabled     *bool          `json:"enabled"`
}

// ListResult 表示计划任务列表接口响应数据。
type ListResult struct {
	Tasks               []TaskView        `json:"tasks"`
	Events              []EventDescriptor `json:"events"`
	TickIntervalMS      int64             `json:"tickIntervalMs"`
	RecordRetentionDays int               `json:"recordRetentionDays"`
	SchedulerRunning    bool              `json:"schedulerRunning"`
	LastTickAt          int64             `json:"lastTickAt"`
}

// RecordsQuery 表示运行记录分页过滤参数。
type RecordsQuery struct {
	Days   int
	TaskID string
	Limit  int
	Offset int
}

// RecordsResult 表示运行记录分页响应数据。
type RecordsResult struct {
	Records []Record `json:"records"`
	Days    int      `json:"days"`
	Total   int      `json:"total"`
	Limit   int      `json:"limit"`
	Offset  int      `json:"offset"`
	HasMore bool     `json:"hasMore"`
}

// PreviewResult 表示调度表达式预览结果。
type PreviewResult struct {
	OK        bool      `json:"ok"`
	Error     string    `json:"error,omitempty"`
	Schedule  *Schedule `json:"schedule,omitempty"`
	Label     string    `json:"label,omitempty"`
	NextRunAt int64     `json:"nextRunAt,omitempty"`
}

// RunTaskResult 表示触发执行一次计划任务的返回值。
type RunTaskResult struct {
	OK      bool    `json:"ok"`
	Error   string  `json:"error,omitempty"`
	Skipped bool    `json:"skipped,omitempty"`
	Reason  string  `json:"reason,omitempty"`
	Record  *Record `json:"record,omitempty"`
}

// Service 管理计划任务持久态、后台调度循环与运行记录。
type Service struct {
	aiHomeDir        string
	catalog          *accountactivity.Catalog
	activity         *accountactivity.Service
	activityAccounts accountactivity.AccountLister
	customRunner     CustomCommandRunner
	guard            *accountactivity.Guard
	now              func() time.Time
	loc              *time.Location
	tickInterval     time.Duration

	stateMu sync.Mutex
	runMu   sync.Mutex

	running    map[string]int64
	tickCancel context.CancelFunc
	tickDone   chan struct{}
	lastTickAt int64
	ticking    bool
}

// NewService 创建计划任务服务，并清理上次进程异常退出留下的 running=true 残影。
func NewService(deps ServiceDependencies) (*Service, error) {
	home := strings.TrimSpace(deps.AIHomeDir)
	if home == "" {
		return nil, ErrInvalidDependencies
	}
	catalog := deps.Catalog
	if catalog == nil {
		catalog = accountactivity.BuiltinCatalog()
	}
	now := deps.Now
	if now == nil {
		now = time.Now
	}
	loc := deps.Location
	if loc == nil {
		loc = time.Local
	}
	tickInterval := deps.TickInterval
	if tickInterval <= 0 {
		tickInterval = TickInterval
	}
	customRunner := deps.CustomRunner
	if customRunner == nil {
		customRunner = RunCustomCommand
	}
	guard := deps.Guard
	if guard == nil {
		if deps.ActivityService != nil && deps.ActivityService.Guard() != nil {
			guard = deps.ActivityService.Guard()
		} else {
			guard = accountactivity.NewGuard(now)
		}
	}
	service := &Service{
		aiHomeDir:        home,
		catalog:          catalog,
		activity:         deps.ActivityService,
		activityAccounts: deps.ActivityAccounts,
		customRunner:     customRunner,
		guard:            guard,
		now:              now,
		loc:              loc,
		tickInterval:     tickInterval,
		running:          map[string]int64{},
	}
	service.reconcileInterruptedRuns()
	return service, nil
}

func (s *Service) reconcileInterruptedRuns() {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	nowMS := s.now().UnixMilli()
	state := readStateFile(s.aiHomeDir, nowMS)
	changed := false
	for i := range state.Tasks {
		if state.Tasks[i].Running {
			state.Tasks[i].Running = false
			state.Tasks[i].UpdatedAt = nowMS
			changed = true
		}
	}
	if changed {
		_, _ = writeStateFile(s.aiHomeDir, state, nowMS)
	}
}

// Start 启动后台调度定时器（幂等）。
func (s *Service) Start() {
	s.runMu.Lock()
	defer s.runMu.Unlock()
	if s.tickCancel != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	s.tickCancel = cancel
	s.tickDone = done
	interval := s.tickInterval

	go func() {
		defer close(done)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.Tick(ctx)
			}
		}
	}()
}

// Stop 停止后台调度定时器并等待循环退出（幂等）。
func (s *Service) Stop() {
	s.runMu.Lock()
	cancel := s.tickCancel
	done := s.tickDone
	s.tickCancel = nil
	s.tickDone = nil
	s.runMu.Unlock()

	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
}

// IsRunning 返回指定任务当前是否在运行中。
func (s *Service) IsRunning(taskID string) bool {
	id := strings.TrimSpace(taskID)
	if id == "" {
		return false
	}
	s.runMu.Lock()
	defer s.runMu.Unlock()
	_, ok := s.running[id]
	return ok
}

// TaskExists 判断计划任务是否存在。
func (s *Service) TaskExists(taskID string) bool {
	id := strings.TrimSpace(taskID)
	if id == "" {
		return false
	}
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	state := readStateFile(s.aiHomeDir, s.now().UnixMilli())
	return findTaskIndex(state.Tasks, id) >= 0
}

// List 返回任务列表、可选事件目录和调度器元信息。
func (s *Service) List() ListResult {
	s.stateMu.Lock()
	nowMS := s.now().UnixMilli()
	state := readStateFile(s.aiHomeDir, nowMS)
	s.stateMu.Unlock()

	tasks := make([]TaskView, 0, len(state.Tasks))
	for _, task := range state.Tasks {
		tasks = append(tasks, SerializeTask(task))
	}
	events := ListScheduledEvents(s.catalog)

	s.runMu.Lock()
	schedulerRunning := s.tickCancel != nil
	lastTickAt := s.lastTickAt
	s.runMu.Unlock()

	return ListResult{
		Tasks:               tasks,
		Events:              events,
		TickIntervalMS:      s.tickInterval.Milliseconds(),
		RecordRetentionDays: DefaultRecordRetentionDays,
		SchedulerRunning:    schedulerRunning,
		LastTickAt:          lastTickAt,
	}
}

// PreviewSchedule 校验并预览下一次运行时间与中文解释。
func (s *Service) PreviewSchedule(input *ScheduleInput) PreviewResult {
	schedule := NormalizeSchedule(input)
	if schedule == nil {
		return PreviewResult{OK: false, Error: "schedule_invalid"}
	}
	nowMS := s.now().UnixMilli()
	nextRunAt := ComputeNextRunAt(schedule, nowMS, nowMS, s.loc)
	if nextRunAt <= 0 {
		return PreviewResult{OK: false, Error: "schedule_never_runs"}
	}
	return PreviewResult{
		OK:        true,
		Schedule:  schedule,
		Label:     ScheduleLabel(schedule),
		NextRunAt: nextRunAt,
	}
}

// Upsert 新建或更新一条计划任务。
func (s *Service) Upsert(input UpsertInput) (TaskView, string) {
	eventID := strings.TrimSpace(input.EventID)
	events := ListScheduledEvents(s.catalog)
	var descriptor *EventDescriptor
	for i := range events {
		if events[i].ID == eventID {
			descriptor = &events[i]
			break
		}
	}
	if descriptor == nil {
		return TaskView{}, "event_unknown"
	}
	if ok, reason := DescribeEventAvailability(s.catalog, eventID); !ok {
		return TaskView{}, reason
	}
	schedule := NormalizeSchedule(input.Schedule)
	if schedule == nil {
		return TaskView{}, "schedule_invalid"
	}
	name := strings.TrimSpace(input.Name)
	if name == "" {
		name = descriptor.Label
	}
	rawParams := input.EventParams
	if rawParams == nil {
		rawParams = map[string]any{}
	}
	eventParams := copyAnyMap(rawParams)
	if descriptor.Kind == "custom" {
		if strings.TrimSpace(stringValue(rawParams["command"])) == "" {
			return TaskView{}, "custom_command_missing"
		}
	} else if descriptor.Kind == "activity" {
		parsed := ParseEventID(eventID)
		if parsed != nil {
			if action, ok := s.catalog.Find(parsed.Provider, parsed.ActionID); ok {
				normalized, paramErr := accountactivity.NormalizeParams(action, rawParams)
				if paramErr != "" {
					return TaskView{}, "event_params_invalid:" + paramErr
				}
				eventParams = normalized
			}
		}
	}

	s.stateMu.Lock()
	defer s.stateMu.Unlock()

	nowMS := s.now().UnixMilli()
	state := readStateFile(s.aiHomeDir, nowMS)
	idx := -1
	if trimmedID := strings.TrimSpace(input.ID); trimmedID != "" {
		idx = findTaskIndex(state.Tasks, trimmedID)
	}

	var next Task
	if idx >= 0 {
		existing := state.Tasks[idx]
		enabled := existing.Enabled
		if input.Enabled != nil {
			enabled = *input.Enabled
		}
		next = existing
		next.Name = name
		next.EventID = eventID
		next.EventLabel = descriptor.Label
		next.EventParams = eventParams
		next.Schedule = schedule
		next.Enabled = enabled
		next.UpdatedAt = nowMS
	} else {
		enabled := true
		if input.Enabled != nil {
			enabled = *input.Enabled
		}
		next = Task{
			ID:          "stask-" + newUUID(),
			Name:        name,
			EventID:     eventID,
			EventLabel:  descriptor.Label,
			EventParams: eventParams,
			Schedule:    schedule,
			Enabled:     enabled,
			CreatedAt:   nowMS,
			UpdatedAt:   nowMS,
		}
	}
	anchor := next.LastRunAt
	if anchor <= 0 {
		anchor = next.CreatedAt
	}
	if next.Enabled {
		next.NextRunAt = ComputeNextRunAt(next.Schedule, nowMS, anchor, s.loc)
	} else {
		next.NextRunAt = 0
	}

	if idx >= 0 {
		state.Tasks[idx] = next
	} else {
		state.Tasks = append(state.Tasks, next)
	}
	if _, err := writeStateFile(s.aiHomeDir, state, nowMS); err != nil {
		return TaskView{}, "scheduled_task_write_failed"
	}
	return SerializeTask(next), ""
}

// Remove 删除一条未在运行中的计划任务。
func (s *Service) Remove(taskID string) (bool, string) {
	id := strings.TrimSpace(taskID)
	if id == "" {
		return false, "task_not_found"
	}
	s.runMu.Lock()
	_, busy := s.running[id]
	s.runMu.Unlock()
	if busy {
		return false, "task_running"
	}

	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	nowMS := s.now().UnixMilli()
	state := readStateFile(s.aiHomeDir, nowMS)
	idx := findTaskIndex(state.Tasks, id)
	if idx < 0 {
		return false, "task_not_found"
	}
	state.Tasks = append(state.Tasks[:idx], state.Tasks[idx+1:]...)
	if _, err := writeStateFile(s.aiHomeDir, state, nowMS); err != nil {
		return false, "scheduled_task_write_failed"
	}
	return true, ""
}

// SetEnabled 启用或停用指定计划任务，并重算 nextRunAt。
func (s *Service) SetEnabled(taskID string, enabled bool) (TaskView, string) {
	id := strings.TrimSpace(taskID)
	s.stateMu.Lock()
	defer s.stateMu.Unlock()

	nowMS := s.now().UnixMilli()
	state := readStateFile(s.aiHomeDir, nowMS)
	idx := findTaskIndex(state.Tasks, id)
	if idx < 0 {
		return TaskView{}, "task_not_found"
	}
	next := state.Tasks[idx]
	next.Enabled = enabled
	next.UpdatedAt = nowMS
	if next.Enabled {
		anchor := next.LastRunAt
		if anchor <= 0 {
			anchor = next.CreatedAt
		}
		next.NextRunAt = ComputeNextRunAt(next.Schedule, nowMS, anchor, s.loc)
	} else {
		next.NextRunAt = 0
	}
	state.Tasks[idx] = next
	if _, err := writeStateFile(s.aiHomeDir, state, nowMS); err != nil {
		return TaskView{}, "scheduled_task_write_failed"
	}
	return SerializeTask(next), ""
}

// Records 按时间窗、taskId 和偏移量返回分页运行记录。
func (s *Service) Records(query RecordsQuery) RecordsResult {
	days := query.Days
	if days < 1 {
		days = DefaultRecordRetentionDays
	}
	limit := query.Limit
	if limit < 1 {
		limit = 20
	}
	if limit > 200 {
		limit = 200
	}
	offset := query.Offset
	if offset < 0 {
		offset = 0
	}

	s.stateMu.Lock()
	nowMS := s.now().UnixMilli()
	state := readStateFile(s.aiHomeDir, nowMS)
	s.stateMu.Unlock()

	cutoff := nowMS - int64(days)*24*60*60*1000
	filterTaskID := strings.TrimSpace(query.TaskID)
	filtered := make([]Record, 0, len(state.Records))
	for _, row := range state.Records {
		if row.StartedAt < cutoff {
			continue
		}
		if filterTaskID != "" && row.TaskID != filterTaskID {
			continue
		}
		filtered = append(filtered, row)
	}
	sort.SliceStable(filtered, func(i, j int) bool {
		return filtered[i].StartedAt > filtered[j].StartedAt
	})

	total := len(filtered)
	if offset >= total {
		return RecordsResult{
			Records: []Record{},
			Days:    days,
			Total:   total,
			Limit:   limit,
			Offset:  offset,
			HasMore: false,
		}
	}
	end := offset + limit
	if end > total {
		end = total
	}
	page := append([]Record(nil), filtered[offset:end]...)
	return RecordsResult{
		Records: page,
		Days:    days,
		Total:   total,
		Limit:   limit,
		Offset:  offset,
		HasMore: end < total,
	}
}

// RunTask 立即执行一条计划任务（支持手动与定时触发），含并发防抖与记录落盘。
func (s *Service) RunTask(ctx context.Context, taskID string, trigger string) RunTaskResult {
	id := strings.TrimSpace(taskID)
	normalizedTrigger := TriggerManual
	if trigger == TriggerSchedule {
		normalizedTrigger = TriggerSchedule
	}

	var target Task
	s.stateMu.Lock()
	state := readStateFile(s.aiHomeDir, s.now().UnixMilli())
	idx := findTaskIndex(state.Tasks, id)
	if idx < 0 {
		s.stateMu.Unlock()
		return RunTaskResult{OK: false, Error: "task_not_found"}
	}
	target = state.Tasks[idx]
	s.stateMu.Unlock()

	s.runMu.Lock()
	if _, busy := s.running[target.ID]; busy {
		s.runMu.Unlock()
		return RunTaskResult{OK: false, Error: "task_running"}
	}
	startedAt := s.now().UnixMilli()
	s.running[target.ID] = startedAt
	s.runMu.Unlock()

	releaseRunning := func() {
		s.runMu.Lock()
		delete(s.running, target.ID)
		s.runMu.Unlock()
	}

	parsed := ParseEventID(target.EventID)
	if parsed == nil {
		releaseRunning()
		rec := s.finalizeTaskExecution(target, normalizedTrigger, startedAt, EventResult{Status: "error", Error: "event_unknown"})
		return RunTaskResult{OK: true, Record: &rec}
	}

	if parsed.Kind == "custom" {
		guardKey := accountactivity.RunKey(CustomCommandEventID, target.EventParams)
		releaseGuard, denied := s.guard.Acquire(guardKey, 0)
		if denied != nil {
			releaseRunning()
			return s.recordSkippedByGuard(target.ID, normalizedTrigger, string(denied.Reason))
		}

		s.setTaskRunningFlag(target.ID, true, startedAt)
		runCtx, cancel := context.WithTimeout(ctx, MaxRunDuration)
		command := stringValue(target.EventParams["command"])
		cwd := stringValue(target.EventParams["cwd"])
		outcome := s.customRunner(runCtx, command, cwd)
		cancel()
		releaseGuard()
		releaseRunning()

		rec := s.finalizeTaskExecution(target, normalizedTrigger, startedAt, outcome)
		return RunTaskResult{OK: true, Record: &rec}
	}

	// activity 事件：委托给统一的 accountactivity.Service（共享护栏 + 队列进度）。
	if avail, reason := DescribeEventAvailability(s.catalog, target.EventID); !avail {
		releaseRunning()
		rec := s.finalizeTaskExecution(target, normalizedTrigger, startedAt, EventResult{Status: "error", Error: reason})
		return RunTaskResult{OK: true, Record: &rec}
	}
	if s.activity == nil {
		releaseRunning()
		rec := s.finalizeTaskExecution(target, normalizedTrigger, startedAt, EventResult{Status: "error", Error: "activity_executor_unavailable"})
		return RunTaskResult{OK: true, Record: &rec}
	}

	runOutcome := s.activity.Run(ctx, accountactivity.Selection{
		Providers: []string{parsed.Provider},
		ActionID:  parsed.ActionID,
		Params:    target.EventParams,
	})
	if runOutcome.Status == 409 {
		releaseRunning()
		errCode := stringValue(runOutcome.Payload["error"])
		guardReason := errCode
		switch errCode {
		case "activity_probe_running":
			guardReason = "probe_in_flight"
		case "activity_already_running":
			guardReason = string(accountactivity.DeniedInFlight)
		case "activity_debounced":
			guardReason = string(accountactivity.DeniedDebounced)
		}
		return s.recordSkippedByGuard(target.ID, normalizedTrigger, guardReason)
	}
	if runOutcome.Status == 400 && stringValue(runOutcome.Payload["error"]) == "activity_no_accounts" {
		releaseRunning()
		summary := s.classifyEmptyTargetsSummary(ctx, parsed.Provider)
		rec := s.finalizeTaskExecution(target, normalizedTrigger, startedAt, EventResult{
			Status:  "skipped",
			Summary: summary,
		})
		return RunTaskResult{OK: true, Record: &rec}
	}
	if runOutcome.Status != 202 {
		releaseRunning()
		errCode := stringValue(runOutcome.Payload["error"])
		if errCode == "" {
			errCode = "activity_start_failed"
		}
		rec := s.finalizeTaskExecution(target, normalizedTrigger, startedAt, EventResult{
			Status: "error",
			Error:  errCode,
		})
		return RunTaskResult{OK: true, Record: &rec}
	}

	jobID := extractJobID(runOutcome.Payload["job"])
	if jobID == "" {
		releaseRunning()
		rec := s.finalizeTaskExecution(target, normalizedTrigger, startedAt, EventResult{
			Status: "error",
			Error:  "activity_job_lost",
		})
		return RunTaskResult{OK: true, Record: &rec}
	}

	s.setTaskRunningFlag(target.ID, true, startedAt)
	runCtx, cancel := context.WithTimeout(ctx, MaxRunDuration)
	outcome := s.waitActivityJob(runCtx, jobID)
	cancel()
	releaseRunning()

	rec := s.finalizeTaskExecution(target, normalizedTrigger, startedAt, outcome)
	return RunTaskResult{OK: true, Record: &rec}
}

func (s *Service) classifyEmptyTargetsSummary(ctx context.Context, provider string) string {
	if s.activityAccounts == nil {
		return "no_accounts"
	}
	refs, err := s.activityAccounts.ListByProvider(ctx, provider)
	if err != nil || len(refs) == 0 {
		return "no_accounts"
	}
	return "no_selected_accounts"
}

func extractJobID(raw any) string {
	switch typed := raw.(type) {
	case accountactivity.JobView:
		return strings.TrimSpace(typed.ID)
	case *accountactivity.JobView:
		if typed != nil {
			return strings.TrimSpace(typed.ID)
		}
	case map[string]any:
		return strings.TrimSpace(stringValue(typed["id"]))
	}
	return ""
}

func (s *Service) waitActivityJob(ctx context.Context, jobID string) EventResult {
	ticker := time.NewTicker(ActivityJobPollInterval)
	defer ticker.Stop()

	for {
		view, found := s.activity.Jobs().Get(jobID)
		if !found {
			return EventResult{Status: "error", Error: "activity_job_lost", JobID: jobID}
		}
		if accountactivity.IsTerminalStatus(view.Status) {
			var sum accountactivity.Summary
			if view.Summary != nil {
				sum = *view.Summary
			} else {
				sum = accountactivity.Summarize(view.Results)
			}
			status := "error"
			if view.Status == accountactivity.JobSucceeded {
				status = "ok"
			}
			errorSummary := strings.TrimSpace(view.ErrorSummary)
			if errorSummary == "" {
				errorSummary = sum.ErrorSummary
			}
			return EventResult{
				Status:       status,
				Summary:      FormatActivitySummary(sum),
				Error:        strings.TrimSpace(view.Error),
				ErrorSummary: errorSummary,
				JobID:        jobID,
			}
		}
		select {
		case <-ctx.Done():
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				return EventResult{Status: "error", Error: "task_timeout", JobID: jobID}
			}
			return EventResult{Status: "error", Error: "task_cancelled", JobID: jobID}
		case <-ticker.C:
		}
	}
}

func (s *Service) setTaskRunningFlag(taskID string, running bool, atMS int64) {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	state := readStateFile(s.aiHomeDir, atMS)
	idx := findTaskIndex(state.Tasks, taskID)
	if idx < 0 {
		return
	}
	state.Tasks[idx].Running = running
	state.Tasks[idx].UpdatedAt = atMS
	_, _ = writeStateFile(s.aiHomeDir, state, atMS)
}

func (s *Service) recordSkippedByGuard(taskID string, trigger string, reason string) RunTaskResult {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()

	at := s.now().UnixMilli()
	state := readStateFile(s.aiHomeDir, at)
	idx := findTaskIndex(state.Tasks, taskID)
	if idx < 0 {
		return RunTaskResult{OK: false, Error: "task_not_found"}
	}
	task := state.Tasks[idx]
	summary := "距上次执行不足防抖窗口，本次已跳过"
	switch reason {
	case "probe_in_flight":
		summary = "正在探测可领项，本次已跳过"
	case string(accountactivity.DeniedInFlight):
		summary = "同一事件正在执行，本次已合并"
	}
	label := task.EventLabel
	if label == "" {
		label = s.eventLabelFor(task.EventID)
	}
	skipped := Record{
		ID:         "srec-" + newUUID(),
		TaskID:     task.ID,
		TaskName:   task.Name,
		EventID:    task.EventID,
		EventLabel: label,
		Trigger:    trigger,
		Status:     "skipped",
		Summary:    summary,
		Error:      reason,
		StartedAt:  at,
		FinishedAt: at,
	}
	if task.Enabled {
		task.NextRunAt = ComputeNextRunAt(task.Schedule, at, at, s.loc)
	} else {
		task.NextRunAt = 0
	}
	task.LastStatus = "skipped"
	task.LastSummary = summary
	task.UpdatedAt = at
	state.Tasks[idx] = task
	state.Records = append([]Record{skipped}, state.Records...)
	_, _ = writeStateFile(s.aiHomeDir, state, at)
	return RunTaskResult{OK: true, Skipped: true, Reason: reason, Record: &skipped}
}

func (s *Service) finalizeTaskExecution(fallback Task, trigger string, startedAt int64, outcome EventResult) Record {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()

	finishedAt := s.now().UnixMilli()
	state := readStateFile(s.aiHomeDir, finishedAt)
	idx := findTaskIndex(state.Tasks, fallback.ID)
	current := fallback
	if idx >= 0 {
		current = state.Tasks[idx]
	}

	nextRunAt := int64(0)
	if current.Enabled {
		nextRunAt = ComputeNextRunAt(current.Schedule, finishedAt, finishedAt, s.loc)
	}
	status := strings.TrimSpace(outcome.Status)
	if status == "" {
		status = "error"
	}
	label := current.EventLabel
	if label == "" {
		label = s.eventLabelFor(current.EventID)
	}
	rec := Record{
		ID:           "srec-" + newUUID(),
		TaskID:       current.ID,
		TaskName:     current.Name,
		EventID:      current.EventID,
		EventLabel:   label,
		Trigger:      trigger,
		Status:       status,
		Summary:      strings.TrimSpace(outcome.Summary),
		Error:        strings.TrimSpace(outcome.Error),
		ErrorSummary: strings.TrimSpace(outcome.ErrorSummary),
		StartedAt:    startedAt,
		FinishedAt:   finishedAt,
		JobID:        strings.TrimSpace(outcome.JobID),
	}
	lastSummary := rec.Summary
	if lastSummary == "" {
		lastSummary = rec.Error
	}
	if idx >= 0 {
		current.Running = false
		current.LastRunAt = finishedAt
		current.LastStatus = rec.Status
		current.LastSummary = lastSummary
		current.NextRunAt = nextRunAt
		current.UpdatedAt = finishedAt
		state.Tasks[idx] = current
	}
	state.Records = append([]Record{rec}, state.Records...)
	_, _ = writeStateFile(s.aiHomeDir, state, finishedAt)
	return rec
}

// Tick 扫描并顺序补跑所有已到期的启用任务。
func (s *Service) Tick(ctx context.Context) {
	s.runMu.Lock()
	if s.ticking {
		s.runMu.Unlock()
		return
	}
	s.ticking = true
	tickAt := s.now().UnixMilli()
	s.lastTickAt = tickAt
	s.runMu.Unlock()

	defer func() {
		s.runMu.Lock()
		s.ticking = false
		s.runMu.Unlock()
	}()

	s.stateMu.Lock()
	state := readStateFile(s.aiHomeDir, tickAt)
	s.stateMu.Unlock()

	due := make([]Task, 0)
	for _, task := range state.Tasks {
		if !task.Enabled || task.NextRunAt <= 0 || task.NextRunAt > tickAt {
			continue
		}
		if s.IsRunning(task.ID) {
			continue
		}
		due = append(due, task)
	}
	sort.Slice(due, func(i, j int) bool {
		return due[i].NextRunAt < due[j].NextRunAt
	})
	for _, task := range due {
		if ctx.Err() != nil {
			return
		}
		_ = s.RunTask(ctx, task.ID, TriggerSchedule)
	}
}

func (s *Service) eventLabelFor(eventID string) string {
	for _, ev := range ListScheduledEvents(s.catalog) {
		if ev.ID == eventID {
			return ev.Label
		}
	}
	return eventID
}

func findTaskIndex(tasks []Task, taskID string) int {
	for i := range tasks {
		if tasks[i].ID == taskID {
			return i
		}
	}
	return -1
}

func copyAnyMap(src map[string]any) map[string]any {
	if len(src) == 0 {
		return map[string]any{}
	}
	dst := make(map[string]any, len(src))
	for k, v := range src {
		dst[k] = v
	}
	return dst
}

func stringValue(v any) string {
	switch typed := v.(type) {
	case string:
		return typed
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	default:
		return ""
	}
}

func newUUID() string {
	var buf [16]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	buf[6] = (buf[6] & 0x0f) | 0x40
	buf[8] = (buf[8] & 0x3f) | 0x80
	hexStr := hex.EncodeToString(buf[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", hexStr[0:8], hexStr[8:12], hexStr[12:16], hexStr[16:20], hexStr[20:32])
}
