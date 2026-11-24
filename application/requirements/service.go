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
}

// Snapshot 是页面一次加载所需的完整读模型。
type Snapshot struct {
	Workspaces   []Workspace       `json:"workspaces"`
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
		store:       store,
		model:       model,
		clock:       clock,
		newID:       defaultNewID,
		subscribers: map[int]chan struct{}{},
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
	workspaces, err := service.store.ListWorkspaces(ctx)
	if err != nil {
		return Snapshot{}, err
	}
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
		Workspaces:   workspaces,
		Requirements: items,
		Settings:     settings.Normalized(),
		GeneratedAt:  service.Now(),
	}, nil
}

// CreateWorkspace 创建一个绑定一到多个项目路径的工作区。
func (service *Service) CreateWorkspace(ctx context.Context, workspace Workspace) (Workspace, error) {
	if err := workspace.Normalize(); err != nil {
		return Workspace{}, err
	}
	now := service.Now()
	workspace.ID = strings.TrimSpace(workspace.ID)
	if workspace.ID == "" {
		workspace.ID = service.newID("ws")
	}
	workspace.CreatedAt = now
	workspace.UpdatedAt = now
	if err := service.store.SaveWorkspace(ctx, workspace); err != nil {
		return Workspace{}, err
	}
	service.Notify()
	return workspace, nil
}

// UpdateWorkspace 更新工作区；已有需求引用时不允许删除最后一条路径。
func (service *Service) UpdateWorkspace(ctx context.Context, id string, workspace Workspace) (Workspace, error) {
	current, err := service.store.GetWorkspace(ctx, id)
	if err != nil {
		return Workspace{}, err
	}
	workspace.ID = current.ID
	workspace.CreatedAt = current.CreatedAt
	if err := workspace.Normalize(); err != nil {
		return Workspace{}, err
	}
	workspace.UpdatedAt = service.Now()
	if err := service.store.SaveWorkspace(ctx, workspace); err != nil {
		return Workspace{}, err
	}
	service.Notify()
	return workspace, nil
}

// DeleteWorkspace 删除工作区；仍有需求引用时拒绝。
func (service *Service) DeleteWorkspace(ctx context.Context, id string) error {
	if strings.TrimSpace(id) == "" {
		return ErrInvalid
	}
	items, err := service.store.ListRequirements(ctx)
	if err != nil {
		return err
	}
	for _, item := range items {
		if item.WorkspaceID == id && !item.IsActive() {
			return fmt.Errorf("%w: 工作区仍被需求 %s 引用，请先迁移或删除该需求", ErrConflict, item.Title)
		}
		if item.WorkspaceID == id && item.IsActive() {
			return fmt.Errorf("%w: 工作区仍有执行中的需求 %s", ErrConflict, item.Title)
		}
	}
	if err := service.store.DeleteWorkspace(ctx, id); err != nil {
		return err
	}
	service.Notify()
	return nil
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
	requirement.WorkspaceID = strings.TrimSpace(requirement.WorkspaceID)
	if requirement.WorkspaceID != "" {
		if _, err := service.store.GetWorkspace(ctx, requirement.WorkspaceID); err != nil {
			return Requirement{}, err
		}
	}
	if requirement.Status == StatusReady && requirement.WorkspaceID == "" {
		return Requirement{}, fmt.Errorf("%w: 进入排期前必须绑定工作区", ErrInvalid)
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
	if patch.WorkspaceID != nil {
		workspaceID := strings.TrimSpace(*patch.WorkspaceID)
		if workspaceID != "" {
			if _, err := service.store.GetWorkspace(ctx, workspaceID); err != nil {
				return Requirement{}, err
			}
		}
		if current.IsActive() && workspaceID != current.WorkspaceID {
			return Requirement{}, fmt.Errorf("%w: 执行中的需求不能切换工作区", ErrConflict)
		}
		next.WorkspaceID = workspaceID
	}
	if patch.Status != nil {
		status, err := NormalizeStatus(*patch.Status)
		if err != nil {
			return Requirement{}, err
		}
		if status == StatusReady && next.WorkspaceID == "" {
			return Requirement{}, fmt.Errorf("%w: 进入排期前必须绑定工作区", ErrInvalid)
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

// Refine 手动触发 AI 需求优化；必须指定工作区。
func (service *Service) Refine(ctx context.Context, id string, workspaceID string) (Requirement, error) {
	requirement, err := service.store.GetRequirement(ctx, id)
	if err != nil {
		return Requirement{}, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		workspaceID = requirement.WorkspaceID
	}
	if workspaceID == "" {
		return Requirement{}, fmt.Errorf("%w: 优化需求前必须指定工作区", ErrInvalid)
	}
	workspace, err := service.store.GetWorkspace(ctx, workspaceID)
	if err != nil {
		return Requirement{}, err
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
		Provider:   firstNonEmpty(workspace.Provider, settings.Provider),
		Model:      firstNonEmpty(workspace.Model, settings.Model),
		AccountRef: firstNonEmpty(workspace.AccountRef, settings.AccountRef),
		System:     RefineSystemPrompt,
		Prompt:     BuildRefinePrompt(requirement, workspace),
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
	requirement.WorkspaceID = workspace.ID
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
func (service *Service) Dispatch(ctx context.Context, dispatcher Dispatcher, id string, workspaceID string) (Requirement, error) {
	requirement, err := service.store.GetRequirement(ctx, id)
	if err != nil {
		return Requirement{}, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID != "" && requirement.WorkspaceID != workspaceID {
		if requirement.IsActive() {
			return Requirement{}, fmt.Errorf("%w: 执行中的需求不能切换工作区", ErrConflict)
		}
		requirement.WorkspaceID = workspaceID
	}
	if requirement.WorkspaceID == "" {
		return Requirement{}, fmt.Errorf("%w: 调度前必须绑定唯一工作区", ErrInvalid)
	}
	if requirement.Status != StatusReady {
		return Requirement{}, fmt.Errorf("%w: 只有已确认的需求可以调度，当前状态 %s", ErrConflict, requirement.Status)
	}
	if dispatcher == nil {
		return Requirement{}, fmt.Errorf("%w: 执行器未配置", ErrInvalid)
	}
	workspace, err := service.store.GetWorkspace(ctx, requirement.WorkspaceID)
	if err != nil {
		return Requirement{}, err
	}
	settings, err := service.store.GetSchedulerSettings(ctx)
	if err != nil {
		return Requirement{}, err
	}
	settings = settings.Normalized()
	provider := firstNonEmpty(workspace.Provider, settings.Provider)
	model := firstNonEmpty(workspace.Model, settings.Model)
	accountRef := firstNonEmpty(workspace.AccountRef, settings.AccountRef)

	requirement.Status = StatusQueued
	requirement.Progress = 3
	requirement.ProgressNote = "调度器已领取，正在创建执行会话"
	requirement.LastError = ""
	requirement.UpdatedAt = service.Now()
	if err := service.store.SaveRequirement(ctx, requirement); err != nil {
		return Requirement{}, err
	}
	service.appendEvent(ctx, requirement.ID, "queued", "调度器已领取需求")
	service.Notify()

	handle, startErr := dispatcher.Start(ctx, WorkRequest{
		RequirementID: requirement.ID,
		Title:         requirement.Title,
		Prompt:        BuildWorkPrompt(requirement, workspace),
		Mode:          requirement.Mode,
		Workspace:     workspace,
		Provider:      provider,
		Model:         model,
		AccountRef:    accountRef,
		GoalObjective: requirement.GoalObjective(),
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
	now := service.Now()
	requirement.SessionID = handle.SessionID
	requirement.PeerMessageID = handle.PeerMessageID
	requirement.Status = StatusRunning
	requirement.Progress = 10
	requirement.ProgressNote = "AI 已开始执行"
	requirement.StartedAt = now
	requirement.UpdatedAt = now
	if err := service.store.SaveRequirement(ctx, requirement); err != nil {
		return Requirement{}, err
	}
	service.appendEvent(ctx, requirement.ID, "running", "AI 工作会话已启动")
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
	if requirement.Status == StatusReview && requirement.Mode == ModeLoop {
		service.scheduleLoopContinue(ctx, requirement)
	}
}

// scheduleLoopContinue 在 loop 模式下自动开始下一轮，直到人工验收或轮次上限。
func (service *Service) scheduleLoopContinue(ctx context.Context, requirement Requirement) {
	if requirement.LoopCount >= 5 || requirement.Status != StatusReview {
		return
	}
	requirement.Status = StatusReady
	requirement.Progress = 5
	requirement.ProgressNote = fmt.Sprintf("循环模式第 %d 轮继续", requirement.LoopCount+1)
	requirement.LoopCount++
	requirement.SessionID = ""
	requirement.PeerMessageID = ""
	requirement.UpdatedAt = service.Now()
	if err := service.store.SaveRequirement(ctx, requirement); err != nil {
		return
	}
	service.appendEvent(ctx, requirement.ID, "loop", requirement.ProgressNote)
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

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
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
func BuildWorkPrompt(requirement Requirement, workspace Workspace) string {
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
	builder.WriteString("主目录：" + workspace.PrimaryPath() + "\n")
	if len(workspace.ProjectPaths) > 1 {
		builder.WriteString("其它绑定路径：\n")
		for _, path := range workspace.ProjectPaths[1:] {
			builder.WriteString("- " + path + "\n")
		}
	}
	builder.WriteString("\n## 执行模式\n")
	switch requirement.Mode {
	case ModeGoal:
		builder.WriteString("目标模式：先声明可验证的完成标准，然后持续推进直到目标达成；每完成一个阶段说明当前进度。\n")
	case ModeLoop:
		builder.WriteString(fmt.Sprintf("循环模式（第 %d 轮）：每轮结束检查目标是否达成；未达成时继续下一轮。只有在确实完成或需要用户决策时停止。\n", requirement.LoopCount+1))
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
