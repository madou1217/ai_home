// Package requirementruntime 把需求卡片接到真实 AI 工作会话：调度器按顺序征召，
// 执行器通过 peer 投递任务，并把 chat 事件回写成卡片进度。
package requirementruntime

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/requirements"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/internal/runtime/chatruntime"
)

// Scheduler 是需求调度的后台循环。
type Scheduler struct {
	service    *requirements.Service
	dispatcher requirements.Dispatcher
	clock      func() time.Time
	interval   time.Duration

	mu        sync.Mutex
	runMu     sync.Mutex
	cancel    context.CancelFunc
	done      chan struct{}
	lastRun   int64
	lastError string
}

// NewScheduler 创建调度器。
func NewScheduler(service *requirements.Service, dispatcher requirements.Dispatcher, clock func() time.Time) *Scheduler {
	if clock == nil {
		clock = time.Now
	}
	return &Scheduler{service: service, dispatcher: dispatcher, clock: clock, interval: 5 * time.Second}
}

// Start 启动后台循环；重复调用是幂等的。
func (scheduler *Scheduler) Start(ctx context.Context) {
	if scheduler == nil || scheduler.service == nil {
		return
	}
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	if scheduler.cancel != nil {
		return
	}
	runCtx, cancel := context.WithCancel(ctx)
	scheduler.cancel = cancel
	scheduler.done = make(chan struct{})
	go scheduler.loop(runCtx, scheduler.done)
}

// Stop 停止后台循环并等待退出。
func (scheduler *Scheduler) Stop() {
	if scheduler == nil {
		return
	}
	scheduler.mu.Lock()
	cancel := scheduler.cancel
	done := scheduler.done
	scheduler.cancel = nil
	scheduler.done = nil
	scheduler.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
	}
}

func (scheduler *Scheduler) loop(ctx context.Context, done chan struct{}) {
	defer close(done)
	ticker := time.NewTicker(scheduler.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_, _ = scheduler.RunOnce(ctx)
		}
	}
}

// RunOnce 执行一次调度扫描。
func (scheduler *Scheduler) RunOnce(ctx context.Context) (summary requirements.DispatchSummary, err error) {
	if scheduler == nil || scheduler.service == nil || scheduler.dispatcher == nil {
		return summary, fmt.Errorf("requirement scheduler unavailable")
	}
	if !scheduler.runMu.TryLock() {
		return summary, nil
	}
	defer scheduler.runMu.Unlock()

	defer func() {
		scheduler.mu.Lock()
		scheduler.lastRun = requirements.NowMillis(scheduler.clock)
		scheduler.lastError = ""
		if err != nil {
			scheduler.lastError = err.Error()
		}
		scheduler.mu.Unlock()
	}()

	settings, settingsErr := scheduler.service.Settings(ctx)
	if settingsErr != nil {
		return summary, settingsErr
	}
	summary.LastRun = requirements.NowMillis(scheduler.clock)
	if !settings.Enabled {
		return summary, nil
	}
	snapshot, err := scheduler.service.List(ctx)
	if err != nil {
		return summary, err
	}
	summary.Scanned = len(snapshot.Requirements)
	byWorkspace := map[string][]requirements.Requirement{}
	activeByWorkspace := map[string]int{}
	activeNonParallel := map[string]bool{}
	for _, item := range snapshot.Requirements {
		if item.WorkspaceID == "" {
			continue
		}
		if item.IsActive() {
			activeByWorkspace[item.WorkspaceID]++
			if !item.Parallel {
				activeNonParallel[item.WorkspaceID] = true
			}
			continue
		}
		if item.Status == requirements.StatusReady {
			byWorkspace[item.WorkspaceID] = append(byWorkspace[item.WorkspaceID], item)
		}
	}
	for _, workspace := range snapshot.Workspaces {
		ready := byWorkspace[workspace.ID]
		if len(ready) == 0 {
			continue
		}
		requirements.SortRequirements(ready)
		active := activeByWorkspace[workspace.ID]
		capacity := workspace.MaxParallel
		if capacity <= 0 {
			capacity = 1
		}
		for _, item := range ready {
			if active >= capacity || (active > 0 && (activeNonParallel[workspace.ID] || !item.Parallel)) {
				summary.Skipped++
				continue
			}
			dispatched, dispatchErr := scheduler.service.Dispatch(ctx, scheduler.dispatcher, item.ID, "")
			if dispatchErr != nil {
				summary.Failed++
				summary.LastError = dispatchErr.Error()
				continue
			}
			if dispatched.Status == requirements.StatusRunning {
				summary.Started++
				active++
				if !item.Parallel {
					activeNonParallel[workspace.ID] = true
				}
			}
			if !item.Parallel {
				break
			}
		}
	}
	return summary, nil
}

// Status 返回调度器当前状态。
func (scheduler *Scheduler) Status() requirements.SchedulerStatus {
	status := requirements.SchedulerStatus{}
	if scheduler == nil || scheduler.service == nil {
		return status
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	settings, err := scheduler.service.Settings(ctx)
	if err == nil {
		status.Enabled = settings.Enabled
		status.Provider = settings.Provider
		status.Model = settings.Model
		status.AccountRef = settings.AccountRef
	}
	snapshot, listErr := scheduler.service.List(ctx)
	if listErr == nil {
		for _, item := range snapshot.Requirements {
			switch item.Status {
			case requirements.StatusRunning, requirements.StatusWaiting:
				status.Running++
			case requirements.StatusQueued:
				status.Queued++
			case requirements.StatusReady:
				status.Ready++
			}
		}
	}
	scheduler.mu.Lock()
	status.LastRun = scheduler.lastRun
	status.LastError = scheduler.lastError
	scheduler.mu.Unlock()
	if err != nil && status.LastError == "" {
		status.LastError = err.Error()
	}
	return status
}

// WorkDispatcher 负责创建 chat 工作会话、通过 peer 投递任务并回收事件。
type WorkDispatcher struct {
	Chat          ChatSessionPort
	Accounts      AccountCandidates
	AIHomeDir     string
	HostHomeDir   string
	SelfBaseURL   func() string
	ManagementKey func() string
	OnProgress    func(requirementID string, update requirements.ProgressUpdate)

	mu       sync.Mutex
	sessions map[string]sessionTrace
}

type sessionTrace struct {
	requirementID string
	cancel        func()
	completed     int
}

// ChatSessionPort 是执行器需要的 chat 运行时子集。
type ChatSessionPort interface {
	CreateSession(ctx context.Context, in chatruntime.CreateSessionInput) (*chatruntime.Session, error)
	DispatchCommand(ctx context.Context, sessionID string, input map[string]any) (map[string]any, error)
	Subscribe(sessionID string, listener chatruntime.EventListener) (func(), error)
}

// AccountCandidates 是账号路由候选读取端口。
type AccountCandidates interface {
	LoadRoutingCandidates(ctx context.Context, providerID string, modelID runtimecore.ModelID) (*accountapp.RoutingCandidates, error)
}

// NewWorkDispatcher 创建执行器。
func NewWorkDispatcher(chat ChatSessionPort, accounts AccountCandidates, aiHomeDir, hostHomeDir string, selfBaseURL func() string, managementKey func() string, onProgress func(string, requirements.ProgressUpdate)) *WorkDispatcher {
	return &WorkDispatcher{
		Chat:          chat,
		Accounts:      accounts,
		AIHomeDir:     strings.TrimSpace(aiHomeDir),
		HostHomeDir:   strings.TrimSpace(hostHomeDir),
		SelfBaseURL:   selfBaseURL,
		ManagementKey: managementKey,
		OnProgress:    onProgress,
		sessions:      map[string]sessionTrace{},
	}
}

// Start 创建会话并投递需求任务。
func (dispatcher *WorkDispatcher) Start(ctx context.Context, request requirements.WorkRequest) (requirements.WorkHandle, error) {
	if dispatcher == nil || dispatcher.Chat == nil {
		return requirements.WorkHandle{}, fmt.Errorf("chat_runtime_not_ready")
	}
	provider := strings.TrimSpace(request.Provider)
	if provider == "" {
		provider = "agy"
	}
	model := strings.TrimSpace(request.Model)
	if model == "" {
		model = "gemini-4-neon-xhigh"
	}
	accountRef := strings.TrimSpace(request.AccountRef)
	if accountRef == "" {
		resolved, err := dispatcher.resolveAccount(ctx, provider, model)
		if err != nil {
			return requirements.WorkHandle{}, err
		}
		accountRef = resolved
	}
	policy := map[string]any{
		"title":           request.Title,
		"model":           model,
		"reasoningEffort": "xhigh",
		"approvalMode":    "bypass",
	}
	session, err := dispatcher.Chat.CreateSession(ctx, chatruntime.CreateSessionInput{
		Provider:            provider,
		ExecutionAccountRef: accountRef,
		ProjectPath:         request.Workspace.PrimaryPath(),
		Policy:              policy,
	})
	if err != nil {
		return requirements.WorkHandle{}, fmt.Errorf("创建执行会话失败: %w", err)
	}
	// 目标/循环模式先写入会话目标，模型在每轮都能看到完成标准。
	if request.Mode == requirements.ModeGoal || request.Mode == requirements.ModeLoop {
		_, _ = dispatcher.Chat.DispatchCommand(ctx, session.SessionID, map[string]any{
			"commandId": request.RequirementID + ":goal",
			"type":      "session.goal.set",
			"payload":   map[string]any{"objective": request.GoalObjective},
		})
	}
	if cancel, subscribeErr := dispatcher.Chat.Subscribe(session.SessionID, func(event chatruntime.EventEnvelope) {
		dispatcher.handleEvent(request.RequirementID, session.SessionID, event)
	}); subscribeErr == nil {
		dispatcher.mu.Lock()
		dispatcher.sessions[session.SessionID] = sessionTrace{requirementID: request.RequirementID, cancel: cancel}
		dispatcher.mu.Unlock()
	}
	peerID, deliveryErr := dispatcher.sendPeer(ctx, session.SessionID, provider, request.Title, request.Prompt)
	if deliveryErr != nil {
		// peer 不可用时直接派发 turn，需求仍能执行；失败原因会留在 peer 收件箱。
		if _, directErr := dispatcher.Chat.DispatchCommand(ctx, session.SessionID, map[string]any{
			"commandId": request.RequirementID + ":turn:" + fmt.Sprintf("%d", time.Now().UnixNano()),
			"type":      "turn.submit",
			"payload":   map[string]any{"content": request.Prompt, "model": model, "reasoningEffort": "xhigh"},
		}); directErr != nil {
			return requirements.WorkHandle{}, fmt.Errorf("派发执行任务失败: %w (peer: %v)", directErr, deliveryErr)
		}
	}
	return requirements.WorkHandle{SessionID: session.SessionID, PeerMessageID: peerID}, nil
}

// Interrupt 中断执行会话。
func (dispatcher *WorkDispatcher) Interrupt(ctx context.Context, sessionID string) error {
	if dispatcher == nil || dispatcher.Chat == nil || strings.TrimSpace(sessionID) == "" {
		return nil
	}
	_, err := dispatcher.Chat.DispatchCommand(ctx, sessionID, map[string]any{
		"commandId": sessionID + ":interrupt:" + fmt.Sprintf("%d", time.Now().UnixNano()),
		"type":      "turn.interrupt",
		"payload":   map[string]any{},
	})
	return err
}

func (dispatcher *WorkDispatcher) resolveAccount(ctx context.Context, provider, model string) (string, error) {
	if dispatcher.Accounts == nil {
		return "", fmt.Errorf("没有可用的账号路由")
	}
	modelID, err := runtimecore.NewModelID(model)
	if err != nil {
		return "", fmt.Errorf("模型标识无效: %w", err)
	}
	candidates, err := dispatcher.Accounts.LoadRoutingCandidates(ctx, provider, modelID)
	if err != nil {
		return "", fmt.Errorf("读取账号候选失败: %w", err)
	}
	if candidates == nil || candidates.Len() == 0 {
		return "", fmt.Errorf("%s 没有支持模型 %s 的可用账号", provider, model)
	}
	account, ok := candidates.At(0)
	if !ok {
		return "", fmt.Errorf("%s 没有支持模型 %s 的可用账号", provider, model)
	}
	return account.Ref().String(), nil
}

func (dispatcher *WorkDispatcher) handleEvent(requirementID, sessionID string, event chatruntime.EventEnvelope) {
	if dispatcher.OnProgress == nil {
		return
	}
	switch event.Type {
	case "turn.started":
		dispatcher.OnProgress(requirementID, requirements.ProgressUpdate{Status: requirements.StatusRunning, Progress: 18, Note: "AI 开始执行", TurnID: event.TurnID, SessionID: sessionID})
	case "timeline.item.completed":
		item, _ := event.Payload["item"].(map[string]any)
		kind := strings.TrimSpace(fmt.Sprintf("%v", item["kind"]))
		status := strings.TrimSpace(fmt.Sprintf("%v", item["status"]))
		if status != "completed" {
			return
		}
		dispatcher.mu.Lock()
		trace := dispatcher.sessions[sessionID]
		trace.completed++
		dispatcher.sessions[sessionID] = trace
		completed := trace.completed
		dispatcher.mu.Unlock()
		progress := 20 + completed*7
		if progress > 85 {
			progress = 85
		}
		note := "AI 正在执行"
		switch kind {
		case "plan":
			note = "已生成执行计划"
		case "tool", "shell", "file_change":
			note = "正在执行：" + kind
		}
		dispatcher.OnProgress(requirementID, requirements.ProgressUpdate{Status: requirements.StatusRunning, Progress: progress, Note: note, TurnID: event.TurnID, SessionID: sessionID})
	case "interaction.requested":
		dispatcher.OnProgress(requirementID, requirements.ProgressUpdate{Status: requirements.StatusWaiting, Progress: 60, Note: "等待用户输入或审批", TurnID: event.TurnID, SessionID: sessionID})
	case "turn.completed":
		dispatcher.OnProgress(requirementID, requirements.ProgressUpdate{Status: requirements.StatusReview, Progress: 92, Note: "执行完成，等待验收", TurnID: event.TurnID, SessionID: sessionID})
	case "turn.failed":
		message := strings.TrimSpace(fmt.Sprintf("%v", event.Payload["message"]))
		if message == "" {
			message = "执行失败"
		}
		dispatcher.OnProgress(requirementID, requirements.ProgressUpdate{Status: requirements.StatusBlocked, Note: message, LastError: message, TurnID: event.TurnID, SessionID: sessionID})
	case "turn.interrupted":
		dispatcher.OnProgress(requirementID, requirements.ProgressUpdate{Status: requirements.StatusReady, Progress: 0, Note: "执行已中断", TurnID: event.TurnID, SessionID: sessionID})
	}
}
