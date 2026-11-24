package requirements

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Service 是需求管理的应用服务：所有写操作在这里校验状态机与工作区约束。
type Service struct {
	store Store
	model ModelClient
	clock func() time.Time
	newID func(prefix string) string

	subscribersMu sync.Mutex
	subscribers   map[int]chan struct{}
	nextSubID     int

	// lastLoopMessage 用于发现“连续两轮回复完全相同”的空转，自动停止循环。
	loopMu          sync.Mutex
	lastLoopMessage map[string]string
}

// Snapshot 是页面一次加载所需的完整读模型。
type Snapshot struct {
	Requirements []Requirement     `json:"requirements"`
	Settings     SchedulerSettings `json:"settings"`
	GeneratedAt  int64             `json:"generatedAt"`
}

// NewService 创建需求应用服务。
func NewService(store Store, model ModelClient, clock func() time.Time) *Service {
	if clock == nil {
		clock = time.Now
	}
	return &Service{
		store:           store,
		model:           model,
		clock:           clock,
		newID:           defaultNewID,
		subscribers:     map[int]chan struct{}{},
		lastLoopMessage: map[string]string{},
	}
}

func defaultNewID(prefix string) string {
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())
	}
	return prefix + "_" + hex.EncodeToString(buf)
}

// Now 返回服务时钟的毫秒时间戳。
func (service *Service) Now() int64 { return NowMillis(service.clock) }

// List 返回页面快照。读路径不调用模型、不启动进程。
func (service *Service) List(ctx context.Context) (Snapshot, error) {
	items, err := service.store.ListRequirements(ctx)
	if err != nil {
		return Snapshot{}, err
	}
	settings, err := service.store.GetSchedulerSettings(ctx)
	if err != nil {
		return Snapshot{}, err
	}
	SortRequirements(items)
	return Snapshot{
		Requirements: items,
		Settings:     settings.Normalized(),
		GeneratedAt:  service.Now(),
	}, nil
}

// CreateRequirement 创建需求；默认是 idea，不会自动进入调度。
func (service *Service) CreateRequirement(ctx context.Context, requirement Requirement) (Requirement, error) {
	requirement.Title = strings.TrimSpace(requirement.Title)
	if requirement.Title == "" {
		return Requirement{}, fmt.Errorf("%w: 需求标题不能为空", ErrInvalid)
	}
	mode, err := NormalizeMode(requirement.Mode)
	if err != nil {
		return Requirement{}, err
	}
	requirement.Mode = mode
	status := strings.TrimSpace(requirement.Status)
	if status == "" {
		status = StatusIdea
	}
	status, err = NormalizeStatus(status)
	if err != nil {
		return Requirement{}, err
	}
	requirement.Status = status
	requirement.Priority = NormalizePriority(requirement.Priority)
	workspacePath, err := NormalizeWorkspacePath(requirement.WorkspacePath)
	if err != nil {
		return Requirement{}, err
	}
	requirement.WorkspacePath = workspacePath
	requirement.WorkspaceLabel = strings.TrimSpace(requirement.WorkspaceLabel)
	requirement.WorkspaceKind = strings.TrimSpace(requirement.WorkspaceKind)
	if requirement.Status == StatusReady && requirement.WorkspacePath == "" {
		return Requirement{}, fmt.Errorf("%w: 进入排期前必须在 Work 中绑定工作区路径", ErrInvalid)
	}
	if requirement.Status == StatusReady && requirement.Description == "" && len(requirement.Steps) == 0 {
		return Requirement{}, fmt.Errorf("%w: 进入排期前需要描述或已拆解步骤", ErrInvalid)
	}
	existing, err := service.store.ListRequirements(ctx)
	if err != nil {
		return Requirement{}, err
	}
	maxPosition := 0
	for _, item := range existing {
		if item.Position > maxPosition {
			maxPosition = item.Position
		}
	}
	now := service.Now()
	requirement.ID = strings.TrimSpace(requirement.ID)
	if requirement.ID == "" {
		requirement.ID = service.newID("req")
	}
	requirement.Position = maxPosition + 1
	requirement.Steps = normalizeSteps(requirement.Steps)
	requirement.Source = strings.TrimSpace(requirement.Source)
	if requirement.Source == "" {
		requirement.Source = "manual"
	}
	requirement.CreatedAt = now
	requirement.UpdatedAt = now
	if requirement.Status == StatusReady {
		requirement.Progress = 0
	}
	if requirement.Status == StatusDone {
		requirement.Progress = 100
		requirement.CompletedAt = now
	}
	if err := service.store.SaveRequirement(ctx, requirement); err != nil {
		return Requirement{}, err
	}
	service.appendEvent(ctx, requirement.ID, "created", "创建需求")
	service.Notify()
	return requirement, nil
}

// UpdateRequirement 局部更新需求，并校验确认与工作区绑定。
func (service *Service) UpdateRequirement(ctx context.Context, id string, patch RequirementPatch) (Requirement, error) {
	current, err := service.store.GetRequirement(ctx, id)
	if err != nil {
		return Requirement{}, err
	}
	next := current
	if patch.Title != nil {
		next.Title = strings.TrimSpace(*patch.Title)
		if next.Title == "" {
			return Requirement{}, fmt.Errorf("%w: 需求标题不能为空", ErrInvalid)
		}
	}
	if patch.Description != nil {
		next.Description = strings.TrimSpace(*patch.Description)
	}
	if patch.Priority != nil {
		next.Priority = NormalizePriority(*patch.Priority)
	}
	if patch.Position != nil {
		next.Position = *patch.Position
	}
	if patch.Mode != nil {
		mode, err := NormalizeMode(*patch.Mode)
		if err != nil {
			return Requirement{}, err
		}
		next.Mode = mode
	}
	if patch.Parallel != nil {
		next.Parallel = *patch.Parallel
	}
	if patch.Steps != nil {
		next.Steps = normalizeSteps(*patch.Steps)
	}
	if patch.WorkspacePath != nil {
		workspacePath, err := NormalizeWorkspacePath(*patch.WorkspacePath)
		if err != nil {
			return Requirement{}, err
		}
		if current.IsActive() && workspacePath != current.WorkspacePath {
			return Requirement{}, fmt.Errorf("%w: 执行中的需求不能切换工作区", ErrConflict)
		}
		next.WorkspacePath = workspacePath
	}
	if patch.WorkspaceLabel != nil {
		next.WorkspaceLabel = strings.TrimSpace(*patch.WorkspaceLabel)
	}
	if patch.WorkspaceKind != nil {
		next.WorkspaceKind = strings.TrimSpace(*patch.WorkspaceKind)
	}
	service.clearLoopMessage(current.ID)
	if patch.Status != nil {
		status, err := NormalizeStatus(*patch.Status)
		if err != nil {
			return Requirement{}, err
		}
		if status == StatusReady && next.WorkspacePath == "" {
			return Requirement{}, fmt.Errorf("%w: 进入排期前必须在 Work 中绑定工作区路径", ErrInvalid)
		}
		if status == StatusReady && strings.TrimSpace(next.Description) == "" && len(next.Steps) == 0 {
			return Requirement{}, fmt.Errorf("%w: 进入排期前需要描述或已拆解步骤", ErrInvalid)
		}
		if err := Transition(current.Status, status); err != nil {
			return Requirement{}, err
		}
		next.Status = status
		if status == StatusDone {
			now := service.Now()
			next.CompletedAt = now
			next.Progress = 100
		}
		if status == StatusReady {
			next.Progress = 0
			next.LastError = ""
		}
	}
	next.UpdatedAt = service.Now()
	if err := service.store.SaveRequirement(ctx, next); err != nil {
		return Requirement{}, err
	}
	service.appendEvent(ctx, next.ID, "updated", "更新需求")
	service.Notify()
	return next, nil
}

// DeleteRequirement 删除需求。
func (service *Service) DeleteRequirement(ctx context.Context, id string) error {
	requirement, err := service.store.GetRequirement(ctx, id)
	if err != nil {
		return err
	}
	if requirement.IsActive() {
		return fmt.Errorf("%w: 执行中的需求不能删除，请先取消", ErrConflict)
	}
	if err := service.store.DeleteRequirement(ctx, id); err != nil {
		return err
	}
	service.clearLoopMessage(id)
	service.Notify()
	return nil
}

// Reorder 按显式 ID 顺序重排需求。
func (service *Service) Reorder(ctx context.Context, ids []string) error {
	items, err := service.store.ListRequirements(ctx)
	if err != nil {
		return err
	}
	positions := make(map[string]int, len(ids))
	for index, id := range ids {
		positions[strings.TrimSpace(id)] = index + 1
	}
	now := service.Now()
	for _, item := range items {
		position, found := positions[item.ID]
		if !found {
			continue
		}
		item.Position = position
		item.UpdatedAt = now
		if err := service.store.SaveRequirement(ctx, item); err != nil {
			return err
		}
	}
	service.Notify()
	return nil
}

// Refine 手动触发 AI 需求优化；必须指定 Work 工作区路径。
func (service *Service) Refine(ctx context.Context, id, workspacePath, workspaceLabel, workspaceKind string) (Requirement, error) {
	requirement, err := service.store.GetRequirement(ctx, id)
	if err != nil {
		return Requirement{}, err
	}
	workspacePath, err = NormalizeWorkspacePath(workspacePath)
	if err != nil {
		return Requirement{}, err
	}
	if workspacePath == "" {
		workspacePath = requirement.WorkspacePath
	}
	if workspacePath == "" {
		return Requirement{}, fmt.Errorf("%w: 优化需求前必须指定 Work 工作区", ErrInvalid)
	}
	requirement.WorkspacePath = workspacePath
	if label := strings.TrimSpace(workspaceLabel); label != "" {
		requirement.WorkspaceLabel = label
	}
	if kind := strings.TrimSpace(workspaceKind); kind != "" {
		requirement.WorkspaceKind = kind
	}
	settings, err := service.store.GetSchedulerSettings(ctx)
	if err != nil {
		return Requirement{}, err
	}
	settings = settings.Normalized()
	if service.model == nil {
		return Requirement{}, fmt.Errorf("%w: 模型客户端未配置", ErrInvalid)
	}
	output, err := service.model.Complete(ctx, ModelRequest{
		Provider:   settings.Provider,
		Model:      settings.Model,
		AccountRef: settings.AccountRef,
		System:     RefineSystemPrompt,
		Prompt:     BuildRefinePrompt(requirement),
	})
	if err != nil {
		return Requirement{}, err
	}
	title, summary, steps, acceptance := ParseRefinement(output, requirement.Title)
	if len(steps) == 0 {
		return Requirement{}, fmt.Errorf("%w: 模型没有返回可执行步骤", ErrInvalid)
	}
	requirement.Title = title
	requirement.Description = composeRefinedDescription(requirement.Description, summary, steps, acceptance)
	requirement.Steps = steps
	requirement.RefinedAt = service.Now()
	requirement.UpdatedAt = service.Now()
	if requirement.Status == StatusIdea {
		// 优化不等于确认：保持 idea，用户仍需显式确认进入排期。
		requirement.Status = StatusIdea
	}
	if err := service.store.SaveRequirement(ctx, requirement); err != nil {
		return Requirement{}, err
	}
	service.appendEvent(ctx, requirement.ID, "refined", fmt.Sprintf("AI 拆解为 %d 个步骤", len(steps)))
	service.Notify()
	return requirement, nil
}

// Dispatch 手动或调度器触发一次执行。
func (service *Service) Dispatch(ctx context.Context, dispatcher Dispatcher, id, workspacePath, workspaceLabel, workspaceKind string) (Requirement, error) {
	requirement, err := service.store.GetRequirement(ctx, id)
	if err != nil {
		return Requirement{}, err
	}
	workspacePath, err = NormalizeWorkspacePath(workspacePath)
	if err != nil {
		return Requirement{}, err
	}
	if workspacePath != "" && requirement.WorkspacePath != workspacePath {
		if requirement.IsActive() {
			return Requirement{}, fmt.Errorf("%w: 执行中的需求不能切换工作区", ErrConflict)
		}
		requirement.WorkspacePath = workspacePath
	}
	if label := strings.TrimSpace(workspaceLabel); label != "" {
		requirement.WorkspaceLabel = label
	}
	if kind := strings.TrimSpace(workspaceKind); kind != "" {
		requirement.WorkspaceKind = kind
	}
	if requirement.WorkspacePath == "" {
		return Requirement{}, fmt.Errorf("%w: 调度前必须在 Work 中绑定工作区路径", ErrInvalid)
	}
	if requirement.Status != StatusReady {
		return Requirement{}, fmt.Errorf("%w: 只有已确认的需求可以调度，当前状态 %s", ErrConflict, requirement.Status)
	}
	if dispatcher == nil {
		return Requirement{}, fmt.Errorf("%w: 执行器未配置", ErrInvalid)
	}
	settings, err := service.store.GetSchedulerSettings(ctx)
	if err != nil {
		return Requirement{}, err
	}
	settings = settings.Normalized()
	provider := settings.Provider
	model := settings.Model
	accountRef := settings.AccountRef
	effort := settings.ReasoningEffort
	assignmentExecution := ""
	switch accountRef {
	case "":
		assignmentExecution = ""
	case "gateway":
		assignmentExecution = ExecutionRelay
	default:
		assignmentExecution = ExecutionNative
	}

	now := service.Now()
	requirement.Status = StatusQueued
	requirement.Progress = 3
	requirement.ProgressNote = "调度器已领取，正在创建执行会话"
	requirement.LastError = ""
	requirement.AssignedProvider = provider
	requirement.AssignedHarness = provider
	requirement.AssignedExecution = assignmentExecution
	requirement.AssignedAccountRef = accountRef
	requirement.AssignedModel = model
	requirement.AssignedEffort = effort
	requirement.AssignedAt = now
	requirement.UpdatedAt = now
	if err := service.store.SaveRequirement(ctx, requirement); err != nil {
		return Requirement{}, err
	}
	service.appendEvent(ctx, requirement.ID, "queued", "调度器已领取需求")
	service.Notify()

	handle, startErr := dispatcher.Start(ctx, WorkRequest{
		RequirementID:  requirement.ID,
		Title:          requirement.Title,
		Prompt:         BuildWorkPrompt(requirement),
		Mode:           requirement.Mode,
		WorkspacePath:  requirement.WorkspacePath,
		WorkspaceLabel: requirement.WorkspaceLabel,
		WorkspaceKind:  requirement.WorkspaceKind,
		Provider:       provider,
		Model:          model,
		AccountRef:     accountRef,
		Effort:         effort,
		GoalObjective:  requirement.GoalObjective(),
	})
	if startErr != nil {
		requirement.Status = StatusBlocked
		requirement.Progress = 0
		requirement.LastError = startErr.Error()
		requirement.ProgressNote = "启动执行失败"
		requirement.UpdatedAt = service.Now()
		_ = service.store.SaveRequirement(ctx, requirement)
		service.appendEvent(ctx, requirement.ID, "blocked", "启动执行失败："+startErr.Error())
		service.Notify()
		return requirement, fmt.Errorf("%w: %v", ErrUnavailable, startErr)
	}
	// Start 期间的 turn 事件可能已经先一步把卡片推进到 blocked/review；
	// AttachWorkSession 只在卡片仍处于 queued 时才写 running，避免把失败覆盖成执行中。
	attached, err := service.store.AttachWorkSession(ctx, requirement.ID, handle.SessionID, handle.PeerMessageID, handle.Assignment, now)
	if err != nil {
		return Requirement{}, err
	}
	if attached.Status == StatusRunning {
		service.appendEvent(ctx, attached.ID, "running", "AI 工作会话已启动")
	}
	service.Notify()
	return attached, nil
}

// ResetToReady 把卡住的执行态重新放回待排期；只作用于 active 状态。
func (service *Service) ResetToReady(ctx context.Context, id string, note string) (Requirement, error) {
	requirement, err := service.store.GetRequirement(ctx, id)
	if err != nil {
		return Requirement{}, err
	}
	if !requirement.IsActive() {
		return requirement, nil
	}
	requirement.Status = StatusReady
	requirement.Progress = 5
	requirement.ProgressNote = strings.TrimSpace(note)
	if requirement.ProgressNote == "" {
		requirement.ProgressNote = "重新排期"
	}
	requirement.SessionID = ""
	requirement.PeerMessageID = ""
	requirement.TurnID = ""
	requirement.LastError = ""
	requirement.UpdatedAt = service.Now()
	service.clearLoopMessage(requirement.ID)
	if err := service.store.SaveRequirement(ctx, requirement); err != nil {
		return Requirement{}, err
	}
	service.appendEvent(ctx, requirement.ID, "requeued", requirement.ProgressNote)
	service.Notify()
	return requirement, nil
}

// Cancel 中断需求对应的执行会话。
func (service *Service) Cancel(ctx context.Context, dispatcher Dispatcher, id string) (Requirement, error) {
	requirement, err := service.store.GetRequirement(ctx, id)
	if err != nil {
		return Requirement{}, err
	}
	if !requirement.IsActive() {
		return Requirement{}, fmt.Errorf("%w: 需求当前没有执行中会话", ErrConflict)
	}
	if dispatcher != nil && requirement.SessionID != "" {
		_ = dispatcher.Interrupt(ctx, requirement.SessionID)
	}
	requirement.Status = StatusReady
	requirement.Progress = 0
	requirement.ProgressNote = "已取消，等待重新调度"
	requirement.SessionID = ""
	requirement.PeerMessageID = ""
	requirement.UpdatedAt = service.Now()
	service.clearLoopMessage(requirement.ID)
	if err := service.store.SaveRequirement(ctx, requirement); err != nil {
		return Requirement{}, err
	}
	service.appendEvent(ctx, requirement.ID, "canceled", "用户取消执行")
	service.Notify()
	return requirement, nil
}

// ApplyProgress 由执行器回写执行进度。
func (service *Service) ApplyProgress(ctx context.Context, requirementID string, update ProgressUpdate) {
	requirement, err := service.store.GetRequirement(ctx, requirementID)
	if err != nil {
		return
	}
	if update.SessionID != "" && requirement.SessionID != "" && update.SessionID != requirement.SessionID {
		return
	}
	if update.Status != "" {
		status, statusErr := NormalizeStatus(update.Status)
		if statusErr == nil && status != requirement.Status {
			if Transition(requirement.Status, status) == nil {
				requirement.Status = status
			}
		}
	}
	if update.Progress > requirement.Progress {
		requirement.Progress = clampProgress(update.Progress)
	}
	if update.Note != "" {
		requirement.ProgressNote = update.Note
	}
	if update.TurnID != "" {
		requirement.TurnID = update.TurnID
	}
	if update.LastError != "" {
		requirement.LastError = update.LastError
	}
	if update.StepIndex >= 0 && update.StepIndex < len(requirement.Steps) {
		requirement.Steps[update.StepIndex].Status = update.StepStatus
	}
	if requirement.Status == StatusDone {
		requirement.Progress = 100
	}
	requirement.UpdatedAt = service.Now()
	if err := service.store.SaveRequirement(ctx, requirement); err != nil {
		return
	}
	service.appendEvent(ctx, requirement.ID, "progress", update.Note)
	service.Notify()
}

// ContinueLoop 在 loop 模式一轮结束后做自动验收：完成标记 → 直接停止；
// 无标记 → AI 验收员判断；连续两轮回复完全相同 → 自动停止等待人工确认。
// 不再用固定 5 轮强行截断。
func (service *Service) ContinueLoop(ctx context.Context, id, finalMessage string, hadWork bool) {
	requirement, err := service.store.GetRequirement(ctx, id)
	if err != nil || requirement.Mode != ModeLoop || requirement.Status != StatusReview {
		return
	}
	if requirement.LoopCount >= LoopSafetyLimit {
		requirement.ProgressNote = fmt.Sprintf("循环已达到安全上限 %d 轮，请人工确认", LoopSafetyLimit)
		requirement.UpdatedAt = service.Now()
		_ = service.store.SaveRequirement(ctx, requirement)
		service.appendEvent(ctx, requirement.ID, "loop.blocked", requirement.ProgressNote)
		service.Notify()
		return
	}
	normalizedMessage := strings.TrimSpace(finalMessage)
	service.loopMu.Lock()
	previousMessage, seenPrevious := service.lastLoopMessage[requirement.ID]
	if seenPrevious && previousMessage == normalizedMessage {
		service.loopMu.Unlock()
		service.stopLoopStalled(ctx, requirement)
		return
	}
	service.lastLoopMessage[requirement.ID] = normalizedMessage
	service.loopMu.Unlock()
	if HasLoopMarker(finalMessage, LoopDoneMarker) {
		service.finishLoop(ctx, requirement, "模型输出完成标记")
		return
	}
	if HasLoopMarker(finalMessage, LoopContinueMarker) {
		service.continueLoop(ctx, requirement, "模型请求继续下一轮")
		return
	}
	settings, settingsErr := service.store.GetSchedulerSettings(ctx)
	if settingsErr != nil {
		settings = DefaultSchedulerSettings()
	}
	settings = settings.Normalized()
	decision := LoopDecision{}
	decided := false
	if service.model != nil {
		output, modelErr := service.model.Complete(ctx, ModelRequest{
			Provider: settings.Provider, Model: settings.Model, AccountRef: settings.AccountRef,
			System: LoopJudgeSystemPrompt, Prompt: BuildLoopJudgePrompt(requirement, finalMessage, hadWork),
		})
		if modelErr == nil {
			decision, decided = ParseLoopDecision(output)
		}
	}
	if decided && decision.Done {
		reason := decision.Reason
		if reason == "" {
			reason = "验收通过"
		}
		service.finishLoop(ctx, requirement, reason)
		return
	}
	if decided && !decision.Done {
		next := decision.Next
		if next == "" {
			next = "继续推进未完成步骤"
		}
		service.continueLoop(ctx, requirement, next)
		return
	}
	if !hadWork && normalizedMessage == "" {
		reason := "loop 自动停止：本轮没有回复也没有工具事件，无法判断进展"
		requirement.Status = StatusReview
		requirement.ProgressNote = reason
		requirement.UpdatedAt = service.Now()
		_ = service.store.SaveRequirement(ctx, requirement)
		service.appendEvent(ctx, requirement.ID, "loop.stalled", reason)
		service.Notify()
		service.clearLoopMessage(requirement.ID)
		return
	}
	service.continueLoop(ctx, requirement, "未获得明确完成信号，继续下一轮")
}

// stopLoopStalled 在连续两轮回复完全相同时停止，避免模型空转。
func (service *Service) stopLoopStalled(ctx context.Context, requirement Requirement) {
	reason := "连续两轮回复没有新进展，循环已自动停止，请人工确认"
	requirement.Status = StatusReview
	requirement.Progress = 90
	requirement.ProgressNote = reason
	requirement.UpdatedAt = service.Now()
	_ = service.store.SaveRequirement(ctx, requirement)
	service.appendEvent(ctx, requirement.ID, "loop.stalled", reason)
	service.Notify()
	service.clearLoopMessage(requirement.ID)
}

func (service *Service) clearLoopMessage(id string) {
	service.loopMu.Lock()
	defer service.loopMu.Unlock()
	delete(service.lastLoopMessage, id)
}

func (service *Service) finishLoop(ctx context.Context, requirement Requirement, reason string) {
	service.clearLoopMessage(requirement.ID)
	requirement.Progress = 95
	requirement.ProgressNote = "目标已完成：" + reason
	requirement.LastError = ""
	requirement.UpdatedAt = service.Now()
	if err := service.store.SaveRequirement(ctx, requirement); err != nil {
		return
	}
	service.appendEvent(ctx, requirement.ID, "loop.completed", requirement.ProgressNote)
	service.Notify()
}

func (service *Service) continueLoop(ctx context.Context, requirement Requirement, next string) {
	requirement.Status = StatusReady
	requirement.Progress = 5
	requirement.LoopCount++
	requirement.ProgressNote = fmt.Sprintf("循环第 %d 轮：%s", requirement.LoopCount, strings.TrimSpace(next))
	requirement.SessionID = ""
	requirement.PeerMessageID = ""
	requirement.TurnID = ""
	requirement.LastError = ""
	requirement.UpdatedAt = service.Now()
	if err := service.store.SaveRequirement(ctx, requirement); err != nil {
		return
	}
	service.appendEvent(ctx, requirement.ID, "loop.continue", requirement.ProgressNote)
	service.Notify()
}

// MarkDone 由用户验收完成。
func (service *Service) MarkDone(ctx context.Context, id string) (Requirement, error) {
	return service.UpdateRequirement(ctx, id, RequirementPatch{Status: strPtr(StatusDone)})
}

// Settings 返回调度器设置。
func (service *Service) Settings(ctx context.Context) (SchedulerSettings, error) {
	settings, err := service.store.GetSchedulerSettings(ctx)
	if err != nil {
		return SchedulerSettings{}, err
	}
	return settings.Normalized(), nil
}

// UpdateSettings 更新调度器设置。
func (service *Service) UpdateSettings(ctx context.Context, settings SchedulerSettings) (SchedulerSettings, error) {
	settings = settings.Normalized()
	settings.UpdatedAt = service.Now()
	if err := service.store.SaveSchedulerSettings(ctx, settings); err != nil {
		return SchedulerSettings{}, err
	}
	service.Notify()
	return settings, nil
}

// Events 返回需求时间线。
func (service *Service) Events(ctx context.Context, id string) ([]Event, error) {
	return service.store.ListEvents(ctx, id, 100)
}

// Subscribe 返回需求变更通知；调用方必须执行 cancel。
func (service *Service) Subscribe() (<-chan struct{}, func()) {
	service.subscribersMu.Lock()
	defer service.subscribersMu.Unlock()
	if service.subscribers == nil {
		service.subscribers = map[int]chan struct{}{}
	}
	id := service.nextSubID
	service.nextSubID++
	channel := make(chan struct{}, 1)
	service.subscribers[id] = channel
	return channel, func() {
		service.subscribersMu.Lock()
		defer service.subscribersMu.Unlock()
		if existing, ok := service.subscribers[id]; ok {
			delete(service.subscribers, id)
			close(existing)
		}
	}
}

// Notify 通知所有订阅者；慢消费者不会阻塞写路径。
func (service *Service) Notify() {
	service.subscribersMu.Lock()
	defer service.subscribersMu.Unlock()
	for _, channel := range service.subscribers {
		select {
		case channel <- struct{}{}:
		default:
		}
	}
}

func (service *Service) appendEvent(ctx context.Context, requirementID, kind, message string) {
	_ = service.store.AppendEvent(ctx, Event{
		ID:            defaultNewID("evt"),
		RequirementID: requirementID,
		Kind:          kind,
		Message:       message,
		At:            service.Now(),
	})
}

func normalizeSteps(steps []Step) []Step {
	out := make([]Step, 0, len(steps))
	for _, step := range steps {
		text := strings.TrimSpace(step.Text)
		if text == "" {
			continue
		}
		status := strings.ToLower(strings.TrimSpace(step.Status))
		switch status {
		case "done", "running", "pending":
		default:
			status = "pending"
		}
		out = append(out, Step{Text: text, Status: status})
	}
	return out
}

func clampProgress(value int) int {
	if value < 0 {
		return 0
	}
	if value > 100 {
		return 100
	}
	return value
}

func strPtr(value string) *string { return &value }

// GoalObjective 返回写入会话 goal 的目标文本。
func (requirement Requirement) GoalObjective() string {
	description := strings.TrimSpace(requirement.Description)
	if description == "" {
		return requirement.Title
	}
	return requirement.Title + "\n\n" + description
}

// BuildWorkPrompt 把需求卡片展开成执行 Agent 的任务说明。
func BuildWorkPrompt(requirement Requirement) string {
	var builder strings.Builder
	builder.WriteString("你是「需求管理」派发的执行代理。现在开始处理一张需求卡片。\n\n")
	builder.WriteString("## 需求\n")
	builder.WriteString(requirement.Title)
	builder.WriteString("\n\n")
	if description := strings.TrimSpace(requirement.Description); description != "" {
		builder.WriteString("## 描述\n")
		builder.WriteString(description)
		builder.WriteString("\n\n")
	}
	if len(requirement.Steps) > 0 {
		builder.WriteString("## 已拆解步骤\n")
		for index, step := range requirement.Steps {
			builder.WriteString(fmt.Sprintf("%d. [%s] %s\n", index+1, step.Status, step.Text))
		}
		builder.WriteString("\n")
	}
	builder.WriteString("## 工作区\n")
	builder.WriteString("主目录：" + requirement.WorkspacePath + "\n")
	if label := strings.TrimSpace(requirement.WorkspaceLabel); label != "" {
		builder.WriteString("工作区名称：" + label + "\n")
	}
	builder.WriteString("\n## 执行模式\n")
	switch requirement.Mode {
	case ModeGoal:
		builder.WriteString("目标模式：先声明可验证的完成标准，然后持续推进直到目标达成；每完成一个阶段说明当前进度。\n")
	case ModeLoop:
		builder.WriteString(fmt.Sprintf("循环模式（第 %d 轮）：每轮结束检查目标是否达成；未达成时继续下一轮。只有在确实完成或需要用户决策时停止。\n", requirement.LoopCount+1))
		builder.WriteString("完成信号：如果目标已全部完成并通过验证，在最终回复的最后单独一行输出 [[REQUIREMENT_DONE]]；" +
			"如果仍有未完成项，输出 [[REQUIREMENT_CONTINUE]] 并列出下一步。系统会据此自动决定是否继续循环。\n")
	default:
		builder.WriteString("计划模式：先给出编号执行计划，再按计划逐步实现。\n")
	}
	builder.WriteString("\n## 要求\n")
	builder.WriteString("- 直接在工作区路径内修改文件并运行必要验证。\n")
	builder.WriteString("- 不要只输出建议或伪代码，要完成实际改动。\n")
	builder.WriteString("- 每完成一个步骤，在回复中标记该步骤为完成。\n")
	builder.WriteString("- 遇到需要用户决定的问题时明确说明，不要猜测关键产品决策。\n")
	builder.WriteString("- 结束时给出：改动摘要、验证结果、遗留风险。\n")
	return builder.String()
}
