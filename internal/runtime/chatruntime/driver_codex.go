package chatruntime

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/webuiremoteworkspace"
)

const (
	defaultCodexRecoveryCleanupTimeout = 5 * time.Second
	codexOverflowSeedPercent           = 25
)

var codexContextOverflowPattern = regexp.MustCompile(`(?i)(context_length_exceeded|maximum context length|context window|input token count exceeds|prompt is too long|too many tokens)`)

// CodexRemoteToolExecutor 执行远程工作区动态工具调用（item/tool/call）。
type CodexRemoteToolExecutor func(ctx context.Context, workspaceID, toolName string, arguments any) ([]map[string]any, bool)

// CodexDriverOptions 配置 Codex app-server 驱动实例。
type CodexDriverOptions struct {
	Session               *Session
	Runtime               RuntimeDescriptor
	Client                CodexRPCClient
	Pool                  *CodexClientPool
	Store                 *PublishingStore
	ModelCatalog          *ModelCatalogResolver
	NativeCatalog         *CodexNativeModelCatalog
	AIHomeDir             string
	HostHomeDir           string
	Endpoint              string
	ExecutablePath        string
	RuntimeConfigRevision string
	ReplayTimeout         time.Duration
	CleanupTimeout        time.Duration
	ReconnectGraceWait    time.Duration
	ReleaseFailureSink    func(map[string]any)
	RemoteTools           CodexRemoteToolExecutor
	IsModelEnabled        func(string) bool
}

type codexActiveTurn struct {
	tc                        DriverTurnContext
	prompt                    string
	turnParts                 TurnAttachmentParts
	hasTurnParts              bool
	documentBudget            DocumentBudgetReport
	hasDocumentBudget         bool
	imagePaths                []string
	model                     string
	reasoningEffort           string
	threadConfig              map[string]any
	approvalMode              string
	nativeThreadId            string
	nativeTurnId              string
	clientUserMessageId       string
	persistedNativeTurnId     string
	createdNativeThread       bool
	threadHadHistory          bool
	submissionStarted         bool
	submissionUncertain       bool
	cancelRequested           bool
	cancelledBeforeSubmission bool
	nativeTerminal            bool
	contextOverflowRetried    bool
	toolOrder                 *CodexToolOrder
	done                      chan ProviderRunResult
	cancelLaunch              context.CancelFunc
	binding                   *CodexTurnHandle

	mu       sync.Mutex
	settled  bool
	cleaned  bool
	cleanCh  chan struct{}
	anchorMu sync.Mutex
}

func (a *codexActiveTurn) settle(result map[string]any, err error) {
	a.mu.Lock()
	if a.settled {
		a.mu.Unlock()
		return
	}
	a.settled = true
	a.mu.Unlock()
	select {
	case a.done <- ProviderRunResult{Result: result, Err: err}:
	default:
	}
}

func (a *codexActiveTurn) isSettled() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.settled
}

// CodexSessionDriver 驱动持久化的 Codex app-server 会话。
type CodexSessionDriver struct {
	session            *Session
	runtime            RuntimeDescriptor
	store              *PublishingStore
	modelCatalog       *ModelCatalogResolver
	nativeCatalog      *CodexNativeModelCatalog
	client             CodexRPCClient
	releaseClient      func()
	aiHomeDir          string
	hostHomeDir        string
	endpoint           string
	cleanupTimeout     time.Duration
	reconnectGraceWait time.Duration
	remoteTools        CodexRemoteToolExecutor
	releaseFailureSink func(map[string]any)

	bridge   *CodexSessionEventBridge
	history  *CodexSessionEventBridgeSync
	goals    *CodexSessionGoalSync
	branches *CodexWorkBranch

	mu                  sync.Mutex
	nativeThreadID      string
	active              *codexActiveTurn
	initialHistory      []map[string]any
	historySeedLoaded   bool
	injectedDocumentRun map[string]struct{}
	goalItemsSeen       map[string]struct{}
	disposed            bool
}

// NewCodexSessionDriver 创建并绑定 CodexSessionDriver。
func NewCodexSessionDriver(opts CodexDriverOptions) (*CodexSessionDriver, error) {
	if opts.Session == nil || !strings.EqualFold(strings.TrimSpace(opts.Session.Provider), "codex") || strings.TrimSpace(opts.Session.SessionID) == "" {
		return nil, NewError("codex_driver_session_invalid", http.StatusUnprocessableEntity, nil)
	}
	if strings.TrimSpace(opts.Runtime.RuntimeScope) == "" {
		return nil, NewError("codex_driver_runtime_invalid", http.StatusUnprocessableEntity, nil)
	}
	if opts.Store == nil {
		return nil, NewError("codex_driver_store_required", http.StatusInternalServerError, nil)
	}
	client := opts.Client
	var releaseFn func()
	if client == nil {
		fp := opts.Runtime.Fingerprint
		if opts.RuntimeConfigRevision != "" {
			if fp != "" {
				fp += ":" + opts.RuntimeConfigRevision
			} else {
				fp = opts.RuntimeConfigRevision
			}
		}
		clientOpts := CodexAppServerClientOptions{
			AccountRef:         opts.Session.ExecutionAccountRef,
			AIHomeDir:          opts.AIHomeDir,
			HostHomeDir:        opts.HostHomeDir,
			ExecutablePath:     opts.ExecutablePath,
			RuntimeFingerprint: fp,
			RuntimeScope:       opts.Runtime.RuntimeScope,
		}
		if opts.Pool != nil {
			lease := opts.Pool.Acquire(clientOpts)
			client = lease.Client
			releaseFn = func() { lease.Release() }
		} else {
			raw := NewCodexAppServerClient(clientOpts)
			client = raw
			releaseFn = func() { _ = raw.Close() }
		}
	}

	cleanupTimeout := opts.CleanupTimeout
	if cleanupTimeout <= 0 {
		cleanupTimeout = defaultCodexRecoveryCleanupTimeout
	}
	nativeThreadID := strings.TrimSpace(asString(opts.Session.RuntimeBinding["nativeSessionId"]))
	drv := &CodexSessionDriver{
		session:             opts.Session,
		runtime:             opts.Runtime,
		store:               opts.Store,
		modelCatalog:        opts.ModelCatalog,
		client:              client,
		releaseClient:       releaseFn,
		aiHomeDir:           opts.AIHomeDir,
		hostHomeDir:         opts.HostHomeDir,
		endpoint:            opts.Endpoint,
		cleanupTimeout:      cleanupTimeout,
		reconnectGraceWait:  opts.ReconnectGraceWait,
		remoteTools:         opts.RemoteTools,
		releaseFailureSink:  opts.ReleaseFailureSink,
		nativeThreadID:      nativeThreadID,
		injectedDocumentRun: make(map[string]struct{}),
		goalItemsSeen:       make(map[string]struct{}),
	}
	drv.bridge = NewCodexSessionEventBridge(CodexSessionEventBridgeOptions{
		Store:         opts.Store,
		Provider:      "codex",
		SessionID:     opts.Session.SessionID,
		ReplayTimeout: opts.ReplayTimeout,
	})
	drv.history = NewCodexSessionHistorySync(client, opts.Store, opts.Session.SessionID, opts.Runtime.RuntimeScope, func() string {
		return drv.getNativeThreadID()
	})
	drv.goals = &CodexSessionGoalSync{
		client:    client,
		store:     opts.Store,
		sessionID: opts.Session.SessionID,
		bridge:    drv.bridge,
		runtimeID: opts.Runtime.RuntimeScope,
	}
	drv.branches = &CodexWorkBranch{
		client:      client,
		store:       opts.Store,
		sessionID:   opts.Session.SessionID,
		getThreadID: drv.getNativeThreadID,
		getPolicy:   drv.getSessionPolicy,
	}
	if opts.NativeCatalog != nil {
		drv.nativeCatalog = opts.NativeCatalog
	} else if !IsGatewayRuntimeScope(opts.Runtime.RuntimeScope) {
		drv.nativeCatalog = NewCodexNativeModelCatalog(client, opts.IsModelEnabled)
	}
	return drv, nil
}

// CodexCapabilities 返回 Codex 驱动的能力矩阵。
func CodexCapabilities(rt RuntimeDescriptor) map[string]any {
	rev := firstNonEmptyStr(rt.Fingerprint, rt.Version, rt.RuntimeScope)
	return map[string]any{
		"revision": rev,
		"capabilities": map[string]any{
			"session.resume":                capSupport("native", ""),
			"timeline.reasoning":            capSupport("native", ""),
			"timeline.tool":                 capSupport("native", ""),
			"timeline.diff":                 capSupport("native", ""),
			"mode.plan":                     capSupport("native", ""),
			"interaction.question":          capSupport("native", ""),
			"interaction.approval":          capSupport("native", ""),
			"interaction.plan_confirmation": capSupport("emulated", "aih_plan_implementation_workflow"),
			"turn.interrupt":                capSupport("native", ""),
			"turn.steer.current":            capSupport("native", ""),
			"turn.steer.tool_boundary":      capSupport("emulated", "aih_chat_runtime_tool_boundary_queue"),
			"turn.queue":                    capSupport("emulated", "aih_chat_runtime_queue"),
			"session.goal":                  capSupport("emulated", "aih_session_goal_projection"),
			"slash.execute":                 capSupport("native", ""),
			"terminal.stream":               capSupport("unsupported", "codex_app_server_uses_typed_shell_items"),
			"run.adopt":                     capSupport("native", ""),
		},
		"slashCommands":      []string{"compact", "goal", "plan"},
		"slashPassthrough":   false,
		"turnInterveneModes": []string{"steer_current"},
	}
}

// CreateCodexDriverEntry 构建带全部命令处理器与能力目录的 DriverEntry。
func CreateCodexDriverEntry(opts CodexDriverOptions) (*DriverEntry, error) {
	drv, err := NewCodexSessionDriver(opts)
	if err != nil {
		return nil, err
	}
	handlers := map[string]CommandHandler{
		"runtime.prewarm": func(ctx context.Context, _ CommandHandlerContext) (map[string]any, error) {
			return drv.Prewarm(ctx)
		},
		"turn.intervene": func(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
			expected := asString(hctx.Command.Payload["expectedRunId"])
			if expected != "" {
				sess, err := hctx.Store.GetSession(ctx, hctx.SessionID)
				if err != nil {
					return nil, err
				}
				activeRunID := ""
				if sess != nil && sess.ActiveTurn != nil {
					activeRunID = sess.ActiveTurn.RunID
				}
				if sess == nil || activeRunID != expected || (sess.State != "running" && sess.State != "waiting_input") {
					return nil, NewError("chat_queue_boundary_superseded", http.StatusConflict, nil)
				}
			}
			return drv.Intervene(ctx, hctx.Command.Payload)
		},
		"interaction.answer": func(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
			return drv.resolveThenRespond(ctx, hctx, "question")
		},
		"approval.decide": func(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
			return drv.resolveThenRespond(ctx, hctx, "approval")
		},
		"slash.execute": func(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
			return drv.ExecuteSlashCommand(ctx, hctx.Command.Payload)
		},
	}
	return &DriverEntry{
		Driver:       drv,
		Handlers:     handlers,
		Capabilities: CodexCapabilities(opts.Runtime),
		ComposerCatalog: func(ctx context.Context) (map[string]any, error) {
			return drv.ReadComposerCatalog(ctx)
		},
	}, nil
}

// Dispose 中止进行中的轮次并释放底层 Codex RPC 客户端租约。
func (d *CodexSessionDriver) Dispose() bool {
	d.mu.Lock()
	if d.disposed {
		d.mu.Unlock()
		return false
	}
	d.disposed = true
	active := d.active
	var cancel context.CancelFunc
	if active != nil {
		active.cancelRequested = true
		cancel = active.cancelLaunch
	}
	rel := d.releaseClient
	d.releaseClient = nil
	d.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if active != nil {
		active.settle(map[string]any{"status": "interrupted"}, nil)
	}
	if rel != nil {
		rel()
	}
	return true
}

// HistoryBranchPort 返回支持 Codex 原生分叉与回溯注入的端口。
func (d *CodexSessionDriver) HistoryBranchPort() HistoryBranchPort {
	return d.branches
}

// Prewarm 预热 Codex app-server 连接、历史同步与模型目录。
func (d *CodexSessionDriver) Prewarm(ctx context.Context) (map[string]any, error) {
	if err := d.client.EnsureConnected(ctx); err != nil {
		return nil, err
	}
	if d.getNativeThreadID() != "" {
		if err := d.history.Run(ctx); err != nil {
			return nil, err
		}
	}
	if d.nativeCatalog != nil {
		if err := d.nativeCatalog.Prewarm(ctx); err != nil {
			return nil, err
		}
	}
	return map[string]any{
		"ready":        true,
		"provider":     "codex",
		"runtimeScope": d.runtime.RuntimeScope,
	}, nil
}

// ReadComposerCatalog 读取会话可用的模型与推理强度列表。
func (d *CodexSessionDriver) ReadComposerCatalog(ctx context.Context) (map[string]any, error) {
	if d.nativeCatalog != nil {
		return d.nativeCatalog.ReadComposerCatalog(ctx)
	}
	if d.modelCatalog != nil {
		cat, err := d.modelCatalog.ReadComposerCatalog(ctx, d.currentSession(ctx))
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"models":       cat.Models,
			"defaultModel": cat.DefaultModel,
		}, nil
	}
	return map[string]any{"models": []any{}, "defaultModel": ""}, nil
}

// StartTurn 发起一轮 Codex 对话执行。
func (d *CodexSessionDriver) StartTurn(ctx context.Context, tc DriverTurnContext) (*ProviderRun, error) {
	if strings.TrimSpace(tc.SessionID) != d.session.SessionID {
		return nil, NewError("chat_actor_session_mismatch", http.StatusConflict, nil)
	}
	d.mu.Lock()
	if d.active != nil {
		d.mu.Unlock()
		return nil, NewError("chat_turn_already_active", http.StatusConflict, nil)
	}

	var payload map[string]any
	if tc.Command != nil {
		payload = tc.Command.Payload
	}
	turnIn, hasParts, err := d.resolveTurnParts(ctx, payload)
	if err != nil {
		d.mu.Unlock()
		return nil, err
	}
	prompt := strings.TrimSpace(asString(payload["content"]))
	var parts TurnAttachmentParts
	if hasParts {
		parts = turnIn.Parts
		prompt = turnIn.Prompt
	}
	imagePaths := append([]string(nil), tc.ImagePaths...)
	if hasParts && len(turnIn.ImagePaths) > 0 {
		imagePaths = turnIn.ImagePaths
	}
	if prompt == "" && len(imagePaths) == 0 {
		d.mu.Unlock()
		return nil, NewError("chat_turn_content_required", http.StatusUnprocessableEntity, nil)
	}
	model := strings.TrimSpace(asString(payload["model"]))
	effort := strings.TrimSpace(asString(payload["reasoningEffort"]))

	runCtx, cancelLaunch := context.WithCancel(ctx)
	active := &codexActiveTurn{
		tc:              tc,
		prompt:          prompt,
		turnParts:       parts,
		hasTurnParts:    hasParts,
		imagePaths:      imagePaths,
		model:           model,
		reasoningEffort: effort,
		approvalMode:    d.currentApprovalMode(ctx),
		toolOrder:       NewCodexToolOrder(),
		done:            make(chan ProviderRunResult, 1),
		cleanCh:         make(chan struct{}),
		cancelLaunch:    cancelLaunch,
	}
	d.active = active
	d.mu.Unlock()

	go d.runAndCleanup(runCtx, active, func(c context.Context) error {
		return d.launch(c, active)
	})

	return d.providerRunHandle(active), nil
}

// CompactThread 执行 Codex 原生线程上下文压缩（/compact）。
func (d *CodexSessionDriver) CompactThread(ctx context.Context, tc DriverTurnContext) (*ProviderRun, error) {
	if strings.TrimSpace(tc.SessionID) != d.session.SessionID {
		return nil, NewError("chat_actor_session_mismatch", http.StatusConflict, nil)
	}
	d.mu.Lock()
	if d.active != nil {
		d.mu.Unlock()
		return nil, NewError("chat_turn_already_active", http.StatusConflict, nil)
	}
	runCtx, cancelLaunch := context.WithCancel(ctx)
	active := &codexActiveTurn{
		tc:           tc,
		approvalMode: d.currentApprovalMode(ctx),
		toolOrder:    NewCodexToolOrder(),
		done:         make(chan ProviderRunResult, 1),
		cleanCh:      make(chan struct{}),
		cancelLaunch: cancelLaunch,
	}
	d.active = active
	d.mu.Unlock()

	go d.runAndCleanup(runCtx, active, func(c context.Context) error {
		return d.launchCompaction(c, active)
	})
	return d.providerRunHandle(active), nil
}

// InterruptTurn 中断当前正在执行的 Codex 轮次。
func (d *CodexSessionDriver) InterruptTurn(ctx context.Context, tc DriverTurnContext) error {
	d.mu.Lock()
	active := d.active
	d.mu.Unlock()
	if active == nil {
		return NewError("chat_turn_not_active", http.StatusConflict, nil)
	}
	active.cancelRequested = true
	if !active.submissionStarted {
		return nil
	}
	threadID := active.nativeThreadId
	if threadID == "" {
		threadID = d.getNativeThreadID()
	}
	turnID := active.nativeTurnId
	if threadID == "" || turnID == "" {
		return NewError("codex_native_turn_not_started", http.StatusUnprocessableEntity, nil)
	}
	_, err := d.client.Request(ctx, "turn/interrupt", BuildCodexTurnInterruptParams(threadID, turnID))
	return err
}

// RecoverTurn 重连并恢复崩溃前尚未结束的 Codex 轮次。
func (d *CodexSessionDriver) RecoverTurn(ctx context.Context, in RecoverTurnInput) (*ProviderRun, error) {
	if strings.TrimSpace(in.SessionID) != d.session.SessionID {
		return nil, NewError("chat_actor_session_mismatch", http.StatusConflict, nil)
	}
	d.mu.Lock()
	if d.active != nil {
		d.mu.Unlock()
		return nil, NewError("chat_turn_already_active", http.StatusConflict, nil)
	}
	threadID := d.getNativeThreadID()
	if threadID == "" {
		d.mu.Unlock()
		return nil, NewError("codex_native_session_missing", http.StatusConflict, nil)
	}
	var nativeTurnID, clientUserMsgID string
	var interruptRequested bool
	if in.ActiveTurn != nil {
		nativeTurnID = strings.TrimSpace(in.ActiveTurn.NativeTurnID)
		clientUserMsgID = strings.TrimSpace(in.ActiveTurn.ClientUserMessageID)
		interruptRequested = in.ActiveTurn.InterruptRequested
	}
	runCtx, cancelLaunch := context.WithCancel(ctx)
	active := &codexActiveTurn{
		tc: DriverTurnContext{
			SessionID: in.SessionID,
			TurnID:    in.TurnID,
			RunID:     in.RunID,
		},
		approvalMode:          d.currentApprovalMode(ctx),
		nativeThreadId:        threadID,
		nativeTurnId:          nativeTurnID,
		clientUserMessageId:   clientUserMsgID,
		persistedNativeTurnId: nativeTurnID,
		submissionStarted:     true,
		toolOrder:             NewCodexToolOrder(),
		done:                  make(chan ProviderRunResult, 1),
		cleanCh:               make(chan struct{}),
		cancelLaunch:          cancelLaunch,
	}
	d.active = active
	d.mu.Unlock()

	pending := in.PendingInteractions
	if interruptRequested {
		pending = nil
	}
	d.bridge.ExpectReplays(pending)
	if err := d.bind(ctx, active); err != nil {
		d.bridge.CancelExpectedReplays()
		d.finishCleanup(active)
		return nil, err
	}

	resumeParams := map[string]any{"excludeTurns": false}
	if built, berr := BuildCodexThreadResumeParams(active.approvalMode, active.nativeThreadId, false); berr == nil {
		resumeParams = d.remoteThreadParams(ApplyCodexNativeHistoryPolicy(built), true)
	}
	resp, err := d.client.Request(ctx, "thread/resume", resumeParams)
	if err != nil {
		d.bridge.CancelExpectedReplays()
		d.finishCleanup(active)
		return nil, err
	}
	snapshot, err := d.restoreRecoveredSnapshot(ctx, active, resp, d.client)
	if err != nil {
		d.bridge.CancelExpectedReplays()
		d.finishCleanup(active)
		return nil, err
	}
	_ = d.goals.Refresh(ctx, active.nativeThreadId, active.tc.TurnID, active.tc.RunID, d.runtime.RuntimeScope)
	if active.nativeTurnId != "" && active.nativeTurnId != active.persistedNativeTurnId {
		_, _ = d.store.UpdateActiveTurnAnchor(ctx, d.session.SessionID, active.tc.RunID, active.nativeTurnId, "")
		active.persistedNativeTurnId = active.nativeTurnId
	}

	if interruptRequested && snapshot.status == "inProgress" {
		_, _ = d.client.Request(ctx, "turn/interrupt", BuildCodexTurnInterruptParams(active.nativeThreadId, active.nativeTurnId))
	}

	go func() {
		defer d.finishCleanup(active)
		if snapshot.status == "inProgress" && !active.isSettled() {
			if replayErr := d.bridge.WaitForExpectedReplays(runCtx); replayErr != nil {
				active.settle(nil, replayErr)
			}
			<-active.done
			return
		}
		d.bridge.CancelExpectedReplays()
		d.settleFromRecoveredSnapshot(active, snapshot)
	}()

	return d.providerRunHandle(active), nil
}

// Intervene 向正在运行的 Codex turn 注入转向（steer_current）。
func (d *CodexSessionDriver) Intervene(ctx context.Context, payload map[string]any) (map[string]any, error) {
	if asString(payload["mode"]) != "steer_current" {
		return nil, NewError("codex_intervene_mode_unsupported", http.StatusUnprocessableEntity, map[string]any{
			"mode": payload["mode"],
		})
	}
	d.mu.Lock()
	active := d.active
	d.mu.Unlock()
	if active == nil {
		return nil, NewError("chat_turn_not_active", http.StatusConflict, nil)
	}
	if active.nativeTurnId == "" {
		return nil, NewError("codex_native_turn_not_started", http.StatusUnprocessableEntity, nil)
	}
	content, err := RequiredText(payload["content"], "chat_turn_content_required")
	if err != nil {
		return nil, err
	}
	return d.client.Request(ctx, "turn/steer", BuildCodexTurnSteerParams(active.nativeThreadId, active.nativeTurnId, content))
}

// ExecuteSlashCommand 校验并执行同步 slash 指令兜底（仅支持空参数 /compact）。
func (d *CodexSessionDriver) ExecuteSlashCommand(ctx context.Context, payload map[string]any) (map[string]any, error) {
	name := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(asString(payload["name"])), "/"))
	if name == "" {
		return nil, NewError("chat_slash_name_required", http.StatusUnprocessableEntity, nil)
	}
	if name != "compact" || strings.TrimSpace(asString(payload["arguments"])) != "" {
		return nil, NewError("codex_slash_command_unsupported", http.StatusUnprocessableEntity, map[string]any{"name": name})
	}
	threadID := d.getNativeThreadID()
	if threadID == "" {
		return nil, NewError("codex_native_session_missing", http.StatusUnprocessableEntity, nil)
	}
	return d.client.Request(ctx, "thread/compact/start", map[string]any{"threadId": threadID})
}

func (d *CodexSessionDriver) resolveThenRespond(ctx context.Context, hctx CommandHandlerContext, kind string) (map[string]any, error) {
	payload := hctx.Command.Payload
	interactionID, err := RequiredText(payload["interactionId"], "chat_interaction_id_required")
	if err != nil {
		return nil, err
	}
	var resolution map[string]any
	if kind == "approval" {
		resolution = map[string]any{"choiceId": payload["choiceId"]}
	} else {
		resolution = map[string]any{"action": payload["action"]}
		if ans, ok := payload["answer"]; ok {
			resolution["answer"] = ans
		}
	}
	rev, _ := asSafeInt64(payload["revision"])
	var rawInteraction *Interaction
	if snap, err := d.store.GetSnapshot(ctx, d.session.SessionID); err == nil && snap != nil {
		for i := range snap.Interactions {
			if snap.Interactions[i].InteractionID == interactionID {
				cp := snap.Interactions[i]
				rawInteraction = &cp
				break
			}
		}
	}
	persisted := ProjectInteractionResolutionForPersistence(rawInteraction, resolution)
	coord := NewInteractionResolutionCoordinator(d.store, d.releaseFailureSink)
	out, err := coord.Resolve(ctx, interactionID, ResolveInteractionInput{
		SessionID:  d.session.SessionID,
		Kind:       kind,
		Revision:   int(rev),
		Resolution: persisted,
	}, func(claimed *Interaction) (map[string]any, error) {
		env := d.bridge.LookupEnvelope(interactionID)
		if env == nil {
			return nil, NewError("chat_interaction_not_live", http.StatusConflict, nil)
		}
		rpcResult, aerr := AdaptCodexServerResponse(claimed, env, resolution)
		if aerr != nil {
			return nil, aerr
		}
		if err := d.client.Respond(ctx, env.RequestID, rpcResult); err != nil {
			return nil, err
		}
		d.bridge.RemoveEnvelope(interactionID)
		return rpcResult, nil
	})
	if err != nil {
		return nil, err
	}
	return out.Response, nil
}

func (d *CodexSessionDriver) providerRunHandle(active *codexActiveTurn) *ProviderRun {
	return &ProviderRun{
		NativeTurnID: active.nativeTurnId,
		Done:         active.done,
		Abandon: func(reason string) string {
			active.cancelRequested = true
			if active.cancelLaunch != nil {
				active.cancelLaunch()
			}
			active.settle(nil, NewError("chat_turn_abandoned", http.StatusConflict, map[string]any{"reason": reason}))
			if active.nativeThreadId != "" {
				d.unbindActiveTurn(active)
			}
			<-active.cleanCh
			return "abandoned"
		},
	}
}

func (d *CodexSessionDriver) runAndCleanup(ctx context.Context, active *codexActiveTurn, fn func(context.Context) error) {
	defer d.finishCleanup(active)
	if err := fn(ctx); err != nil {
		active.settle(nil, err)
		return
	}
	select {
	case <-active.done:
	case <-ctx.Done():
		active.settle(map[string]any{"status": "interrupted"}, nil)
	}
}

func (d *CodexSessionDriver) launch(ctx context.Context, active *codexActiveTurn) error {
	if err := d.resolveSettings(ctx, active); err != nil {
		return err
	}
	if d.cancelBeforeSubmission(ctx, active) {
		return nil
	}
	if active.tc.Trace != nil {
		active.tc.Trace.Mark("authReady", map[string]any{"runtimeId": d.runtime.RuntimeScope})
	}
	if err := d.acquireThread(ctx, active); err != nil {
		return err
	}
	if d.cancelBeforeSubmission(ctx, active) {
		return nil
	}
	d.applyDocumentTokenBudget(ctx, active)

	oversized := NeedsDocumentInjection(TurnAttachmentInput{Prompt: active.prompt, Parts: active.turnParts})
	budgetTrimmed := active.hasDocumentBudget && (active.documentBudget.TruncatedBlocks > 0 || active.documentBudget.DroppedBlocks > 0)
	hasDocs := active.hasTurnParts && len(active.turnParts.DocumentBlocks) > 0
	if active.threadHadHistory && (hasDocs || oversized || budgetTrimmed) {
		if err := d.compactNativeThread(ctx, active); err != nil {
			return err
		}
		if d.cancelBeforeSubmission(ctx, active) {
			return nil
		}
	}
	if err := d.injectOversizedDocuments(ctx, active); err != nil {
		return err
	}
	if d.cancelBeforeSubmission(ctx, active) {
		return nil
	}
	if active.tc.Trace != nil {
		active.tc.Trace.Mark("turnSubmitted", nil)
	}
	active.submissionStarted = true
	turnParams, err := BuildCodexTurnStartParams(
		active.approvalMode,
		active.nativeThreadId,
		active.prompt,
		active.imagePaths,
		active.model,
		active.reasoningEffort,
		active.tc.RunID,
	)
	if err != nil {
		return err
	}
	turnParams = ApplyCodexChatTurnParams(turnParams, d.currentSession(ctx))
	return d.submitCodexTurn(ctx, active, turnParams)
}

func (d *CodexSessionDriver) launchCompaction(ctx context.Context, active *codexActiveTurn) error {
	if err := d.resolveSettings(ctx, active); err != nil {
		return err
	}
	if err := d.acquireThread(ctx, active); err != nil {
		return err
	}
	if err := d.compactNativeThread(ctx, active); err != nil {
		return err
	}
	if !active.isSettled() {
		active.nativeTerminal = true
		active.settle(map[string]any{"status": "completed"}, nil)
	}
	return nil
}

func (d *CodexSessionDriver) cancelBeforeSubmission(_ context.Context, active *codexActiveTurn) bool {
	if active.isSettled() {
		return true
	}
	if !active.cancelRequested || active.submissionStarted {
		return false
	}
	active.cancelledBeforeSubmission = true
	active.settle(map[string]any{"status": "interrupted"}, nil)
	return true
}

func (d *CodexSessionDriver) resolveSettings(ctx context.Context, active *codexActiveTurn) error {
	policy := d.getSessionPolicy()
	reqModel := firstNonEmptyStr(active.model, asString(policy["model"]))
	reqEffort := firstNonEmptyStr(active.reasoningEffort, asString(policy["reasoningEffort"]))
	var settings TurnModelSettings
	var err error
	if d.nativeCatalog != nil {
		settings, err = d.nativeCatalog.ResolveTurnSettings(ctx, reqModel, reqEffort)
	} else if d.modelCatalog != nil {
		settings, err = d.modelCatalog.ResolveTurnSettings(ctx, d.currentSession(ctx), reqModel, reqEffort)
	} else {
		if reqModel == "" {
			return NewError("chat_turn_model_required", http.StatusUnprocessableEntity, nil)
		}
		settings = TurnModelSettings{Model: reqModel, ReasoningEffort: reqEffort}
	}
	if err != nil {
		return err
	}
	active.model = settings.Model
	active.reasoningEffort = settings.ReasoningEffort
	active.threadConfig = settings.ThreadConfig
	return nil
}

func (d *CodexSessionDriver) acquireThread(ctx context.Context, active *codexActiveTurn) error {
	if err := d.client.EnsureConnected(ctx); err != nil {
		return err
	}
	existingThread := d.getNativeThreadID()
	if existingThread != "" {
		active.threadHadHistory = true
		active.nativeThreadId = existingThread
		if err := d.history.Run(ctx); err != nil {
			return err
		}
		if err := d.bind(ctx, active); err != nil {
			return err
		}
		resumeParams, err := d.resumeParams(ctx, active.approvalMode, existingThread, true)
		if err != nil {
			return err
		}
		if _, err := d.client.Request(ctx, "thread/resume", resumeParams); err != nil {
			return err
		}
		_ = d.goals.Refresh(ctx, existingThread, active.tc.TurnID, active.tc.RunID, d.runtime.RuntimeScope)
		if active.tc.Trace != nil {
			active.tc.Trace.Mark("sessionBound", map[string]any{"runtimeId": d.runtime.RuntimeScope})
		}
		return nil
	}

	sess := d.currentSession(ctx)
	startParams, err := BuildCodexThreadStartParams(active.approvalMode, sess.ProjectPath, true)
	if err != nil {
		return err
	}
	sysPrompt := asString(sess.Policy["systemPrompt"])
	startParams = ApplyCodexChatThreadParams(startParams, sess, sysPrompt)
	startParams = ApplyCodexNativeHistoryPolicy(startParams)
	startParams = d.remoteThreadParams(startParams, false)

	res, err := d.client.Request(ctx, "thread/start", startParams)
	if err != nil {
		return err
	}
	threadObj, _ := res["thread"].(map[string]any)
	threadID := strings.TrimSpace(asString(threadObj["id"]))
	if threadID == "" {
		return NewError("codex_native_session_missing", http.StatusBadGateway, nil)
	}
	active.createdNativeThread = true
	seedItems, err := d.loadInitialHistory(ctx)
	if err != nil {
		return err
	}
	if len(seedItems) > 0 {
		win := codexContextWindowFromConfig(active.threadConfig)
		pct := codexDocBudgetPercent(sess.Policy)
		budgeted := BudgetHistoryItems(seedItems, win, pct)
		if _, err := d.client.Request(ctx, "thread/inject_items", map[string]any{
			"threadId": threadID,
			"items":    budgeted.Items,
		}); err != nil {
			return err
		}
		active.threadHadHistory = true
	}

	d.setNativeThreadID(threadID)
	active.nativeThreadId = threadID
	_, _ = d.store.UpdateRuntimeBinding(ctx, d.session.SessionID, map[string]any{
		"nativeSessionId": threadID,
		"fingerprint":     d.runtime.Fingerprint,
	}, nil)
	if err := d.bind(ctx, active); err != nil {
		return err
	}
	_ = d.goals.Refresh(ctx, threadID, active.tc.TurnID, active.tc.RunID, d.runtime.RuntimeScope)
	if active.tc.Trace != nil {
		active.tc.Trace.Mark("sessionBound", map[string]any{"runtimeId": d.runtime.RuntimeScope})
	}
	return nil
}

func (d *CodexSessionDriver) loadInitialHistory(ctx context.Context) ([]map[string]any, error) {
	d.mu.Lock()
	if d.historySeedLoaded {
		cp := append([]map[string]any(nil), d.initialHistory...)
		d.mu.Unlock()
		return cp, nil
	}
	d.mu.Unlock()

	seed, err := d.store.ReadHistorySeed(ctx, d.session.SessionID)
	if err != nil {
		return nil, err
	}
	var items []map[string]any
	if seed != nil {
		if len(seed.ResponseItems) > 0 {
			for _, raw := range seed.ResponseItems {
				if m := asMap(raw); m != nil {
					items = append(items, m)
				}
			}
		} else if srcID := strings.TrimSpace(asString(seed.Regeneration["sourceNativeSessionId"])); srcID != "" {
			items, err = ReadCodexHistorySeed(ctx, d.client, srcID, strings.TrimSpace(asString(seed.Regeneration["targetNativeTurnId"])), 0, 0, nil, nil)
			if err != nil {
				return nil, err
			}
		}
	}
	d.mu.Lock()
	d.initialHistory = items
	d.historySeedLoaded = true
	d.mu.Unlock()
	return append([]map[string]any(nil), items...), nil
}

func (d *CodexSessionDriver) applyDocumentTokenBudget(_ context.Context, active *codexActiveTurn) {
	if !active.hasTurnParts {
		return
	}
	policy := d.getSessionPolicy()
	win := codexContextWindowFromConfig(active.threadConfig)
	pct := codexDocBudgetPercent(policy)
	nextIn, report, changed := BudgetedTurnInput(TurnAttachmentInput{
		Prompt: active.prompt,
		Parts:  active.turnParts,
	}, win, pct)
	if !changed {
		return
	}
	active.turnParts = nextIn.Parts
	active.prompt = nextIn.Prompt
	active.documentBudget = report
	active.hasDocumentBudget = true
}

func (d *CodexSessionDriver) compactNativeThread(ctx context.Context, active *codexActiveTurn) error {
	waitCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	doneCh := make(chan error, 1)
	go func() {
		doneCh <- d.bridge.WaitForCompaction(waitCtx, active.nativeThreadId)
	}()
	if _, err := d.client.Request(ctx, "thread/compact/start", map[string]any{"threadId": active.nativeThreadId}); err != nil {
		d.bridge.CancelCompactionWaiters(err)
		<-doneCh
		return err
	}
	err := <-doneCh
	if err != nil {
		d.bridge.CancelCompactionWaiters(err)
		return err
	}
	return nil
}

func (d *CodexSessionDriver) injectOversizedDocuments(ctx context.Context, active *codexActiveTurn) error {
	turnIn := TurnAttachmentInput{Prompt: active.prompt, Parts: active.turnParts}
	if !NeedsDocumentInjection(turnIn) {
		return nil
	}
	runID := strings.TrimSpace(active.tc.RunID)
	d.mu.Lock()
	_, already := d.injectedDocumentRun[runID]
	d.mu.Unlock()
	if already {
		active.prompt = OversizedTurnPrompt(turnIn, 0)
		return nil
	}
	items := InjectableDocumentItems(active.turnParts.DocumentBlocks, runID)
	if _, err := d.client.Request(ctx, "thread/inject_items", map[string]any{
		"threadId": active.nativeThreadId,
		"items":    items,
	}); err != nil {
		return err
	}
	d.mu.Lock()
	d.injectedDocumentRun[runID] = struct{}{}
	d.mu.Unlock()
	active.prompt = OversizedTurnPrompt(turnIn, len(items))
	return nil
}

func (d *CodexSessionDriver) submitCodexTurn(ctx context.Context, active *codexActiveTurn, params map[string]any) error {
	res, err := d.client.Request(ctx, "turn/start", params)
	if err != nil {
		var chatErr *Error
		if errors.As(err, &chatErr) && chatErr.Code == "codex_app_server_disconnected" {
			active.submissionUncertain = true
			if d.reconnectGraceWait > 0 {
				timer := time.NewTimer(d.reconnectGraceWait)
				defer timer.Stop()
				select {
				case <-timer.C:
				case <-ctx.Done():
					return err
				}
			}
			if active.isSettled() {
				return nil
			}
			if active.persistedNativeTurnId != "" {
				return nil
			}
			return NewError("codex_turn_start_outcome_unknown", http.StatusBadGateway, map[string]any{
				"outcomeUnknown": true,
				"message":        "启动回执丢失，尚未确认原回合的执行结果；请先核对实际结果。",
			})
		}
		return err
	}
	turnObj, _ := res["turn"].(map[string]any)
	nativeTurnID := strings.TrimSpace(asString(turnObj["id"]))
	if nativeTurnID == "" {
		return NewError("codex_native_turn_missing", http.StatusBadGateway, nil)
	}
	return d.anchorNativeTurn(ctx, active, nativeTurnID)
}

func (d *CodexSessionDriver) anchorNativeTurn(ctx context.Context, active *codexActiveTurn, nativeTurnID string) error {
	active.anchorMu.Lock()
	defer active.anchorMu.Unlock()
	if active.nativeTurnId != "" && active.nativeTurnId != nativeTurnID {
		return NewError("codex_native_turn_anchor_conflict", http.StatusConflict, nil)
	}
	active.nativeTurnId = nativeTurnID
	if active.persistedNativeTurnId == nativeTurnID {
		return nil
	}
	if _, err := d.store.UpdateActiveTurnAnchor(ctx, d.session.SessionID, active.tc.RunID, nativeTurnID, active.tc.RunID); err != nil {
		return err
	}
	active.persistedNativeTurnId = nativeTurnID
	return nil
}

func (d *CodexSessionDriver) bind(ctx context.Context, active *codexActiveTurn) error {
	resumeFull, _ := d.resumeParams(ctx, active.approvalMode, active.nativeThreadId, false)
	binding := CodexTurnBinding{
		ResumeParams: resumeFull,
		OnDisconnected: func(err error) {
			if active.submissionUncertain {
				active.settle(nil, NewError("codex_turn_start_outcome_unknown", http.StatusBadGateway, map[string]any{
					"outcomeUnknown": true,
					"cause":          err.Error(),
				}))
				return
			}
			active.settle(nil, err)
		},
		OnNotification: func(msg CodexJSONRPCMessage) {
			d.observe(active, msg, false)
		},
		OnServerRequest: func(msg CodexJSONRPCMessage) {
			d.observe(active, msg, true)
		},
		OnReconnectResume: func(resp map[string]any, historyClient CodexRPCClient) {
			if err := d.reconnectRecovery(context.Background(), active, resp, historyClient); err != nil {
				active.settle(nil, err)
			}
		},
	}
	if scoped, ok := d.client.(codexScopedTurnClient); ok {
		handle, err := scoped.BindTurnScoped(ctx, active.nativeThreadId, binding)
		if err != nil {
			return err
		}
		active.mu.Lock()
		if active.cleaned || active.settled {
			active.mu.Unlock()
			handle.Unbind()
			return context.Canceled
		}
		previous := active.binding
		active.binding = handle
		active.mu.Unlock()
		if previous != nil {
			previous.Unbind()
		}
	} else {
		d.client.BindTurn(active.nativeThreadId, binding)
	}
	return nil
}

// unbindActiveTurn 在 EOF/重连后仍精确撤销旧回调，不按线程名猜测当前代次。
func (d *CodexSessionDriver) unbindActiveTurn(active *codexActiveTurn) {
	active.mu.Lock()
	handle := active.binding
	active.binding = nil
	active.mu.Unlock()
	if handle != nil {
		handle.Unbind()
	} else if _, scoped := d.client.(codexScopedTurnClient); !scoped && active.nativeThreadId != "" {
		d.client.UnbindTurn(active.nativeThreadId)
	}
}

func (d *CodexSessionDriver) observe(active *codexActiveTurn, msg CodexJSONRPCMessage, serverRequest bool) {
	d.mu.Lock()
	isCurrent := d.active == active
	d.mu.Unlock()
	if !isCurrent || active.isSettled() {
		return
	}
	if serverRequest && msg.Method == "item/tool/call" {
		if d.handleDynamicToolCall(msg) {
			return
		}
	}
	if !serverRequest && !d.acceptsNotification(msg) {
		return
	}
	if msg.Method == "thread/tokenUsage/updated" {
		if active.nativeTurnId == "" || asString(msg.Params["turnId"]) != active.nativeTurnId {
			return
		}
	}
	ctx := msg.Context
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, defaultCodexRPCTimeout)
	defer cancel()
	var obs CodexBridgeObservation
	if active.toolOrder != nil {
		active.toolOrder.ObserveRaw(msg)
	}
	if serverRequest {
		obs = d.bridge.ForwardServerRequest(ctx, msg, active.tc.TurnID, active.tc.RunID, d.runtime.RuntimeScope)
	} else {
		obs = d.bridge.ForwardNotification(ctx, msg, active.tc.TurnID, active.tc.RunID, d.runtime.RuntimeScope, active.toolOrder, "")
	}
	d.trackGoalNotification(obs.Mapped)
	if obs.Mapped.Type == "turn.started" && obs.ProviderTurnID != "" {
		if err := d.anchorNativeTurn(ctx, active, obs.ProviderTurnID); err != nil {
			active.settle(nil, err)
			return
		}
	}
	if obs.Compaction {
		if obs.Err != nil {
			active.settle(nil, obs.Err)
		}
		return
	}
	if obs.Err != nil {
		active.settle(nil, obs.Err)
		return
	}
	switch obs.Mapped.Type {
	case "turn.completed", "turn.interrupted", "turn.failed":
		if obs.Mapped.Type == "turn.failed" && isCodexContextLengthFailure(obs.Mapped) && !active.contextOverflowRetried {
			if err := d.retryAfterContextOverflow(ctx, active); err != nil {
				active.settle(nil, err)
			}
			return
		}
		d.settleFromMapped(active, obs.Mapped)
	}
}

func (d *CodexSessionDriver) retryAfterContextOverflow(ctx context.Context, active *codexActiveTurn) error {
	active.contextOverflowRetried = true
	previousThreadID := active.nativeThreadId
	replacement := &NativeThreadReplacement{
		ThreadID:     previousThreadID,
		NativeTurnID: active.nativeTurnId,
		RunID:        active.tc.RunID,
	}
	win := codexContextWindowFromConfig(active.threadConfig)
	seedItems, err := ReadCodexHistorySeed(ctx, d.client, previousThreadID, active.nativeTurnId, win, codexOverflowSeedPercent, nil, nil)
	if err != nil {
		return err
	}
	sess := d.currentSession(ctx)
	startParams, err := BuildCodexThreadStartParams(active.approvalMode, sess.ProjectPath, true)
	if err != nil {
		return err
	}
	startParams = ApplyCodexChatThreadParams(startParams, sess, asString(sess.Policy["systemPrompt"]))
	startParams = ApplyCodexNativeHistoryPolicy(startParams)
	startParams = d.remoteThreadParams(startParams, false)
	res, err := d.client.Request(ctx, "thread/start", startParams)
	if err != nil {
		return err
	}
	threadObj, _ := res["thread"].(map[string]any)
	nextThreadID := strings.TrimSpace(asString(threadObj["id"]))
	if nextThreadID == "" {
		return NewError("codex_native_session_missing", http.StatusBadGateway, nil)
	}
	if len(seedItems) > 0 {
		if _, err := d.client.Request(ctx, "thread/inject_items", map[string]any{
			"threadId": nextThreadID,
			"items":    seedItems,
		}); err != nil {
			return err
		}
	}
	d.setNativeThreadID(nextThreadID)
	active.nativeThreadId = nextThreadID
	active.nativeTurnId = ""
	active.persistedNativeTurnId = ""
	active.threadHadHistory = len(seedItems) > 0
	_, _ = d.store.UpdateRuntimeBinding(ctx, d.session.SessionID, map[string]any{
		"nativeSessionId": nextThreadID,
		"fingerprint":     d.runtime.Fingerprint,
	}, replacement)
	active.mu.Lock()
	previousBinding := active.binding
	active.binding = nil
	active.mu.Unlock()
	if previousBinding != nil {
		if err := previousBinding.Release(ctx); err != nil {
			return err
		}
	} else if _, scoped := d.client.(codexScopedTurnClient); !scoped {
		d.client.UnbindTurn(previousThreadID)
		_ = d.client.ReleaseThread(ctx, previousThreadID)
	}
	if err := d.bind(ctx, active); err != nil {
		return err
	}
	d.applyDocumentTokenBudget(ctx, active)
	if err := d.injectOversizedDocuments(ctx, active); err != nil {
		return err
	}
	turnParams, err := BuildCodexTurnStartParams(
		active.approvalMode,
		nextThreadID,
		active.prompt,
		active.imagePaths,
		active.model,
		active.reasoningEffort,
		active.tc.RunID,
	)
	if err != nil {
		return err
	}
	turnParams = ApplyCodexChatTurnParams(turnParams, sess)
	return d.submitCodexTurn(ctx, active, turnParams)
}

func (d *CodexSessionDriver) reconnectRecovery(ctx context.Context, active *codexActiveTurn, resp map[string]any, historyClient CodexRPCClient) error {
	d.mu.Lock()
	isCurrent := d.active == active
	d.mu.Unlock()
	if !isCurrent || active.isSettled() {
		return nil
	}
	snapshot, err := d.restoreRecoveredSnapshot(ctx, active, resp, historyClient)
	if err != nil {
		return err
	}
	_ = d.goals.Refresh(ctx, active.nativeThreadId, active.tc.TurnID, active.tc.RunID, d.runtime.RuntimeScope)
	if active.nativeTurnId != "" && active.nativeTurnId != active.persistedNativeTurnId {
		_, _ = d.store.UpdateActiveTurnAnchor(ctx, d.session.SessionID, active.tc.RunID, active.nativeTurnId, "")
		active.persistedNativeTurnId = active.nativeTurnId
	}
	active.submissionUncertain = false
	d.mu.Lock()
	stillCurrent := d.active == active
	d.mu.Unlock()
	if stillCurrent && !active.isSettled() {
		d.settleFromRecoveredSnapshot(active, snapshot)
	}
	return nil
}

type codexRecoveredTurn struct {
	id     string
	status string
	errObj any
}

func (d *CodexSessionDriver) restoreRecoveredSnapshot(ctx context.Context, active *codexActiveTurn, resp map[string]any, historyClient CodexRPCClient) (codexRecoveredTurn, error) {
	if active.nativeTurnId != "" {
		_ = d.bridge.MarkHistoryCoverage(ctx, active.nativeThreadId, active.nativeTurnId, "gap")
	}
	if historyClient == nil {
		historyClient = d.client
	}
	hydrated, err := HydrateCodexHistoryResponse(ctx, historyClient, resp, active.nativeThreadId)
	if err != nil {
		return codexRecoveredTurn{}, err
	}
	snap, err := extractRecoveredTurnSnapshot(hydrated, active.nativeTurnId, firstNonEmptyStr(active.clientUserMessageId, active.tc.RunID))
	if err != nil {
		return codexRecoveredTurn{}, err
	}
	if snap.id != active.nativeTurnId {
		_ = d.bridge.MarkHistoryCoverage(ctx, active.nativeThreadId, snap.id, "gap")
	}
	if err := d.history.ImportRecovered(ctx, hydrated, active.nativeThreadId); err != nil {
		return codexRecoveredTurn{}, err
	}
	active.nativeTurnId = snap.id
	return snap, nil
}

func extractRecoveredTurnSnapshot(resp map[string]any, nativeTurnID, clientUserMsgID string) (codexRecoveredTurn, error) {
	thread, _ := resp["thread"].(map[string]any)
	rawTurns, _ := thread["turns"].([]any)
	var chosen map[string]any
	if nativeTurnID != "" {
		for _, rt := range rawTurns {
			if tm := asMap(rt); tm != nil && asString(tm["id"]) == nativeTurnID {
				chosen = tm
				break
			}
		}
	} else if clientUserMsgID != "" {
		var matches []map[string]any
		for _, rt := range rawTurns {
			tm := asMap(rt)
			if tm == nil {
				continue
			}
			items, _ := tm["items"].([]any)
			for _, ri := range items {
				im := asMap(ri)
				if im != nil && asString(im["type"]) == "userMessage" && asString(im["clientId"]) == clientUserMsgID {
					matches = append(matches, tm)
					break
				}
			}
		}
		if len(matches) > 1 {
			return codexRecoveredTurn{}, NewError("codex_native_turn_recovery_anchor_ambiguous", http.StatusConflict, nil)
		}
		if len(matches) == 1 {
			chosen = matches[0]
		}
	}
	if chosen == nil {
		return codexRecoveredTurn{}, NewError("codex_native_turn_recovery_anchor_missing", http.StatusConflict, nil)
	}
	id := strings.TrimSpace(asString(chosen["id"]))
	status := strings.TrimSpace(asString(chosen["status"]))
	switch status {
	case "inProgress", "completed", "interrupted", "failed":
	default:
		return codexRecoveredTurn{}, NewError("codex_native_turn_recovery_missing", http.StatusConflict, nil)
	}
	return codexRecoveredTurn{id: id, status: status, errObj: chosen["error"]}, nil
}

func (d *CodexSessionDriver) settleFromRecoveredSnapshot(active *codexActiveTurn, snap codexRecoveredTurn) {
	switch snap.status {
	case "completed":
		active.nativeTerminal = true
		active.settle(map[string]any{"status": "completed"}, nil)
	case "interrupted":
		active.nativeTerminal = true
		active.settle(map[string]any{"status": "interrupted"}, nil)
	case "failed":
		active.nativeTerminal = true
		errMsg := "codex_turn_failed"
		if em := asMap(snap.errObj); em != nil && asString(em["message"]) != "" {
			errMsg = asString(em["message"])
		}
		active.settle(nil, NewError("codex_turn_failed", http.StatusBadGateway, map[string]any{"message": errMsg, "error": snap.errObj}))
	}
}

func (d *CodexSessionDriver) settleFromMapped(active *codexActiveTurn, mapped CodexMappedMessage) {
	active.nativeTerminal = true
	if mapped.Type == "turn.failed" {
		errObj := asMap(mapped.Payload["error"])
		msg := asString(errObj["message"])
		err := NewError("codex_turn_failed", http.StatusBadGateway, mapped.Payload)
		if msg != "" {
			err.Message = msg
		}
		active.settle(nil, err)
		return
	}
	status := "completed"
	if mapped.Type == "turn.interrupted" {
		status = "interrupted"
	}
	active.settle(map[string]any{"status": status}, nil)
}

func (d *CodexSessionDriver) finishCleanup(active *codexActiveTurn) {
	active.mu.Lock()
	if active.cleaned {
		active.mu.Unlock()
		return
	}
	active.cleaned = true
	active.mu.Unlock()
	defer close(active.cleanCh)

	d.bridge.CancelExpectedReplays()
	d.bridge.CancelCompactionWaiters(nil)
	if active.toolOrder != nil {
		active.toolOrder.Flush()
	}
	releaseThread := (active.nativeTerminal || active.cancelledBeforeSubmission) && active.nativeThreadId != ""
	if active.nativeThreadId != "" && !releaseThread {
		d.unbindActiveTurn(active)
	}
	if active.cancelledBeforeSubmission && active.createdNativeThread {
		_, _ = d.store.UpdateRuntimeBinding(context.Background(), d.session.SessionID, map[string]any{
			"nativeSessionId": "",
			"fingerprint":     d.runtime.Fingerprint,
		}, nil)
		if d.getNativeThreadID() == active.nativeThreadId {
			d.setNativeThreadID("")
		}
	}
	if releaseThread {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), d.cleanupTimeout)
		var err error
		active.mu.Lock()
		handle := active.binding
		active.binding = nil
		active.mu.Unlock()
		if handle != nil {
			err = handle.Release(cleanupCtx)
		} else if _, scoped := d.client.(codexScopedTurnClient); !scoped {
			d.unbindActiveTurn(active)
			err = d.client.ReleaseThread(cleanupCtx, active.nativeThreadId)
		}
		cancel()
		if err != nil && d.releaseFailureSink != nil {
			d.releaseFailureSink(map[string]any{"code": "codex_thread_release_failed", "threadId": active.nativeThreadId})
		}
	}
	d.mu.Lock()
	if d.active == active {
		d.active = nil
	}
	d.mu.Unlock()
}

func (d *CodexSessionDriver) handleDynamicToolCall(msg CodexJSONRPCMessage) bool {
	ctx := msg.Context
	if ctx == nil {
		ctx = context.Background()
	}
	wsID := webuiremoteworkspace.WorkspaceIDFromProjectPath(d.aiHomeDir, d.session.ProjectPath)
	if wsID == "" {
		_ = d.client.Respond(ctx, msg.ID, map[string]any{
			"contentItems": []map[string]any{{"type": "inputText", "text": fmt.Sprintf("[unknown_tool] %s", asString(msg.Params["tool"]))}},
			"success":      false,
		})
		return true
	}
	if d.remoteTools == nil {
		return false
	}
	go func() {
		ctx, cancel := context.WithTimeout(ctx, defaultCodexRPCTimeout)
		defer cancel()
		items, isErr := d.remoteTools(ctx, wsID, asString(msg.Params["tool"]), msg.Params["arguments"])
		contentItems := make([]map[string]any, 0, len(items))
		for _, item := range items {
			contentItems = append(contentItems, map[string]any{"type": "inputText", "text": asString(item["text"])})
		}
		_ = d.client.Respond(ctx, msg.ID, map[string]any{
			"contentItems": contentItems,
			"success":      !isErr,
		})
	}()
	return true
}

func (d *CodexSessionDriver) acceptsNotification(msg CodexJSONRPCMessage) bool {
	if msg.Method != "item/started" && msg.Method != "item/completed" {
		return true
	}
	item := asMap(msg.Params["item"])
	if item == nil {
		return true
	}
	itemID := strings.TrimSpace(asString(item["id"]))
	if itemID == "" {
		return true
	}
	if asString(item["type"]) == "userMessage" && strings.TrimSpace(asString(item["source"])) == "goal" {
		d.mu.Lock()
		d.goalItemsSeen[itemID] = struct{}{}
		d.mu.Unlock()
		return false
	}
	return true
}

func (d *CodexSessionDriver) trackGoalNotification(mapped CodexMappedMessage) {
	if mapped.Type != "timeline.item.started" && mapped.Type != "timeline.item.completed" {
		return
	}
	item := asMap(mapped.Payload["item"])
	if item == nil {
		return
	}
	itemID := strings.TrimSpace(asString(item["itemId"]))
	if itemID == "" {
		return
	}
	d.mu.Lock()
	_, isGoal := d.goalItemsSeen[itemID]
	d.mu.Unlock()
	if isGoal && mapped.Type == "timeline.item.completed" {
		d.mu.Lock()
		delete(d.goalItemsSeen, itemID)
		d.mu.Unlock()
	}
}

func (d *CodexSessionDriver) resumeParams(ctx context.Context, approvalMode, threadID string, excludeTurns bool) (map[string]any, error) {
	p, err := BuildCodexThreadResumeParams(approvalMode, threadID, excludeTurns)
	if err != nil {
		return nil, err
	}
	p = ApplyCodexChatThreadParams(p, d.currentSession(ctx), "")
	p = ApplyCodexNativeHistoryPolicy(p)
	return d.remoteThreadParams(p, true), nil
}

func (d *CodexSessionDriver) remoteThreadParams(params map[string]any, resume bool) map[string]any {
	return CodexRemoteThreadParams(params, d.aiHomeDir, d.session.ProjectPath, resume)
}

// CodexRemoteThreadParams 为远程工作区影子目录会话补齐 dynamicTools 与禁用本机工具配置。
func CodexRemoteThreadParams(params map[string]any, aiHomeDir, projectPath string, resume bool) map[string]any {
	wsID := webuiremoteworkspace.WorkspaceIDFromProjectPath(aiHomeDir, projectPath)
	if wsID == "" {
		return params
	}
	out := CloneMap(params)
	existingInstr := strings.TrimSpace(asString(out["developerInstructions"]))
	remoteInstr := "你在一个「远程工作区」里工作：项目文件在远端机器上，不在本机。只能用远程工具读写文件和执行命令；路径一律相对工作区根目录。本机当前目录是一个空的占位目录，不要在本机查找项目文件。"
	if existingInstr != "" {
		out["developerInstructions"] = existingInstr + "\n\n" + remoteInstr
	} else {
		out["developerInstructions"] = remoteInstr
	}
	cfg := CloneMap(asMap(out["config"]))
	if cfg == nil {
		cfg = map[string]any{}
	}
	cfg["features.shell_tool"] = false
	cfg["features.unified_exec"] = false
	cfg["project_doc_max_bytes"] = 0
	out["config"] = cfg
	if !resume {
		out["dynamicTools"] = codexRemoteDynamicToolDefinitions()
	}
	return out
}

func codexRemoteDynamicToolDefinitions() []map[string]any {
	return []map[string]any{
		{"type": "function", "name": "read_file", "description": "读取远程工作区文本文件"},
		{"type": "function", "name": "write_file", "description": "写入远程工作区文件"},
		{"type": "function", "name": "edit_file", "description": "精确替换远程工作区文本"},
		{"type": "function", "name": "list_directory", "description": "列出远程工作区目录"},
		{"type": "function", "name": "search", "description": "搜索远程工作区文件"},
		{"type": "function", "name": "run_command", "description": "在远程工作区执行命令"},
	}
}

func (d *CodexSessionDriver) resolveTurnParts(ctx context.Context, payload map[string]any) (TurnAttachmentInput, bool, error) {
	if payload == nil {
		return TurnAttachmentInput{}, false, nil
	}
	var ids []string
	if rawIDs, ok := payload["attachmentIds"]; ok && rawIDs != nil {
		normalized, err := NormalizeAttachmentIDs(rawIDs, false)
		if err != nil {
			return TurnAttachmentInput{}, false, err
		}
		ids = normalized
	}
	rawContent := asString(payload["content"])
	if len(ids) == 0 {
		return TurnAttachmentInput{}, false, nil
	}
	var paths []string
	var err error
	if d.store != nil {
		paths, err = d.store.ResolveAttachmentPaths(ctx, d.session.SessionID, ids)
		if err != nil {
			return TurnAttachmentInput{}, false, err
		}
	}
	turnIn, err := SessionAttachmentTurnInput(d.currentSession(ctx), rawContent, paths)
	if err != nil {
		return TurnAttachmentInput{}, false, err
	}
	return turnIn, true, nil
}

func (d *CodexSessionDriver) currentSession(ctx context.Context) *Session {
	if d.store != nil {
		if latest, err := d.store.GetSession(ctx, d.session.SessionID); err == nil && latest != nil {
			return latest
		}
	}
	return d.session
}

func (d *CodexSessionDriver) getSessionPolicy() map[string]any {
	if d.store != nil {
		if latest, err := d.store.GetSession(context.Background(), d.session.SessionID); err == nil && latest != nil {
			return latest.Policy
		}
	}
	return d.session.Policy
}

func (d *CodexSessionDriver) currentApprovalMode(ctx context.Context) string {
	sess := d.currentSession(ctx)
	mode := strings.ToLower(strings.TrimSpace(asString(sess.Policy["approvalMode"])))
	if mode == "" {
		return "bypass"
	}
	return mode
}

func (d *CodexSessionDriver) getNativeThreadID() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.nativeThreadID
}

func (d *CodexSessionDriver) setNativeThreadID(id string) {
	d.mu.Lock()
	d.nativeThreadID = strings.TrimSpace(id)
	d.mu.Unlock()
}

func isCodexContextLengthFailure(mapped CodexMappedMessage) bool {
	if errObj := asMap(mapped.Payload["error"]); errObj != nil {
		if b, _ := json.Marshal(errObj); codexContextOverflowPattern.Match(b) {
			return true
		}
	}
	return false
}

func codexContextWindowFromConfig(cfg map[string]any) int {
	if cfg == nil {
		return 0
	}
	if n, ok := asSafeInt64(cfg["model_context_window"]); ok && n > 0 {
		return int(n)
	}
	return 0
}

func codexDocBudgetPercent(policy map[string]any) int {
	if policy == nil {
		return 0
	}
	if n, ok := asSafeInt64(policy["documentBudgetPercent"]); ok && n > 0 {
		return int(n)
	}
	return 0
}
