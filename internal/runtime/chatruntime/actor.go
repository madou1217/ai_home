package chatruntime

import (
	"context"
	"maps"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

var (
	goalClearPattern = regexp.MustCompile(`(?i)^(clear|off|none)$`)

	immutablePolicyKeys = map[string]struct{}{
		"legacySessionId": {},
		"archived":        {},
		"lineage":         {},
		"contextState":    {},
		"queueControl":    {},
	}

	interactionCommandKinds = map[string]string{
		"interaction.answer": "question",
		"approval.decide":    "approval",
	}
)

// CreateGenericCommandHandlers 返回所有会话模式共享的通用命令处理器映射。
func CreateGenericCommandHandlers(queueLifecycle *SessionQueueLifecycle) map[string]CommandHandler {
	return map[string]CommandHandler{
		"session.policy.set": setSessionPolicyHandler,
		"session.goal.set":   setSessionGoalHandler,
		"session.goal.get":   getSessionGoalHandler,
		"session.goal.clear": clearSessionGoalHandler,
		"queue.add":          addQueueItemHandler,
		"queue.edit":         editQueueItemHandler,
		"queue.remove":       removeQueueItemHandler,
		"queue.move":         moveQueueItemHandler,
		"queue.dispatch": func(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
			if queueLifecycle == nil {
				return nil, NewError("chat_command_handler_unavailable", 422, map[string]any{"type": "queue.dispatch"})
			}
			return queueLifecycle.Dispatch(ctx, hctx)
		},
	}
}

func setSessionGoalHandler(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
	sess, err := hctx.Store.GetSession(ctx, hctx.SessionID)
	if err != nil {
		return nil, err
	}
	if sess == nil {
		return nil, NewError("chat_session_not_found", 404, nil)
	}
	if sess.State != "idle" {
		return nil, NewError("chat_goal_session_busy", 409, nil)
	}
	now := time.Now().UnixMilli()
	var existingGoal map[string]any
	if cs, _ := sess.Policy["contextState"].(map[string]any); cs != nil {
		existingGoal, _ = cs["goal"].(map[string]any)
	}
	createdAt := now
	if existingGoal != nil {
		if ts, ok := coerceInt64(existingGoal["createdAt"]); ok && ts > 0 {
			createdAt = ts
		}
	}
	threadID := hctx.SessionID
	if nid, _ := sess.RuntimeBinding["nativeSessionId"].(string); strings.TrimSpace(nid) != "" {
		threadID = nid
	}
	goal := map[string]any{
		"threadId":        threadID,
		"objective":       hctx.Command.Payload["objective"],
		"status":          "active",
		"tokenBudget":     hctx.Command.Payload["tokenBudget"],
		"tokensUsed":      0,
		"timeUsedSeconds": 0,
		"createdAt":       createdAt,
		"updatedAt":       now,
	}
	res, err := hctx.Store.SetGoal(ctx, hctx.SessionID, goal, "aih")
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"goal":    res.Goal,
		"event":   res.Event,
		"session": res.Session,
	}, nil
}

func getSessionGoalHandler(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
	sess, err := hctx.Store.GetSession(ctx, hctx.SessionID)
	if err != nil {
		return nil, err
	}
	if sess == nil {
		return nil, NewError("chat_session_not_found", 404, nil)
	}
	var goal any
	if cs, _ := sess.Policy["contextState"].(map[string]any); cs != nil {
		if g, ok := cs["goal"]; ok && g != nil {
			goal = g
		}
	}
	return map[string]any{"goal": goal}, nil
}

func clearSessionGoalHandler(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
	sess, err := hctx.Store.GetSession(ctx, hctx.SessionID)
	if err != nil {
		return nil, err
	}
	if sess == nil {
		return nil, NewError("chat_session_not_found", 404, nil)
	}
	if sess.State != "idle" {
		return nil, NewError("chat_goal_session_busy", 409, nil)
	}
	res, err := hctx.Store.ClearGoal(ctx, hctx.SessionID)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"goal":    res.Goal,
		"event":   res.Event,
		"session": res.Session,
	}, nil
}

func setSessionPolicyHandler(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
	payload := hctx.Command.Payload
	key, err := RequiredText(payload["key"], "chat_session_policy_key_required")
	if err != nil {
		return nil, NewError("chat_session_policy_key_required", 422, nil)
	}
	if _, forbidden := immutablePolicyKeys[key]; forbidden {
		return nil, NewError("chat_session_policy_key_immutable", 409, nil)
	}
	val, exists := payload["value"]
	if !exists {
		return nil, NewError("chat_session_policy_value_required", 422, nil)
	}
	if key == "model" {
		modelStr, ok := val.(string)
		if !ok || strings.TrimSpace(modelStr) == "" || len(modelStr) > 200 {
			return nil, NewError("chat_session_model_invalid", 422, nil)
		}
	}
	if key == "systemPrompt" || key == "autoCompactPercent" {
		current, err := hctx.Store.GetSession(ctx, hctx.SessionID)
		if err != nil {
			return nil, err
		}
		if current == nil {
			return nil, NewError("chat_session_not_found", 404, nil)
		}
		if current.ProjectPath != "" {
			return nil, NewError("chat_policy_mode_unsupported", 422, nil)
		}
		if current.State != "idle" {
			return nil, NewError("chat_policy_turn_active", 409, nil)
		}
		if key == "systemPrompt" {
			promptStr, ok := val.(string)
			if !ok || len(promptStr) > 16000 {
				return nil, NewError("chat_system_prompt_invalid", 422, nil)
			}
		}
		if key == "autoCompactPercent" {
			pct, ok := coerceInt(val)
			if !ok || pct < 50 || pct > 90 {
				return nil, NewError("chat_compaction_threshold_invalid", 422, nil)
			}
			val = pct
		}
	}
	sess, err := hctx.Store.UpdatePolicy(ctx, hctx.SessionID, map[string]any{key: val})
	if err != nil {
		return nil, err
	}
	return map[string]any{"policy": sess.Policy}, nil
}

func addQueueItemHandler(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
	content, err := RequiredText(hctx.Command.Payload["content"], "chat_turn_content_required")
	if err != nil {
		return nil, NewError("chat_turn_content_required", 422, nil)
	}
	policy, _ := hctx.Command.Payload["policy"].(string)
	entry, err := hctx.Store.Enqueue(ctx, hctx.SessionID, EnqueueInput{
		CommandID: hctx.Command.CommandID,
		Policy:    policy,
		Payload:   map[string]any{"content": content},
	})
	if err != nil {
		return nil, err
	}
	return queueEntryToMap(entry), nil
}

func editQueueItemHandler(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
	content, err := RequiredText(hctx.Command.Payload["content"], "chat_turn_content_required")
	if err != nil {
		return nil, NewError("chat_turn_content_required", 422, nil)
	}
	queueID, _ := hctx.Command.Payload["queueId"].(string)
	entry, err := hctx.Store.EditQueueItem(ctx, queueID, map[string]any{"content": content})
	if err != nil {
		return nil, err
	}
	return queueEntryToMap(entry), nil
}

func removeQueueItemHandler(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
	queueID, _ := hctx.Command.Payload["queueId"].(string)
	entry, err := hctx.Store.RemoveQueueItem(ctx, queueID)
	if err != nil {
		return nil, err
	}
	return queueEntryToMap(entry), nil
}

func moveQueueItemHandler(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
	queueID, _ := hctx.Command.Payload["queueId"].(string)
	beforeQueueID, _ := hctx.Command.Payload["beforeQueueId"].(string)
	entry, err := hctx.Store.MoveQueueItem(ctx, queueID, beforeQueueID)
	if err != nil {
		return nil, err
	}
	return queueEntryToMap(entry), nil
}

// SessionActorOptions 配置单个会话专属串行 Actor。
type SessionActorOptions struct {
	SessionID       string
	Store           *PublishingStore
	Driver          Driver
	Handlers        map[string]CommandHandler
	Extensions      *ExtensionPipeline
	ComposerCatalog func(ctx context.Context) (map[string]any, error)
	IDFactory       func(string) string
	Clock           func() int64
}

// SessionActor 按会话维护单邮箱串行队列，协调命令幂等、扩展钩子、驱动执行及队列派发。
type SessionActor struct {
	sessionID       string
	store           *PublishingStore
	driver          Driver
	extensions      *ExtensionPipeline
	composerCatalog func(ctx context.Context) (map[string]any, error)
	handlers        map[string]CommandHandler
	turn            *TurnLifecycle

	disposed   atomic.Bool
	jobMu      sync.Mutex
	jobs       []func()
	wakeupCh   chan struct{}
	stopOnce   sync.Once
	stopCh     chan struct{}
	workerDone chan struct{}
}

// NewSessionActor 构造并启动单会话 Actor 的串行邮箱协程。
func NewSessionActor(opts SessionActorOptions) *SessionActor {
	idFactory := opts.IDFactory
	if idFactory == nil {
		idFactory = DefaultIDFactory
	}
	composerCatalog := opts.ComposerCatalog
	if composerCatalog == nil {
		composerCatalog = func(context.Context) (map[string]any, error) {
			return map[string]any{"models": []any{}, "defaultModel": ""}, nil
		}
	}
	ext := opts.Extensions
	if ext == nil {
		ext, _ = NewExtensionPipeline(ExtensionPipelineOptions{})
	}
	a := &SessionActor{
		sessionID:       opts.SessionID,
		store:           opts.Store,
		driver:          opts.Driver,
		extensions:      ext,
		composerCatalog: composerCatalog,
		wakeupCh:        make(chan struct{}, 1),
		stopCh:          make(chan struct{}),
		workerDone:      make(chan struct{}),
	}
	a.turn = NewTurnLifecycle(TurnLifecycleOptions{
		SessionID: opts.SessionID,
		Store:     opts.Store,
		Driver:    opts.Driver,
		IDFactory: idFactory,
		Clock:     opts.Clock,
		Enqueue:   a.enqueueAsync,
	})
	queueLifecycle := NewSessionQueueLifecycle(a.turn, idFactory)
	handlers := CreateGenericCommandHandlers(queueLifecycle)
	for k, v := range opts.Handlers {
		if v != nil {
			handlers[k] = v
		}
	}
	a.handlers = handlers

	go a.runMailbox()
	return a
}

// SessionID 返回所属会话 ID。
func (a *SessionActor) SessionID() string { return a.sessionID }

// IsActive 返回当前是否有活跃执行轮次。
func (a *SessionActor) IsActive() bool {
	return a != nil && a.turn.IsActive()
}

// SupportsHistoryBranch 判断驱动是否提供可编排的历史分支能力。
func (a *SessionActor) SupportsHistoryBranch() bool {
	port := a.historyBranchPort()
	return port != nil && port.Native() != nil
}

func (a *SessionActor) historyBranchPort() HistoryBranchPort {
	if hb, ok := a.driver.(HistoryBranchDriver); ok {
		return hb.HistoryBranchPort()
	}
	return nil
}

// Dispatch 将命令投递到会话邮箱串行执行。
func (a *SessionActor) Dispatch(ctx context.Context, input map[string]any) (map[string]any, error) {
	if a.disposed.Load() {
		return nil, NewError("chat_actor_closed", 410, nil)
	}
	return a.enqueueSync(ctx, func() (map[string]any, error) {
		if a.disposed.Load() {
			return nil, NewError("chat_actor_closed", 410, nil)
		}
		return a.process(ctx, input)
	})
}

// Rehydrate 在邮箱串行窗口内重新挂接先前的活动轮次。
func (a *SessionActor) Rehydrate(ctx context.Context, recovery *RecoveryState) (map[string]any, error) {
	if a.disposed.Load() {
		return nil, NewError("chat_actor_closed", 410, nil)
	}
	return a.enqueueSync(ctx, func() (map[string]any, error) {
		if a.disposed.Load() {
			return nil, NewError("chat_actor_closed", 410, nil)
		}
		return a.turn.Rehydrate(ctx, recovery)
	})
}

// ReadComposerCatalog 在会话邮箱串行窗口内读取写信器模型/参数目录。
func (a *SessionActor) ReadComposerCatalog(ctx context.Context) (map[string]any, error) {
	if a.disposed.Load() {
		return nil, NewError("chat_actor_closed", 410, nil)
	}
	return a.enqueueSync(ctx, func() (map[string]any, error) {
		if a.disposed.Load() {
			return nil, NewError("chat_actor_closed", 410, nil)
		}
		return a.composerCatalog(ctx)
	})
}

// WaitForIdle 等待已投递命令以及当前活动轮次全部终结。
func (a *SessionActor) WaitForIdle(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if _, err := a.enqueueSync(ctx, func() (map[string]any, error) { return nil, nil }); err != nil {
		return err
	}
	if err := a.turn.WaitForIdle(ctx); err != nil {
		return err
	}
	_, err := a.enqueueSync(ctx, func() (map[string]any, error) { return nil, nil })
	return err
}

// Dispose 标记 Actor 已关闭并释放底层驱动资源。
func (a *SessionActor) Dispose() bool {
	if a == nil {
		return false
	}
	first := a.disposed.CompareAndSwap(false, true)
	if !first {
		return false
	}
	a.stopOnce.Do(func() { close(a.stopCh) })
	<-a.workerDone
	a.turn.Dispose()
	a.turn.WaitWatchers()
	return true
}

func (a *SessionActor) enqueueAsync(fn func()) {
	if fn == nil {
		return
	}
	a.jobMu.Lock()
	a.jobs = append(a.jobs, fn)
	a.jobMu.Unlock()
	select {
	case a.wakeupCh <- struct{}{}:
	default:
	}
}

type actorSyncResult struct {
	res map[string]any
	err error
}

func (a *SessionActor) enqueueSync(ctx context.Context, fn func() (map[string]any, error)) (map[string]any, error) {
	if a.disposed.Load() {
		return nil, NewError("chat_actor_closed", 410, nil)
	}
	done := make(chan actorSyncResult, 1)
	a.enqueueAsync(func() {
		if a.disposed.Load() {
			done <- actorSyncResult{err: NewError("chat_actor_closed", 410, nil)}
			return
		}
		res, err := fn()
		done <- actorSyncResult{res: res, err: err}
	})
	if ctx == nil {
		ctx = context.Background()
	}
	select {
	case out := <-done:
		return out.res, out.err
	case <-a.stopCh:
		select {
		case out := <-done:
			return out.res, out.err
		default:
			return nil, NewError("chat_actor_closed", 410, nil)
		}
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (a *SessionActor) runMailbox() {
	defer close(a.workerDone)
	for {
		a.drainJobs()
		select {
		case <-a.stopCh:
			a.drainJobs()
			return
		case <-a.wakeupCh:
		}
	}
}

func (a *SessionActor) drainJobs() {
	for {
		a.jobMu.Lock()
		if len(a.jobs) == 0 {
			a.jobMu.Unlock()
			return
		}
		batch := a.jobs
		a.jobs = nil
		a.jobMu.Unlock()
		for _, fn := range batch {
			fn()
		}
	}
}

func (a *SessionActor) process(ctx context.Context, input map[string]any) (map[string]any, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	reqSID := strings.TrimSpace(asString(input["sessionId"]))
	if reqSID != a.sessionID {
		return nil, NewError("chat_actor_session_mismatch", 409, nil)
	}
	var trace *TraceRecord
	if t, ok := input["_trace"].(*TraceRecord); ok {
		trace = t
	}
	command, err := NormalizeCommandInput(input)
	if err != nil {
		return nil, err
	}
	extCtx := ExtensionContext{
		SessionID: a.sessionID,
		Command:   CloneCommand(command),
		Trace:     trace,
	}
	existing, err := a.store.GetCommand(ctx, command.CommandID)
	if err != nil {
		return nil, err
	}
	isBranchCmd := command.Type == "session.fork" || command.Type == "turn.regenerate"
	if existing != nil && (existing.SessionID != command.SessionID || existing.Type != command.Type) {
		return nil, NewError("chat_command_id_conflict", 409, nil)
	}
	if existing != nil && isBranchCmd && !CanonicalJSONEquals(existing.Payload, command.Payload) {
		return nil, NewError("chat_command_id_conflict", 409, nil)
	}
	if existing != nil && !(existing.Status == "accepted" && isBranchCmd) {
		return duplicateCommandResponse(existing)
	}

	prepared := command
	if command.Type == "turn.submit" || command.Type == "turn.retry" {
		candidate, prepErr := a.extensions.RunPrepareNextTurn(ctx, CloneCommand(command), extCtx)
		if prepErr != nil {
			a.persistRejectedPreparation(ctx, command, prepErr, extCtx)
			return nil, prepErr
		}
		if candidate == nil || candidate.CommandID != command.CommandID || candidate.SessionID != command.SessionID || candidate.Type != command.Type {
			identErr := NewError("chat_extension_command_identity_changed", 409, nil)
			a.persistRejectedPreparation(ctx, command, identErr, extCtx)
			return nil, identErr
		}
		prepared, prepErr = NormalizeCommandInput(commandToMap(candidate))
		if prepErr != nil {
			a.persistRejectedPreparation(ctx, command, prepErr, extCtx)
			return nil, prepErr
		}
	}
	extCtx.Command = CloneCommand(prepared)

	interaction, err := a.interactionForCommand(ctx, command)
	if err != nil {
		return nil, err
	}
	persisted := ProjectInteractionCommandForPersistence(prepared, interaction)
	accepted, err := a.store.AcceptCommand(ctx, commandToMap(persisted), trace)
	if err != nil {
		return nil, err
	}
	if accepted.Duplicate && !(accepted.Command.Status == "accepted" && isBranchCmd) {
		return duplicateCommandResponse(accepted.Command)
	}
	extCtx.AcceptedCommand = accepted.Command

	executable := CloneCommand(accepted.Command)
	executable.Payload = CloneMap(prepared.Payload)
	beforeCtx := extCtx
	beforeCtx.Command = CloneCommand(executable)
	if err := a.extensions.RunBeforeCommand(ctx, CloneCommand(executable), beforeCtx); err != nil {
		a.failCommand(ctx, accepted.Command.CommandID, err)
		a.extensions.Observe(map[string]any{
			"type":    "command.failed",
			"command": commandToMap(extCtx.Command),
			"error":   serializeCommandError(err),
		}, extCtx)
		return nil, err
	}
	a.extensions.Observe(map[string]any{
		"type":    "command.accepted",
		"command": commandToMap(executable),
	}, beforeCtx)

	result, execErr := a.execute(ctx, executable, trace)
	if execErr != nil {
		a.failCommand(ctx, accepted.Command.CommandID, execErr)
		a.extensions.Observe(map[string]any{
			"type":    "command.failed",
			"command": commandToMap(extCtx.Command),
			"error":   serializeCommandError(execErr),
		}, extCtx)
		return nil, execErr
	}
	if _, compErr := a.store.CompleteCommand(ctx, accepted.Command.CommandID, "completed", result); compErr != nil {
		return nil, compErr
	}
	doneCtx := extCtx
	doneCtx.Command = executable
	doneCtx.Result = result
	a.extensions.Observe(map[string]any{
		"type":    "command.completed",
		"command": commandToMap(executable),
		"result":  result,
	}, doneCtx)
	return commandResponse(accepted.Command, false, result), nil
}

func (a *SessionActor) persistRejectedPreparation(ctx context.Context, cmd *Command, err error, extCtx ExtensionContext) {
	rejected, accErr := a.store.AcceptCommand(ctx, commandToMap(cmd), nil)
	if accErr == nil && rejected != nil && !rejected.Duplicate {
		a.failCommand(ctx, cmd.CommandID, err)
	}
	a.extensions.Observe(map[string]any{
		"type":    "command.failed",
		"command": commandToMap(cmd),
		"error":   serializeCommandError(err),
	}, extCtx)
}

func (a *SessionActor) execute(ctx context.Context, cmd *Command, trace *TraceRecord) (map[string]any, error) {
	switch cmd.Type {
	case "turn.submit":
		return a.turn.Submit(ctx, cmd, nil, trace)
	case "turn.retry":
		return a.turn.Retry(ctx, cmd, trace)
	case "slash.execute":
		name := strings.ToLower(strings.TrimPrefix(asString(cmd.Payload["name"]), "/"))
		if se, ok := a.driver.(SlashExecutor); ok && se.SlashMode() == "interactive" {
			return a.turn.Submit(ctx, cmd, nil, trace)
		}
		args := strings.TrimSpace(asString(cmd.Payload["arguments"]))
		if name == "compact" && args == "" {
			if _, ok := a.driver.(ThreadCompactor); ok {
				return a.turn.Submit(ctx, cmd, nil, trace)
			}
		}
		hctx := CommandHandlerContext{
			SessionID:     a.sessionID,
			Command:       cmd,
			Store:         a.store,
			Actor:         a,
			HistoryBranch: a.historyBranchPort(),
			Trace:         trace,
		}
		if name == "goal" {
			if args == "" {
				return a.callHandler(ctx, "session.goal.get", hctx)
			}
			if goalClearPattern.MatchString(args) {
				return a.callHandler(ctx, "session.goal.clear", hctx)
			}
			goalCmd := CloneCommand(cmd)
			goalCmd.Payload = map[string]any{
				"objective":   args,
				"tokenBudget": nil,
			}
			hctx.Command = goalCmd
			return a.callHandler(ctx, "session.goal.set", hctx)
		}
		if name == "plan" && args == "" {
			planCmd := CloneCommand(cmd)
			planCmd.Payload = map[string]any{
				"key":   "approvalMode",
				"value": "plan",
			}
			hctx.Command = planCmd
			return a.callHandler(ctx, "session.policy.set", hctx)
		}
	case "turn.interrupt":
		return a.turn.Interrupt(ctx, cmd)
	}
	return a.callHandler(ctx, cmd.Type, CommandHandlerContext{
		SessionID:     a.sessionID,
		Command:       cmd,
		Store:         a.store,
		Actor:         a,
		HistoryBranch: a.historyBranchPort(),
		Trace:         trace,
	})
}

func (a *SessionActor) callHandler(ctx context.Context, cmdType string, hctx CommandHandlerContext) (map[string]any, error) {
	handler := a.resolveCommandHandler(cmdType)
	if handler == nil {
		return nil, NewError("chat_command_handler_unavailable", 422, map[string]any{
			"type": cmdType,
		})
	}
	return handler(ctx, hctx)
}

func (a *SessionActor) resolveCommandHandler(cmdType string) CommandHandler {
	if h := a.handlers[cmdType]; h != nil {
		return h
	}
	if dyn, ok := a.driver.(DynamicCommandProvider); ok {
		if h := dyn.HandlerFor(cmdType); h != nil {
			return h
		}
	}
	return nil
}

func (a *SessionActor) failCommand(ctx context.Context, commandID string, origErr error) {
	if op, _ := a.store.Store().BranchOperations.Read(ctx, a.sessionID, commandID); op != nil {
		return
	}
	cmd, _ := a.store.GetCommand(ctx, commandID)
	if cmd != nil && (cmd.Type == "session.fork" || cmd.Type == "turn.regenerate") {
		child, _ := a.store.GetSession(ctx, BranchSessionID(commandID))
		if child != nil {
			if lineage, _ := child.Policy["lineage"].(map[string]any); lineage != nil {
				parentID, _ := lineage["parentSessionId"].(string)
				lineageCmdID, _ := lineage["commandId"].(string)
				if parentID == a.sessionID && lineageCmdID == commandID {
					return
				}
			}
		}
	}
	_, _ = a.store.CompleteCommand(ctx, commandID, "failed", serializeCommandError(origErr))
}

func (a *SessionActor) interactionForCommand(ctx context.Context, cmd *Command) (*Interaction, error) {
	expectedKind, ok := interactionCommandKinds[cmd.Type]
	if !ok {
		return nil, nil
	}
	interactionID, _ := cmd.Payload["interactionId"].(string)
	read := func() *Interaction {
		item, _ := a.store.Store().Interactions.Get(ctx, interactionID)
		return item
	}
	if ex, _ := a.store.GetCommand(ctx, cmd.CommandID); ex != nil {
		return read(), nil
	}
	rev, _ := coerceInt(cmd.Payload["revision"])
	validated, err := a.store.ValidateInteraction(ctx, interactionID, ResolveInteractionInput{
		SessionID: cmd.SessionID,
		Revision:  rev,
		Kind:      expectedKind,
	})
	if err != nil {
		if ex, _ := a.store.GetCommand(ctx, cmd.CommandID); ex != nil {
			return read(), nil
		}
		return nil, err
	}
	return validated, nil
}

func commandToMap(cmd *Command) map[string]any {
	if cmd == nil {
		return map[string]any{}
	}
	return map[string]any{
		"commandId": cmd.CommandID,
		"sessionId": cmd.SessionID,
		"type":      cmd.Type,
		"payload":   CloneMap(cmd.Payload),
	}
}

func commandResponse(cmd *Command, duplicate bool, result any) map[string]any {
	return map[string]any{
		"commandId":   cmd.CommandID,
		"acceptedSeq": cmd.AcceptedSeq,
		"duplicate":   duplicate,
		"result":      result,
	}
}

func duplicateCommandResponse(cmd *Command) (map[string]any, error) {
	if cmd.Status == "failed" {
		res := cmd.Result
		code, _ := res["code"].(string)
		if strings.TrimSpace(code) == "" {
			code = "chat_command_failed"
		}
		statusCode, ok := coerceInt(res["statusCode"])
		if !ok || statusCode < 400 {
			statusCode = 500
		}
		msg, _ := res["message"].(string)
		return nil, NewErrorWithMessage(code, statusCode, msg, res)
	}
	return commandResponse(cmd, true, cmd.Result), nil
}

// PreparedDriverHandle 管理待交付给 ActorRegistry 的临时驱动所有权。
type PreparedDriverHandle struct {
	Entry      *DriverEntry
	Runtime    RuntimeDescriptor
	ownsDriver atomic.Bool
}

// NewPreparedDriverHandle 创建持有所有权的预备驱动句柄。
func NewPreparedDriverHandle(entry *DriverEntry, rt RuntimeDescriptor) *PreparedDriverHandle {
	h := &PreparedDriverHandle{Entry: entry, Runtime: rt}
	h.ownsDriver.Store(true)
	return h
}

// Transfer 将所有权移交给注册好的 Actor，重复转移返回 false。
func (h *PreparedDriverHandle) Transfer() bool {
	if h == nil {
		return false
	}
	return h.ownsDriver.CompareAndSwap(true, false)
}

// Dispose 若尚未被 Actor 认领则销毁底层驱动。
func (h *PreparedDriverHandle) Dispose() bool {
	if !h.Transfer() || h.Entry == nil {
		return false
	}
	return DisposeDriver(h.Entry.Driver)
}

type actorRecord struct {
	actor           *SessionActor
	runtime         RuntimeDescriptor
	capabilities    map[string]any
	capabilitiesFor func(*Session) map[string]any
}

type actorAcquireCall struct {
	done  chan struct{}
	actor *SessionActor
	err   error
}

// ActorRegistryOptions 配置会话 Actor 注册表。
type ActorRegistryOptions struct {
	Store           *PublishingStore
	RuntimeResolver RuntimeResolver
	DriverRegistry  DriverRegistry
	IDFactory       func(string) string
	Clock           func() int64
	CommandHandlers map[string]CommandHandler
	Extensions      *ExtensionPipeline
}

// ActorRegistry 按会话维护内存运行中的 SessionActor 并处理单飞 Acquire 与代际淘汰。
type ActorRegistry struct {
	store           *PublishingStore
	runtimeResolver RuntimeResolver
	driverRegistry  DriverRegistry
	idFactory       func(string) string
	clock           func() int64
	commandHandlers map[string]CommandHandler
	extensions      *ExtensionPipeline

	mu       sync.Mutex
	records  map[string]*actorRecord
	inFlight map[string]*actorAcquireCall
}

// NewActorRegistry 构造 ActorRegistry。
func NewActorRegistry(opts ActorRegistryOptions) *ActorRegistry {
	ext := opts.Extensions
	if ext == nil {
		ext, _ = NewExtensionPipeline(ExtensionPipelineOptions{})
	}
	return &ActorRegistry{
		store:           opts.Store,
		runtimeResolver: opts.RuntimeResolver,
		driverRegistry:  opts.DriverRegistry,
		idFactory:       opts.IDFactory,
		clock:           opts.Clock,
		commandHandlers: maps.Clone(opts.CommandHandlers),
		extensions:      ext,
		records:         make(map[string]*actorRecord),
		inFlight:        make(map[string]*actorAcquireCall),
	}
}

// Has 判断某会话当前是否存在存活的 Actor。
func (r *ActorRegistry) Has(sessionID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.records[sessionID]
	return ok
}

// GetCapabilities 计算并返回会话最新的能力快照克隆。
func (r *ActorRegistry) GetCapabilities(ctx context.Context, sessionID string) map[string]any {
	r.mu.Lock()
	rec := r.records[sessionID]
	r.mu.Unlock()
	if rec == nil {
		return nil
	}
	caps := r.dynamicCapabilities(ctx, rec, sessionID)
	if caps == nil {
		return nil
	}
	return CloneMap(caps)
}

func (r *ActorRegistry) dynamicCapabilities(ctx context.Context, rec *actorRecord, sessionID string) map[string]any {
	if rec.capabilitiesFor == nil {
		return rec.capabilities
	}
	var sess *Session
	if r.store != nil {
		sess, _ = r.store.GetSession(ctx, sessionID)
	}
	if dyn := safeCapabilitiesFor(rec.capabilitiesFor, sess); dyn != nil {
		return dyn
	}
	return rec.capabilities
}

// Prepare 解析当前运行时与驱动并构造未入库的 PreparedDriverHandle。
func (r *ActorRegistry) Prepare(ctx context.Context, sess *Session) (*PreparedDriverHandle, error) {
	rt, err := r.resolveRuntime(ctx, sess)
	if err != nil {
		return nil, err
	}
	if err := r.retireStaleActors(rt); err != nil {
		return nil, err
	}
	entry, err := r.resolveDriver(ctx, sess, rt)
	if err != nil {
		return nil, err
	}
	return NewPreparedDriverHandle(entry, rt), nil
}

// Register 将预备驱动封装为 Actor 注册到注册表（若已存在则返回现有并释放 prepared）。
func (r *ActorRegistry) Register(sess *Session, prepared *PreparedDriverHandle) (*SessionActor, error) {
	r.mu.Lock()
	if existing := r.records[sess.SessionID]; existing != nil {
		r.mu.Unlock()
		prepared.Dispose()
		return existing.actor, nil
	}
	r.mu.Unlock()

	actor := r.createActor(sess, prepared.Entry)
	prepared.Transfer()
	r.mu.Lock()
	if existing := r.records[sess.SessionID]; existing != nil {
		r.mu.Unlock()
		actor.Dispose()
		return existing.actor, nil
	}
	r.setRecordLocked(sess.SessionID, actor, prepared)
	r.mu.Unlock()
	return actor, nil
}

// AssertReplaceable 确保目标会话当前无活动轮次，允许替换执行账号或重建 Actor。
func (r *ActorRegistry) AssertReplaceable(sessionID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	rec := r.records[sessionID]
	if rec != nil && rec.actor.IsActive() {
		return NewError("chat_execution_credential_change_conflict", 409, nil)
	}
	return nil
}

// ReplacePrepared 用新 PreparedDriverHandle 替换指定会话的 Actor。
func (r *ActorRegistry) ReplacePrepared(sess *Session, prepared *PreparedDriverHandle) (*SessionActor, error) {
	r.mu.Lock()
	cur := r.records[sess.SessionID]
	if cur != nil && cur.actor.IsActive() {
		r.mu.Unlock()
		return nil, NewError("chat_execution_credential_change_conflict", 409, nil)
	}
	r.mu.Unlock()

	actor := r.createActor(sess, prepared.Entry)
	prepared.Transfer()
	r.mu.Lock()
	cur = r.records[sess.SessionID]
	if cur != nil && cur.actor.IsActive() {
		r.mu.Unlock()
		actor.Dispose()
		return nil, NewError("chat_execution_credential_change_conflict", 409, nil)
	}
	r.setRecordLocked(sess.SessionID, actor, prepared)
	r.mu.Unlock()

	if cur != nil {
		cur.actor.Dispose()
	}
	return actor, nil
}

// Acquire 按会话单飞获取或创建与最新运行时代际一致的 Actor。
func (r *ActorRegistry) Acquire(ctx context.Context, sess *Session, recovery *RecoveryState) (*SessionActor, error) {
	r.mu.Lock()
	if pinned := r.records[sess.SessionID]; pinned != nil && pinned.actor.IsActive() {
		r.mu.Unlock()
		return pinned.actor, nil
	}
	if call := r.inFlight[sess.SessionID]; call != nil {
		r.mu.Unlock()
		<-call.done
		return call.actor, call.err
	}
	call := &actorAcquireCall{done: make(chan struct{})}
	r.inFlight[sess.SessionID] = call
	r.mu.Unlock()

	defer func() {
		r.mu.Lock()
		if r.inFlight[sess.SessionID] == call {
			delete(r.inFlight, sess.SessionID)
		}
		r.mu.Unlock()
		close(call.done)
	}()

	actor, err := r.acquireAvailable(ctx, sess, recovery)
	call.actor = actor
	call.err = err
	return actor, err
}

func (r *ActorRegistry) acquireAvailable(ctx context.Context, sess *Session, recovery *RecoveryState) (*SessionActor, error) {
	rt, err := r.resolveRuntime(ctx, sess)
	if err != nil {
		return nil, err
	}
	if err := AssertRecoverableRuntime(sess, rt, recovery); err != nil {
		return nil, err
	}
	r.mu.Lock()
	cur := r.records[sess.SessionID]
	if cur != nil && (cur.actor.IsActive() || sameRuntimeDescriptor(cur.runtime, rt)) {
		r.mu.Unlock()
		return cur.actor, nil
	}
	r.mu.Unlock()

	if err := r.retireStaleActors(rt); err != nil {
		return nil, err
	}
	entry, err := r.resolveDriver(ctx, sess, rt)
	if err != nil {
		return nil, err
	}
	prepared := NewPreparedDriverHandle(entry, rt)
	defer prepared.Dispose()

	r.mu.Lock()
	latest := r.records[sess.SessionID]
	if latest != nil && (latest.actor.IsActive() || sameRuntimeDescriptor(latest.runtime, rt)) {
		r.mu.Unlock()
		return latest.actor, nil
	}
	r.mu.Unlock()
	return r.replace(ctx, sess, prepared, latest, recovery)
}

func (r *ActorRegistry) replace(ctx context.Context, sess *Session, prepared *PreparedDriverHandle, cur *actorRecord, recovery *RecoveryState) (*SessionActor, error) {
	actor := r.createActor(sess, prepared.Entry)
	prepared.Transfer()
	if recovery != nil && recovery.Recoverable {
		if _, err := actor.Rehydrate(ctx, recovery); err != nil {
			actor.Dispose()
			return nil, err
		}
	}
	binding := RuntimeBindingPatch(sess, prepared.Runtime)
	if !sameRuntimeBinding(sess.RuntimeBinding, binding) && r.store != nil {
		if _, err := r.store.UpdateRuntimeBinding(ctx, sess.SessionID, binding, nil); err != nil {
			actor.Dispose()
			return nil, err
		}
	}
	r.mu.Lock()
	r.setRecordLocked(sess.SessionID, actor, prepared)
	r.mu.Unlock()
	if cur != nil && cur.actor != actor {
		cur.actor.Dispose()
	}
	return actor, nil
}

// Dispose 销毁并移除单个会话 Actor。
func (r *ActorRegistry) Dispose(sessionID string) bool {
	r.mu.Lock()
	rec := r.records[sessionID]
	if rec == nil {
		r.mu.Unlock()
		return false
	}
	delete(r.records, sessionID)
	r.mu.Unlock()
	rec.actor.Dispose()
	return true
}

// Close 销毁注册表中全部 Actor 并关闭扩展管线。
func (r *ActorRegistry) Close() {
	r.mu.Lock()
	all := make([]*SessionActor, 0, len(r.records))
	for id, rec := range r.records {
		all = append(all, rec.actor)
		delete(r.records, id)
	}
	r.mu.Unlock()
	for _, actor := range all {
		actor.Dispose()
	}
	if r.extensions != nil {
		r.extensions.Close()
	}
}

func (r *ActorRegistry) retireStaleActors(rt RuntimeDescriptor) error {
	r.mu.Lock()
	var staleIDs []string
	var staleActors []*SessionActor
	for sid, rec := range r.records {
		if sameRuntimeTarget(rec.runtime, rt) && !sameRuntimeDescriptor(rec.runtime, rt) {
			if rec.actor.IsActive() {
				r.mu.Unlock()
				return NewError("chat_runtime_refresh_conflict", 409, map[string]any{
					"runtimeScope": rt.RuntimeScope,
				})
			}
			staleIDs = append(staleIDs, sid)
			staleActors = append(staleActors, rec.actor)
		}
	}
	for _, sid := range staleIDs {
		delete(r.records, sid)
	}
	r.mu.Unlock()
	for _, actor := range staleActors {
		actor.Dispose()
	}
	return nil
}

func (r *ActorRegistry) resolveRuntime(ctx context.Context, sess *Session) (RuntimeDescriptor, error) {
	if r.runtimeResolver == nil {
		return RuntimeDescriptor{}, NewError("chat_runtime_resolver_unavailable", 503, nil)
	}
	rt, err := r.runtimeResolver.Resolve(ctx, sess.Provider, RuntimeResolveOptions{
		RuntimeScope: sess.ExecutionAccountRef,
		Chat:         IsChatSession(sess),
	})
	if err != nil {
		return RuntimeDescriptor{}, err
	}
	if strings.TrimSpace(rt.Provider) == "" {
		rt.Provider = sess.Provider
	}
	if strings.TrimSpace(rt.RuntimeScope) == "" {
		rt.RuntimeScope = sess.ExecutionAccountRef
	}
	return rt, nil
}

func (r *ActorRegistry) resolveDriver(ctx context.Context, sess *Session, rt RuntimeDescriptor) (*DriverEntry, error) {
	if r.driverRegistry == nil {
		return nil, NewError("chat_turn_driver_unavailable", 422, map[string]any{"provider": sess.Provider})
	}
	entry, err := r.driverRegistry.Resolve(ctx, sess.Provider, DriverResolveOptions{
		Session: sess,
		Runtime: rt,
	})
	if err != nil {
		return nil, err
	}
	if entry == nil || entry.Driver == nil {
		return nil, NewError("chat_turn_driver_unavailable", 422, map[string]any{"provider": sess.Provider})
	}
	return entry, nil
}

func (r *ActorRegistry) setRecordLocked(sessionID string, actor *SessionActor, prepared *PreparedDriverHandle) {
	var caps map[string]any
	var capsFor func(*Session) map[string]any
	if prepared != nil && prepared.Entry != nil {
		caps = CloneMap(prepared.Entry.Capabilities)
		capsFor = prepared.Entry.CapabilitiesFor
	}
	var rt RuntimeDescriptor
	if prepared != nil {
		rt = prepared.Runtime
	}
	r.records[sessionID] = &actorRecord{
		actor:           actor,
		runtime:         rt,
		capabilities:    caps,
		capabilitiesFor: capsFor,
	}
}

func (r *ActorRegistry) createActor(sess *Session, entry *DriverEntry) *SessionActor {
	mergedHandlers := maps.Clone(r.commandHandlers)
	if mergedHandlers == nil {
		mergedHandlers = make(map[string]CommandHandler)
	}
	var driver Driver
	var catalogFn func(context.Context) (map[string]any, error)
	if entry != nil {
		driver = entry.Driver
		catalogFn = entry.ComposerCatalog
		for k, v := range entry.Handlers {
			if v != nil {
				mergedHandlers[k] = v
			}
		}
	}
	return NewSessionActor(SessionActorOptions{
		SessionID:       sess.SessionID,
		Store:           r.store,
		Driver:          driver,
		Handlers:        mergedHandlers,
		Extensions:      r.extensions,
		ComposerCatalog: catalogFn,
		IDFactory:       r.idFactory,
		Clock:           r.clock,
	})
}
