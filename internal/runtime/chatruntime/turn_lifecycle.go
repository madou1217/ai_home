package chatruntime

import (
	"context"
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"
)

// RuntimeDescriptor 描述由 RuntimeResolver 解析出的单次执行作用域运行时。
type RuntimeDescriptor struct {
	Provider      string `json:"provider"`
	RuntimeScope  string `json:"runtimeScope"`
	Fingerprint   string `json:"fingerprint,omitempty"`
	Generation    int64  `json:"generation,omitempty"`
	HasGeneration bool   `json:"-"`
	Version       string `json:"version,omitempty"`
}

// DriverTurnContext 传递给驱动的轮次执行上下文。
type DriverTurnContext struct {
	SessionID  string
	TurnID     string
	RunID      string
	Command    *Command
	ImagePaths []string
	Trace      *TraceRecord
}

// ProviderRunResult 表示驱动单轮异步执行的最终结果。
type ProviderRunResult struct {
	Result map[string]any
	Err    error
}

// ProviderRun 描述由驱动启动的异步执行句柄。
type ProviderRun struct {
	NativeTurnID string
	Done         <-chan ProviderRunResult
	Abandon      func(reason string) string
}

// RecoverTurnInput 描述重连/重启恢复单轮的输入。
type RecoverTurnInput struct {
	SessionID           string
	TurnID              string
	RunID               string
	ActiveTurn          *ActiveTurn
	Queue               *QueueEntry
	PendingInteractions []Interaction
}

// Driver 是会话执行驱动的核心接口。
type Driver interface {
	StartTurn(ctx context.Context, tc DriverTurnContext) (*ProviderRun, error)
}

// TurnInterrupter 表示支持中断当前轮次的驱动。
type TurnInterrupter interface {
	InterruptTurn(ctx context.Context, tc DriverTurnContext) error
}

// TurnRecoverer 表示支持重启恢复正在进行轮次的驱动。
type TurnRecoverer interface {
	RecoverTurn(ctx context.Context, in RecoverTurnInput) (*ProviderRun, error)
}

// SlashExecutor 表示支持交互式或原生 slash 命令执行的驱动。
type SlashExecutor interface {
	SlashMode() string
	ExecuteSlash(ctx context.Context, tc DriverTurnContext) (*ProviderRun, error)
}

// ThreadCompactor 表示支持原生上下文压缩的驱动。
type ThreadCompactor interface {
	CompactThread(ctx context.Context, tc DriverTurnContext) (*ProviderRun, error)
}

// DynamicCommandProvider 允许组合驱动按命令类型懒解析专属处理器。
type DynamicCommandProvider interface {
	HandlerFor(commandType string) CommandHandler
}

// HistoryBranchPort 描述会话分支计划与原生操作端口。
type HistoryBranchPort interface {
	Plan(ctx context.Context, session *Session, cmd *Command) (map[string]any, error)
	Native() NativeBranchPort
}

// HistoryBranchDriver 表示支持历史分支的驱动。
type HistoryBranchDriver interface {
	HistoryBranchPort() HistoryBranchPort
}

// Disposer 表示需要显式释放底层资源的驱动。
type Disposer interface {
	Dispose() bool
}

// RuntimeResolveOptions 配置 RuntimeResolver.Resolve 参数。
type RuntimeResolveOptions struct {
	RuntimeScope string
	Chat         bool
}

// RuntimeResolver 解析某 provider + 执行作用域的运行时描述符。
type RuntimeResolver interface {
	Resolve(ctx context.Context, provider string, opts RuntimeResolveOptions) (RuntimeDescriptor, error)
}

// DriverResolveOptions 配置 DriverRegistry.Resolve 参数。
type DriverResolveOptions struct {
	Session *Session
	Runtime RuntimeDescriptor
}

// DriverEntry 绑定已构建的驱动、自定义处理器与能力求值器。
type DriverEntry struct {
	Driver          Driver
	Handlers        map[string]CommandHandler
	Capabilities    map[string]any
	CapabilitiesFor func(*Session) map[string]any
	ComposerCatalog func(ctx context.Context) (map[string]any, error)
}

// DriverRegistry 为指定会话及运行时提供驱动装配。
type DriverRegistry interface {
	Resolve(ctx context.Context, provider string, opts DriverResolveOptions) (*DriverEntry, error)
}

// CommandHandlerContext 为通用/驱动命令处理器提供运行时上下文。
type CommandHandlerContext struct {
	SessionID     string
	Command       *Command
	Store         *PublishingStore
	Actor         *SessionActor
	HistoryBranch HistoryBranchPort
	Trace         *TraceRecord
}

// CommandHandler 处理单条非 turn.submit/turn.retry/turn.interrupt 的会话命令。
type CommandHandler func(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error)

// DisposeDriver 安全释放驱动资源（优先 Disposer，再尝试 io.Closer）。
func DisposeDriver(driver any) bool {
	if driver == nil {
		return false
	}
	if d, ok := driver.(Disposer); ok {
		return d.Dispose()
	}
	if c, ok := driver.(interface{ Close() error }); ok {
		return c.Close() == nil
	}
	return false
}

func coerceInt64(v any) (int64, bool) {
	switch x := v.(type) {
	case int:
		return int64(x), true
	case int64:
		return x, true
	case int32:
		return int64(x), true
	case uint:
		if uint64(x) <= math.MaxInt64 {
			return int64(x), true
		}
	case uint64:
		if x <= math.MaxInt64 {
			return int64(x), true
		}
	case uint32:
		return int64(x), true
	case float64:
		if !math.IsNaN(x) && !math.IsInf(x, 0) && x == math.Trunc(x) && x >= math.MinInt64 && x <= math.MaxInt64 {
			return int64(x), true
		}
	case float32:
		f := float64(x)
		if !math.IsNaN(f) && !math.IsInf(f, 0) && f == math.Trunc(f) {
			return int64(f), true
		}
	case json.Number:
		if n, err := x.Int64(); err == nil {
			return n, true
		}
		if f, err := x.Float64(); err == nil && !math.IsNaN(f) && !math.IsInf(f, 0) && f == math.Trunc(f) {
			return int64(f), true
		}
	}
	return 0, false
}

func coerceInt(v any) (int, bool) {
	n, ok := coerceInt64(v)
	if !ok || n < math.MinInt || n > math.MaxInt {
		return 0, false
	}
	return int(n), true
}

func itoa64(v int64) string {
	return strconv.FormatInt(v, 10)
}

// DiagnosticMap 将 CanonicalDiagnostic 规范序列化为 JSON 友好映射。
func DiagnosticMap(d CanonicalDiagnostic, includeStatusCode bool) map[string]any {
	out := map[string]any{
		"code":    d.Code,
		"message": d.Message,
	}
	if includeStatusCode && d.StatusCode > 0 {
		out["statusCode"] = d.StatusCode
	}
	if len(d.Details) > 0 {
		out["details"] = CloneMap(d.Details)
	}
	return out
}

func serializeCommandError(err error) map[string]any {
	return DiagnosticMap(SanitizeCanonicalDiagnostic(err, DiagnosticOptions{
		FallbackCode:      "chat_command_failed",
		IncludeStatusCode: true,
	}), true)
}

func CloneCommand(cmd *Command) *Command {
	if cmd == nil {
		return nil
	}
	cp := *cmd
	cp.Payload = CloneMap(cmd.Payload)
	if cmd.Result != nil {
		cp.Result = CloneMap(cmd.Result)
	}
	return &cp
}

// TerminalSettlement 描述单轮结束时的持久化与队列交接信息。
type TerminalSettlement struct {
	Type        string
	Outcome     string
	QueueResult map[string]any
	Payload     map[string]any
}

// TerminalResult 将异步驱动的结束状态映射为 turn.completed / turn.interrupted / turn.failed。
func TerminalResult(submissionCommandID string, interruptRequested bool, result map[string]any, err error) TerminalSettlement {
	basePayload := map[string]any{"state": "idle"}
	if err != nil && isOutcomeUnknownError(err) {
		p := CloneMap(basePayload)
		p["retryable"] = false
		p["outcomeUnknown"] = true
		return failedTerminalResult(p, err)
	}
	statusStr, _ := result["status"].(string)
	if interruptRequested || statusStr == "interrupted" {
		p := CloneMap(basePayload)
		p["reason"] = "user_stop"
		return TerminalSettlement{
			Type:        "turn.interrupted",
			Outcome:     "failed",
			QueueResult: map[string]any{"interrupted": true, "reason": "user_stop"},
			Payload:     p,
		}
	}
	if err != nil {
		p := CloneMap(basePayload)
		p["retryable"] = strings.TrimSpace(submissionCommandID) != ""
		return failedTerminalResult(p, err)
	}
	return TerminalSettlement{
		Type:        "turn.completed",
		Outcome:     "completed",
		QueueResult: map[string]any{},
		Payload:     basePayload,
	}
}

func failedTerminalResult(payload map[string]any, err error) TerminalSettlement {
	serialized := DiagnosticMap(SanitizeCanonicalDiagnostic(err, DiagnosticOptions{
		FallbackCode: "chat_turn_failed",
	}), false)
	payload["error"] = serialized
	return TerminalSettlement{
		Type:        "turn.failed",
		Outcome:     "failed",
		QueueResult: map[string]any{"error": serialized},
		Payload:     payload,
	}
}

func isOutcomeUnknownError(err error) bool {
	if err == nil {
		return false
	}
	if rtErr, ok := AsRuntimeError(err); ok {
		if flag, ok := rtErr.Details["outcomeUnknown"].(bool); ok && flag {
			return true
		}
	}
	if tagged, ok := err.(interface{ OutcomeUnknown() bool }); ok {
		return tagged.OutcomeUnknown()
	}
	return false
}

// activeRun 保存正在执行的轮次内存句柄。
type activeRun struct {
	TurnID              string
	RunID               string
	StartedAt           int64
	SubmissionCommandID string
	ClientUserMessageID string
	NativeTurnID        string
	InterruptRequested  bool
	ImagePaths          []string
	Queue               *QueueStepInput
	Trace               *TraceRecord
}

// TurnLifecycleOptions 配置单个会话的轮次生命周期控制器。
type TurnLifecycleOptions struct {
	SessionID string
	Store     *PublishingStore
	Driver    Driver
	IDFactory func(string) string
	Clock     func() int64
	Enqueue   func(func())
	RunCtx    context.Context
}

// TurnLifecycle 负责提交、重试、中断、恢复和结算单个会话的活动轮次。
type TurnLifecycle struct {
	sessionID string
	store     *PublishingStore
	driver    Driver
	idFactory func(string) string
	clock     func() int64
	enqueue   func(func())
	runCtx    context.Context

	stateMu sync.Mutex
	active  *activeRun
	idleCh  chan struct{}
	watchWG sync.WaitGroup
}

// NewTurnLifecycle 构造轮次生命周期控制器。
func NewTurnLifecycle(opts TurnLifecycleOptions) *TurnLifecycle {
	idFactory := opts.IDFactory
	if idFactory == nil {
		idFactory = DefaultIDFactory
	}
	clock := opts.Clock
	if clock == nil {
		clock = func() int64 { return time.Now().UnixMilli() }
	}
	runCtx := opts.RunCtx
	if runCtx == nil {
		runCtx = context.Background()
	}
	idleCh := make(chan struct{})
	close(idleCh)
	tl := &TurnLifecycle{
		sessionID: opts.SessionID,
		store:     opts.Store,
		driver:    opts.Driver,
		idFactory: idFactory,
		clock:     clock,
		enqueue:   opts.Enqueue,
		runCtx:    runCtx,
		idleCh:    idleCh,
	}
	if tl.enqueue == nil {
		tl.enqueue = func(fn func()) {
			if fn != nil {
				fn()
			}
		}
	}
	return tl
}

// IsActive 线程安全地检查当前是否有轮次在执行。
func (t *TurnLifecycle) IsActive() bool {
	if t == nil {
		return false
	}
	t.stateMu.Lock()
	active := t.active != nil
	t.stateMu.Unlock()
	return active
}

// EnsureCanSubmit 验证当前会话空闲且驱动支持开启轮次。
func (t *TurnLifecycle) EnsureCanSubmit() error {
	if t.IsActive() {
		return NewError("chat_turn_already_active", 409, nil)
	}
	if t.driver == nil {
		return NewError("chat_turn_driver_unavailable", 422, nil)
	}
	return nil
}

// WaitForIdle 等待当前轮次完全结算（或上下文取消）。
func (t *TurnLifecycle) WaitForIdle(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	for {
		t.stateMu.Lock()
		ch := t.idleCh
		active := t.active != nil
		t.stateMu.Unlock()
		if !active {
			return nil
		}
		select {
		case <-ch:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// WaitWatchers 等待所有异步 watcher 退出（用于清理关闭）。
func (t *TurnLifecycle) WaitWatchers() {
	if t != nil {
		t.watchWG.Wait()
	}
}

// Dispose 释放底层驱动资源。
func (t *TurnLifecycle) Dispose() bool {
	return DisposeDriver(t.driver)
}

func (t *TurnLifecycle) setActiveRun(run *activeRun) {
	t.stateMu.Lock()
	t.active = run
	t.idleCh = make(chan struct{})
	t.stateMu.Unlock()
}

func (t *TurnLifecycle) clearActiveRun(run *activeRun) {
	t.stateMu.Lock()
	if t.active == run {
		t.active = nil
		close(t.idleCh)
	}
	t.stateMu.Unlock()
}

func (t *TurnLifecycle) currentActiveRun() *activeRun {
	t.stateMu.Lock()
	run := t.active
	t.stateMu.Unlock()
	return run
}

// Submit 开启新的一轮（或 slash.execute 触发的轮次）。
func (t *TurnLifecycle) Submit(ctx context.Context, cmd *Command, queue *QueueStepInput, trace *TraceRecord) (map[string]any, error) {
	if err := t.EnsureCanSubmit(); err != nil {
		return nil, err
	}
	imagePaths, err := t.resolveImagePaths(ctx, cmd)
	if err != nil {
		return nil, err
	}
	run := t.createRun(cmd, queue, trace, imagePaths)
	t.setActiveRun(run)
	if err := t.begin(ctx, run, cmd); err != nil {
		t.clearActiveRun(run)
		return nil, err
	}

	tc := t.driverContext(run, cmd)
	var providerRun *ProviderRun
	var startErr error
	if cmd != nil && cmd.Type == "slash.execute" {
		if se, ok := t.driver.(SlashExecutor); ok {
			providerRun, startErr = se.ExecuteSlash(t.runCtx, tc)
		} else if tcDriver, ok := t.driver.(ThreadCompactor); ok {
			providerRun, startErr = tcDriver.CompactThread(t.runCtx, tc)
		} else {
			startErr = NewError("chat_slash_execution_unsupported", 422, nil)
		}
	} else {
		providerRun, startErr = t.driver.StartTurn(t.runCtx, tc)
	}
	if startErr != nil {
		t.failStart(ctx, run, startErr)
		return nil, startErr
	}
	if providerRun == nil {
		providerRun = &ProviderRun{}
	}
	t.watch(run, providerRun)
	if _, err := t.transition(ctx, run, "running", "turn.started", nil); err != nil {
		return nil, err
	}
	return map[string]any{
		"turnId": run.TurnID,
		"runId":  run.RunID,
		"state":  "running",
	}, nil
}

// Retry 使用最近失败轮次的原始提交指令重新发起一轮。
func (t *TurnLifecycle) Retry(ctx context.Context, cmd *Command, trace *TraceRecord) (map[string]any, error) {
	if err := t.EnsureCanSubmit(); err != nil {
		return nil, err
	}
	sourceTurnID, _ := cmd.Payload["sourceTurnId"].(string)
	source, err := t.store.GetRetrySubmission(ctx, t.sessionID, sourceTurnID)
	if err != nil {
		return nil, err
	}
	cloned := CloneCommand(cmd)
	cloned.Type = "turn.submit"
	cloned.Payload = CloneMap(source.Payload)
	if cloned.Payload == nil {
		cloned.Payload = make(map[string]any)
	}
	if source.CommandID != "" {
		cloned.Payload["submissionCommandId"] = source.CommandID
	}
	return t.Submit(ctx, cloned, nil, trace)
}

// Interrupt 请求中断当前活动轮次。
func (t *TurnLifecycle) Interrupt(ctx context.Context, cmd *Command) (map[string]any, error) {
	run := t.currentActiveRun()
	if run == nil {
		return nil, NewError("chat_turn_not_active", 409, nil)
	}
	interrupter, ok := t.driver.(TurnInterrupter)
	if !ok {
		return nil, NewError("chat_turn_interrupt_unsupported", 422, nil)
	}
	reason, _ := cmd.Payload["reason"].(string)
	if strings.TrimSpace(reason) == "" {
		reason = "user_stop"
	}
	if _, err := t.transition(ctx, run, "interrupting", "turn.interrupt.requested", map[string]any{
		"reason": reason,
	}); err != nil {
		return nil, err
	}
	run.InterruptRequested = true
	if err := interrupter.InterruptTurn(ctx, t.driverContext(run, cmd)); err != nil {
		run.InterruptRequested = false
		_, _ = t.transition(ctx, run, "running", "turn.phase.changed", nil)
		return nil, err
	}
	return map[string]any{
		"turnId": run.TurnID,
		"runId":  run.RunID,
		"state":  "interrupting",
	}, nil
}

// Rehydrate 在进程重启后重新挂接先前的活动轮次。
func (t *TurnLifecycle) Rehydrate(ctx context.Context, recovery *RecoveryState) (map[string]any, error) {
	if t.IsActive() {
		return nil, NewError("chat_turn_already_active", 409, nil)
	}
	rehydrator := &TurnRehydrator{
		driver:    t.driver,
		sessionID: t.sessionID,
		store:     t.store,
	}
	restored, err := rehydrator.Rehydrate(ctx, recovery)
	if err != nil {
		return nil, err
	}
	t.setActiveRun(restored.Run)
	t.watch(restored.Run, restored.ProviderRun)
	return map[string]any{
		"turnId": restored.Run.TurnID,
		"runId":  restored.Run.RunID,
		"state":  restored.State,
	}, nil
}

func (t *TurnLifecycle) createRun(cmd *Command, queue *QueueStepInput, trace *TraceRecord, imagePaths []string) *activeRun {
	runID := t.idFactory("run")
	subCmdID := ""
	if queue == nil && cmd != nil && cmd.Type == "turn.submit" {
		if explicit, _ := cmd.Payload["submissionCommandId"].(string); strings.TrimSpace(explicit) != "" {
			subCmdID = explicit
		} else {
			subCmdID = cmd.CommandID
		}
	}
	run := &activeRun{
		TurnID:              t.idFactory("turn"),
		RunID:               runID,
		StartedAt:           t.clock(),
		SubmissionCommandID: subCmdID,
		ClientUserMessageID: runID,
		ImagePaths:          imagePaths,
		Queue:               queue,
		Trace:               trace,
	}
	if trace != nil {
		trace.BindRun(run.RunID)
	}
	return run
}

func (t *TurnLifecycle) driverContext(run *activeRun, cmd *Command) DriverTurnContext {
	return DriverTurnContext{
		SessionID:  t.sessionID,
		TurnID:     run.TurnID,
		RunID:      run.RunID,
		Command:    cmd,
		ImagePaths: append([]string(nil), run.ImagePaths...),
		Trace:      run.Trace,
	}
}

func (t *TurnLifecycle) resolveImagePaths(ctx context.Context, cmd *Command) ([]string, error) {
	if cmd == nil || cmd.Payload == nil {
		return nil, nil
	}
	ids, err := NormalizeAttachmentIDs(cmd.Payload["attachmentIds"], false)
	if err != nil || len(ids) == 0 {
		return nil, err
	}
	return t.store.ResolveAttachmentPaths(ctx, t.sessionID, ids)
}

func (t *TurnLifecycle) watch(run *activeRun, providerRun *ProviderRun) {
	doneCh := providerRun.Done
	t.watchWG.Add(1)
	go func() {
		defer t.watchWG.Done()
		var res ProviderRunResult
		if doneCh != nil {
			r, ok := <-doneCh
			if ok {
				res = r
			}
		}
		t.enqueue(func() {
			t.finish(run, res.Result, res.Err)
		})
	}()
}

func (t *TurnLifecycle) finish(run *activeRun, result map[string]any, runErr error) {
	if t.currentActiveRun() != run {
		return
	}
	defer t.clearActiveRun(run)
	_ = t.settle(context.Background(), run, result, runErr)
}

func (t *TurnLifecycle) failStart(ctx context.Context, run *activeRun, startErr error) {
	defer t.clearActiveRun(run)
	_ = t.settle(ctx, run, nil, startErr)
}

func (t *TurnLifecycle) settle(ctx context.Context, run *activeRun, result map[string]any, runErr error) error {
	term := TerminalResult(run.SubmissionCommandID, run.InterruptRequested, result, runErr)
	var queueStep *QueueStepInput
	if run.Queue != nil {
		q := *run.Queue
		q.Outcome = term.Outcome
		q.Result = term.QueueResult
		queueStep = &q
	}
	_, err := t.store.SettleTurn(ctx, t.sessionID, SettleTurnInput{
		Queue: queueStep,
		Event: t.eventDraft(ctx, term.Type, run, term.Payload),
	})
	return err
}

func (t *TurnLifecycle) begin(ctx context.Context, run *activeRun, cmd *Command) error {
	sess, err := t.store.GetSession(ctx, t.sessionID)
	if err != nil {
		return err
	}
	payload := map[string]any{}
	if cmd != nil && cmd.Payload != nil {
		payload = cmd.Payload
	}
	contentStr, _ := payload["content"].(string)
	contentTrim := strings.TrimSpace(contentStr)
	currentTitle := ""
	if sess != nil && sess.Policy != nil {
		currentTitle, _ = sess.Policy["title"].(string)
	}
	currentTitle = strings.TrimSpace(currentTitle)
	canAutoTitle := currentTitle == "" || currentTitle == "新对话" || currentTitle == "新会话"
	at := t.activeTurn(ctx, run, "starting")

	var policyPatch map[string]any
	if cmd != nil && cmd.Type == "turn.submit" {
		policyPatch = make(map[string]any)
		if canAutoTitle && contentTrim != "" && !strings.HasPrefix(contentTrim, "/") {
			titleRunes := []rune(strings.Join(strings.Fields(contentTrim), " "))
			if len(titleRunes) > 50 {
				titleRunes = titleRunes[:50]
			}
			policyPatch["title"] = string(titleRunes)
		}
		if modelStr, _ := payload["model"].(string); strings.TrimSpace(modelStr) != "" {
			policyPatch["model"] = modelStr
		}
		if effortStr, _ := payload["reasoningEffort"].(string); strings.TrimSpace(effortStr) != "" {
			policyPatch["reasoningEffort"] = effortStr
		}
	}

	evPayload := map[string]any{
		"state":      "starting",
		"activeTurn": at,
	}
	if run.SubmissionCommandID != "" {
		evPayload["submissionCommandId"] = run.SubmissionCommandID
	}

	_, err = t.store.BeginTurn(ctx, t.sessionID, BeginTurnInput{
		ActiveTurn:  at,
		ResumeQueue: cmd != nil && cmd.Type == "turn.submit",
		Policy:      policyPatch,
		Queue:       run.Queue,
		Event:       t.eventDraft(ctx, "turn.queued", run, evPayload),
	})
	return err
}

func (t *TurnLifecycle) transition(ctx context.Context, run *activeRun, state, evType string, extra map[string]any) (*ActiveTurn, error) {
	at := t.activeTurn(ctx, run, state)
	payload := CloneMap(extra)
	payload["state"] = state
	payload["activeTurn"] = at
	_, err := t.store.TransitionTurnPhase(ctx, t.sessionID, state, at, t.eventDraft(ctx, evType, run, payload))
	if err != nil {
		return nil, err
	}
	return at, nil
}

func (t *TurnLifecycle) activeTurn(ctx context.Context, run *activeRun, state string) *ActiveTurn {
	sess, _ := t.store.GetSession(ctx, t.sessionID)
	var existing *ActiveTurn
	if sess != nil && sess.ActiveTurn != nil && sess.ActiveTurn.RunID == run.RunID {
		existing = sess.ActiveTurn
	}
	at := &ActiveTurn{
		TurnID:              run.TurnID,
		RunID:               run.RunID,
		ClientUserMessageID: run.ClientUserMessageID,
		StartedAt:           run.StartedAt,
		NativeTurnID:        run.NativeTurnID,
		State:               state,
	}
	if existing != nil {
		if existing.ClientUserMessageID != "" {
			at.ClientUserMessageID = existing.ClientUserMessageID
		}
		if existing.StartedAt > 0 {
			at.StartedAt = existing.StartedAt
		}
		at.FirstTokenAt = existing.FirstTokenAt
		if existing.Metrics != nil {
			at.Metrics = CloneMap(existing.Metrics)
		}
		if existing.UsageTotals != nil {
			at.UsageTotals = CloneMap(existing.UsageTotals)
		}
		if existing.NativeTurnID != "" {
			at.NativeTurnID = existing.NativeTurnID
		}
	}
	if state == "interrupting" || run.InterruptRequested {
		at.InterruptRequested = true
	}
	return at
}

func (t *TurnLifecycle) eventDraft(ctx context.Context, evType string, run *activeRun, payload map[string]any) EventDraft {
	sess, _ := t.store.GetSession(ctx, t.sessionID)
	return EventDraft{
		Type:    evType,
		TurnID:  run.TurnID,
		RunID:   run.RunID,
		Source:  sessionEventSource(sess),
		Payload: payload,
	}
}

// RehydratedRunResult 描述重连恢复后的活动句柄状态。
type RehydratedRunResult struct {
	ActiveTurn  *ActiveTurn
	ProviderRun *ProviderRun
	Run         *activeRun
	State       string
}

// TurnRehydrator 负责恢复先前的原生运行句柄并在入库失败时优雅放弃句柄。
type TurnRehydrator struct {
	driver    Driver
	sessionID string
	store     *PublishingStore
}

// Rehydrate 执行原生轮次重挂接并提交持久化恢复状态。
func (r *TurnRehydrator) Rehydrate(ctx context.Context, recovery *RecoveryState) (*RehydratedRunResult, error) {
	recoverer, ok := r.driver.(TurnRecoverer)
	if recovery == nil || recovery.ActiveTurn == nil || !ok {
		return nil, NewError("chat_turn_recovery_unsupported", 422, nil)
	}
	run := &activeRun{
		TurnID:              recovery.ActiveTurn.TurnID,
		RunID:               recovery.ActiveTurn.RunID,
		StartedAt:           recovery.ActiveTurn.StartedAt,
		ClientUserMessageID: recovery.ActiveTurn.ClientUserMessageID,
		NativeTurnID:        recovery.ActiveTurn.NativeTurnID,
		InterruptRequested:  recovery.ActiveTurn.InterruptRequested,
		Queue:               queueStepFromEntry(recovery.Queue),
	}
	providerRun, err := recoverer.RecoverTurn(ctx, RecoverTurnInput{
		SessionID:           r.sessionID,
		TurnID:              run.TurnID,
		RunID:               run.RunID,
		ActiveTurn:          recovery.ActiveTurn,
		Queue:               recovery.Queue,
		PendingInteractions: append([]Interaction(nil), recovery.Interactions...),
	})
	if err != nil {
		return nil, err
	}
	if providerRun == nil {
		providerRun = &ProviderRun{}
	}
	attached, err := r.store.CompleteRestartRecovery(ctx, r.sessionID, CompleteRecoveryInput{
		NativeTurnID: providerRun.NativeTurnID,
	})
	if err != nil {
		cleanupStatus := abandonProviderRun(providerRun, "complete_recovery_failed")
		if rtErr, ok := AsRuntimeError(err); ok {
			if rtErr.Details == nil {
				rtErr.Details = make(map[string]any)
			}
			rtErr.Details["nativeCleanup"] = cleanupStatus
		}
		return nil, err
	}
	run.Queue = queueStepFromEntry(attached.Queue)
	state := ""
	if attached.Session != nil {
		state = attached.Session.State
	}
	return &RehydratedRunResult{
		ActiveTurn:  attached.ActiveTurn,
		ProviderRun: providerRun,
		Run:         run,
		State:       state,
	}, nil
}

func abandonProviderRun(providerRun *ProviderRun, reason string) string {
	if providerRun == nil || providerRun.Abandon == nil {
		return "unsupported"
	}
	res := providerRun.Abandon(reason)
	if strings.TrimSpace(res) == "" {
		return "completed"
	}
	return res
}

func queueStepFromEntry(q *QueueEntry) *QueueStepInput {
	if q == nil || q.QueueID == "" || q.LeaseID == "" {
		return nil
	}
	return &QueueStepInput{
		QueueID: q.QueueID,
		LeaseID: q.LeaseID,
	}
}

// SessionQueueLifecycle 在会话邮箱串行窗口内检查边界条件并派发下一条排队指令。
type SessionQueueLifecycle struct {
	turn      *TurnLifecycle
	idFactory func(string) string
}

// NewSessionQueueLifecycle 构造队列派发处理器。
func NewSessionQueueLifecycle(turn *TurnLifecycle, idFactory func(string) string) *SessionQueueLifecycle {
	if idFactory == nil {
		idFactory = DefaultIDFactory
	}
	return &SessionQueueLifecycle{turn: turn, idFactory: idFactory}
}

// Dispatch 实现 `queue.dispatch` 命令语义。
func (l *SessionQueueLifecycle) Dispatch(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
	cmd := hctx.Command
	if afterRunID, _ := cmd.Payload["afterRunId"].(string); strings.TrimSpace(afterRunID) != "" {
		sess, err := hctx.Store.GetSession(ctx, hctx.SessionID)
		if err != nil {
			return nil, err
		}
		if sess == nil || sess.State != "idle" || sess.ActiveTurn != nil || queueControlPaused(sess) || queueControlLastRunID(sess) != afterRunID {
			return map[string]any{"skipped": true, "reason": "queue_boundary_superseded"}, nil
		}
	}
	if err := l.turn.EnsureCanSubmit(); err != nil {
		return nil, err
	}
	queueID, _ := cmd.Payload["queueId"].(string)
	policy, _ := cmd.Payload["policy"].(string)
	item, err := hctx.Store.LeaseQueueItem(ctx, hctx.SessionID, LeaseQueueInput{
		QueueID: queueID,
		LeaseID: l.idFactory("lease"),
		Policy:  policy,
	})
	if err != nil {
		return nil, err
	}
	if item == nil {
		return nil, NewError("chat_queue_item_unavailable", 409, map[string]any{
			"queueId": queueID,
		})
	}
	subCmd := CloneCommand(cmd)
	subCmd.Type = "turn.submit"
	subCmd.Payload = CloneMap(item.Payload)
	started, err := l.turn.Submit(ctx, subCmd, &QueueStepInput{
		QueueID: item.QueueID,
		LeaseID: item.LeaseID,
	}, hctx.Trace)
	if err != nil {
		return nil, err
	}
	started["queueId"] = item.QueueID
	return started, nil
}

func queueControlPaused(sess *Session) bool {
	if sess == nil || sess.Policy == nil {
		return false
	}
	ctrl, _ := sess.Policy["queueControl"].(map[string]any)
	if ctrl == nil {
		return false
	}
	paused, _ := ctrl["paused"].(bool)
	return paused
}

func queueControlLastRunID(sess *Session) string {
	if sess == nil || sess.Policy == nil {
		return ""
	}
	ctrl, _ := sess.Policy["queueControl"].(map[string]any)
	if ctrl == nil {
		return ""
	}
	id, _ := ctrl["lastRunId"].(string)
	return id
}

// InteractionResolutionCoordinator 以「先占锁认领 -> 执行驱动动作 -> 完成或释放」两阶段处理交互解决。
type InteractionResolutionCoordinator struct {
	store              *PublishingStore
	releaseFailureSink func(map[string]any)
}

// NewInteractionResolutionCoordinator 构造交互两阶段协调器。
func NewInteractionResolutionCoordinator(store *PublishingStore, releaseFailureSink func(map[string]any)) *InteractionResolutionCoordinator {
	if releaseFailureSink == nil {
		releaseFailureSink = func(map[string]any) {}
	}
	return &InteractionResolutionCoordinator{
		store:              store,
		releaseFailureSink: releaseFailureSink,
	}
}

// InteractionResolveOutput 描述两阶段交互解决结果。
type InteractionResolveOutput struct {
	Interaction *Interaction
	Response    map[string]any
}

// Resolve 认领交互并执行驱动回调；若回调失败则回退认领状态而不掩盖原始错误。
func (c *InteractionResolutionCoordinator) Resolve(
	ctx context.Context,
	interactionID string,
	input ResolveInteractionInput,
	effect func(claimed *Interaction) (map[string]any, error),
) (*InteractionResolveOutput, error) {
	if effect == nil {
		return nil, NewError("chat_interaction_effect_required", 500, nil)
	}
	claimed, err := c.store.ClaimInteractionResolution(ctx, interactionID, input)
	if err != nil {
		return nil, err
	}
	response, effectErr := effect(claimed)
	if effectErr != nil {
		if _, relErr := c.store.ReleaseInteractionResolution(ctx, claimed); relErr != nil {
			c.reportReleaseFailure(claimed)
		}
		return nil, effectErr
	}
	finished, err := c.store.FinishInteractionResolution(ctx, claimed)
	if err != nil {
		return nil, err
	}
	return &InteractionResolveOutput{
		Interaction: finished,
		Response:    response,
	}, nil
}

func (c *InteractionResolutionCoordinator) reportReleaseFailure(claimed *Interaction) {
	diag := map[string]any{
		"code":          "chat_interaction_release_failed",
		"interactionId": "",
		"revision":      0,
	}
	if claimed != nil {
		diag["interactionId"] = claimed.InteractionID
		diag["revision"] = claimed.Revision
		if claimed.SessionID != "" {
			diag["sessionId"] = claimed.SessionID
		}
	}
	c.releaseFailureSink(diag)
}
