package chatruntime

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/modelmetadata/modelsdev"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
	"github.com/madou1217/ai_home/internal/runtime/providercli/sessionchat"
)

const (
	defaultServiceEventRetention = 500
	maxServiceEventRetention     = 1000
	composerCatalogCacheTTL      = 30 * time.Second
)

// ArtifactReader 定义对话产物的只读解析端口。
type ArtifactReader interface {
	Read(ctx context.Context, artifactID string) (*Artifact, error)
}

// ArtifactReaderFunc 把函数适配为 ArtifactReader。
type ArtifactReaderFunc func(ctx context.Context, artifactID string) (*Artifact, error)

// Read 执行产物读取回调。
func (fn ArtifactReaderFunc) Read(ctx context.Context, artifactID string) (*Artifact, error) {
	return fn(ctx, artifactID)
}

type unsupportedArtifactReader struct{}

func (unsupportedArtifactReader) Read(_ context.Context, _ string) (*Artifact, error) {
	return nil, nil
}

// ServiceOptions 配置全功能的 Canonical Chat Runtime Service。
type ServiceOptions struct {
	Store                   *Store
	DBPath                  string
	AIHomeDir               string
	HostHomeDir             string
	AccountStore            AccountPoolReader
	ProviderCatalog         *providers.Catalog
	MetadataIndex           *modelsdev.Index
	ChatStreamer            ChatTurnStreamer
	CodexPool               *CodexClientPool
	ApprovalCallbackURL     string
	CodexExecutablePath     string
	CodexRPCClient          CodexRPCClient
	CodexDriverFactory      func(ctx context.Context, opts CodexDriverOptions) (*DriverEntry, error)
	NativeRunner            NativeTurnRunner
	RuntimeResolver         RuntimeResolver
	DriverRegistry          DriverRegistry
	CommandCatalog          *CapabilityCommandCatalog
	AttachmentService       *AttachmentService
	WorkspaceCheckpoints    WorkspaceCheckpointsOpener
	ArtifactReader          ArtifactReader
	Extensions              *ExtensionPipeline
	CLIInteractions         *CLIInteractionCoordinator
	EventRetentionLimit     int
	TraceSink               func(TraceSnapshot)
	Diagnostics             func(map[string]any)
	ResolveFallbackAccounts func(ctx context.Context, provider, currentRef string) []string
	ReadProviderModels      func(ctx context.Context, provider, accountRef string) []string
	ResolveDefaultModel     func(provider string) string
	GetAdoptedNativeRun     func(engineRunID string) *NativeRunHandle
	IsModelEnabled          func(modelID string) bool
	Clock                   func() int64
	IDFactory               func(string) string
	ReleaseFailureSink      func(map[string]any)
	RemoteTools             CodexRemoteToolExecutor
}

type composerCacheEntry struct {
	updatedAt time.Time
	value     map[string]any
}

type ReadEventsResult struct {
	Gap        bool            `json:"gap"`
	Snapshot   *Snapshot       `json:"snapshot,omitempty"`
	Events     []EventEnvelope `json:"events"`
	ThroughSeq int64           `json:"throughSeq"`
}

// Service 聚合持久化存储、事件广播、Actor 调度、能力目录、附件、检查点与重启恢复。
type Service struct {
	opts                 ServiceOptions
	store                *Store
	ownsStore            bool
	ownsCodexPool        bool
	publisher            *PublishingStore
	eventHub             *EventHub
	extensions           *ExtensionPipeline
	traceLifecycle       *TraceLifecycle
	actors               *ActorRegistry
	recovery             *RecoveryCoordinator
	queueAutomation      *AutomaticQueueCoordinator
	sessionResolver      *SessionResolutionCoordinator
	chatSessions         *ChatSessionCoordinator
	attachments          *AttachmentService
	catalog              *CapabilityCommandCatalog
	modelResolver        *ModelCatalogResolver
	codexPool            *CodexClientPool
	workspaceCheckpoints WorkspaceCheckpointsOpener
	artifactReader       ArtifactReader
	cliInteractions      *CLIInteractionCoordinator
	eventRetentionLimit  int

	composerMu    sync.Mutex
	composerCache map[string]composerCacheEntry
	composerTasks map[string]*composerFlight

	prewarmCtx    context.Context
	prewarmCancel context.CancelFunc
	prewarmWG     sync.WaitGroup

	runsMu              sync.RWMutex
	activeRuns          map[string]*ActiveRunRegistration
	surfacesByRun       map[string]*NativeApprovalSurface
	surfacesBySession   map[string]*NativeApprovalSurface
	standaloneApprovals *standaloneApprovalRegistry
	cliConfirmations    *CLIInstallConfirmationRegistry
}

type composerFlight struct {
	done chan struct{}
	val  map[string]any
	err  error
}

// NewService 创建并初始化 Canonical Chat Runtime Service。
func NewService(ctx context.Context, opts ServiceOptions) (*Service, error) {
	if opts.Clock == nil {
		opts.Clock = func() int64 { return time.Now().UnixMilli() }
	}
	if opts.IDFactory == nil {
		opts.IDFactory = DefaultIDFactory
	}

	store := opts.Store
	ownsStore := false
	if store == nil {
		dbPath := strings.TrimSpace(opts.DBPath)
		if dbPath == "" && strings.TrimSpace(opts.AIHomeDir) != "" {
			var pathErr error
			dbPath, pathErr = appstate.DatabasePath(opts.AIHomeDir)
			if pathErr != nil {
				return nil, pathErr
			}
		}
		var err error
		store, err = OpenStoreWithOptions(ctx, StoreOptions{
			DBPath:                  dbPath,
			Clock:                   opts.Clock,
			IDFactory:               opts.IDFactory,
			EnableHistoryCompaction: true,
		})
		if err != nil {
			return nil, err
		}
		ownsStore = true
	}

	eventHub := NewEventHub()
	extensions := opts.Extensions
	if extensions == nil {
		extensions, _ = NewExtensionPipeline(ExtensionPipelineOptions{})
	}
	traceLifecycle := NewTraceLifecycle(func(attrs map[string]any) *ChatRuntimeTrace {
		return NewChatRuntimeTrace(attrs, opts.Clock, opts.IDFactory)
	}, opts.TraceSink)

	codexPool := opts.CodexPool
	ownsCodexPool := false
	if codexPool == nil {
		codexPool = NewCodexClientPool(nil)
		ownsCodexPool = true
	}

	cmdCatalog := opts.CommandCatalog
	if cmdCatalog == nil {
		cmdCatalog = NewCapabilityCommandCatalog()
	}

	provCatalog := opts.ProviderCatalog
	if provCatalog == nil {
		provCatalog, _ = providers.NewCatalog(providers.BuiltinManifest())
	}
	modelResolver := &ModelCatalogResolver{
		AIHomeDir:     opts.AIHomeDir,
		Catalog:       provCatalog,
		AccountStore:  opts.AccountStore,
		MetadataIndex: opts.MetadataIndex,
	}

	retention := opts.EventRetentionLimit
	if retention <= 0 {
		retention = defaultServiceEventRetention
	}
	if retention > maxServiceEventRetention {
		retention = maxServiceEventRetention
	}

	artReader := opts.ArtifactReader
	if artReader == nil {
		artReader = unsupportedArtifactReader{}
	}

	wsCheckpoints := opts.WorkspaceCheckpoints
	if wsCheckpoints == nil && opts.AIHomeDir != "" {
		wsCheckpoints = DefaultWorkspaceCheckpointsOpener(opts.AIHomeDir, opts.HostHomeDir, nil)
	}

	prewarmCtx, prewarmCancel := context.WithCancel(context.Background())
	svc := &Service{
		opts:                 opts,
		store:                store,
		ownsStore:            ownsStore,
		ownsCodexPool:        ownsCodexPool,
		eventHub:             eventHub,
		extensions:           extensions,
		traceLifecycle:       traceLifecycle,
		catalog:              cmdCatalog,
		modelResolver:        modelResolver,
		codexPool:            codexPool,
		workspaceCheckpoints: wsCheckpoints,
		artifactReader:       artReader,
		eventRetentionLimit:  retention,
		composerCache:        make(map[string]composerCacheEntry),
		composerTasks:        make(map[string]*composerFlight),
		prewarmCtx:           prewarmCtx,
		prewarmCancel:        prewarmCancel,
	}

	svc.publisher = NewPublishingStore(PublishingStoreOptions{
		Store:    store,
		EventHub: eventHub,
		OnEventPublished: func(ev EventEnvelope) {
			svc.observePublishedEvent(ev)
		},
	})
	if opts.AttachmentService != nil {
		svc.attachments = opts.AttachmentService
	} else {
		attachments, aerr := NewAttachmentService(AttachmentServiceOptions{
			Store:       svc.publisher,
			AIHomeDir:   opts.AIHomeDir,
			HostHomeDir: opts.HostHomeDir,
		})
		if aerr != nil {
			if ownsCodexPool {
				_ = codexPool.Close()
			}
			if ownsStore {
				_ = store.Close()
			}
			return nil, aerr
		}
		svc.attachments = attachments
	}

	runtimeResolver := opts.RuntimeResolver
	if runtimeResolver == nil {
		runtimeResolver = &defaultRuntimeResolver{
			aiHomeDir:   opts.AIHomeDir,
			hostHomeDir: opts.HostHomeDir,
			codexBinary: opts.CodexExecutablePath,
		}
	}

	driverRegistry := opts.DriverRegistry
	if driverRegistry == nil {
		driverRegistry = &defaultDriverRegistry{svc: svc}
	}

	handlers := map[string]CommandHandler{
		"session.fork": func(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
			return svc.branchChatSession(ctx, hctx)
		},
		"turn.regenerate": func(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
			return svc.branchChatSession(ctx, hctx)
		},
	}

	svc.actors = NewActorRegistry(ActorRegistryOptions{
		Store:           svc.publisher,
		RuntimeResolver: runtimeResolver,
		DriverRegistry:  driverRegistry,
		IDFactory:       opts.IDFactory,
		Clock:           opts.Clock,
		CommandHandlers: handlers,
		Extensions:      extensions,
	})
	svc.recovery = NewRecoveryCoordinator(svc.actors, svc.publisher)
	svc.queueAutomation = NewAutomaticQueueCoordinator(AutomaticQueueCoordinatorOptions{
		Store: svc.publisher,
		DispatchCommand: func(c context.Context, sessionID string, input map[string]any) (map[string]any, error) {
			return svc.DispatchCommand(c, sessionID, input)
		},
		WaitForIdle: func(c context.Context, sessionID string) error {
			return svc.WaitForActorIdle(c, sessionID)
		},
		IDFactory: opts.IDFactory,
	})
	svc.sessionResolver = NewSessionResolutionCoordinator(SessionResolutionCoordinatorOptions{
		Actors:    svc.actors,
		Publisher: svc.publisher,
		Store:     store,
	})
	svc.chatSessions = NewChatSessionCoordinator(ChatSessionCoordinatorOptions{
		Store:         svc.publisher,
		Actors:        svc.actors,
		HostHomeDir:   opts.HostHomeDir,
		CreateSession: svc.CreateSession,
	})
	if opts.CLIInteractions != nil {
		svc.cliInteractions = opts.CLIInteractions
	} else {
		svc.cliInteractions = NewCLIInteractionCoordinator(svc.publisher, svc.ResolveSession, opts.IDFactory)
	}
	svc.ensureRunsControl()
	return svc, nil
}

// Store 返回带广播触发器的 PublishingStore。
func (s *Service) Store() *PublishingStore { return s.publisher }

// UnderlyingStore 返回底层 SQLite Store。
func (s *Service) UnderlyingStore() *Store { return s.store }

// EventHub 返回内存事件订阅总线。
func (s *Service) EventHub() *EventHub { return s.eventHub }

// Actors 返回按会话维护的 ActorRegistry。
func (s *Service) Actors() *ActorRegistry { return s.actors }

// CatalogResolver 返回模型与路线解析器。
func (s *Service) CatalogResolver() *ModelCatalogResolver { return s.modelResolver }

// CLIInteractionCoordinator 返回终端交互桥接协调器。
func (s *Service) CLIInteractionCoordinator() *CLIInteractionCoordinator { return s.cliInteractions }

// StartRecovery 启动崩溃前残余活动轮次的恢复流程。
func (s *Service) StartRecovery(ctx context.Context) {
	if s.recovery != nil {
		s.recovery.StartAsync(ctx)
	}
}

// WaitForRecovery 等待所有恢复任务完成。
func (s *Service) WaitForRecovery(ctx context.Context) error {
	if s.recovery == nil {
		return nil
	}
	return s.recovery.WaitForAll(ctx)
}

// WaitForActorIdle 等待指定会话的 Actor 队列和活跃轮次全部空闲。
func (s *Service) WaitForActorIdle(ctx context.Context, sessionID string) error {
	if s.recovery != nil {
		if err := s.recovery.WaitForSession(ctx, sessionID); err != nil {
			return err
		}
	}
	sess, err := s.publisher.RequireSession(ctx, sessionID)
	if err != nil {
		return err
	}
	actor, err := s.actors.Acquire(ctx, sess, nil)
	if err != nil {
		return err
	}
	return actor.WaitForIdle(ctx)
}

// CreateSession 创建全新持久化会话并绑定其真实路由能力快照。
func (s *Service) CreateSession(ctx context.Context, in CreateSessionInput) (*Session, error) {
	prov, err := RequiredText(in.Provider, "chat_session_provider_required")
	if err != nil {
		return nil, err
	}
	execRef, err := RequiredText(in.ExecutionAccountRef, "chat_session_execution_account_required")
	if err != nil {
		return nil, err
	}
	sessID := strings.TrimSpace(in.SessionID)
	if sessID == "" {
		sessID = s.store.NewID("session")
	}
	draft := &Session{
		SessionID:           sessID,
		Provider:            prov,
		ExecutionAccountRef: execRef,
		ProjectPath:         strings.TrimSpace(in.ProjectPath),
		State:               "idle",
		Policy:              CloneMap(in.Policy),
	}
	if draft.Policy == nil {
		draft.Policy = map[string]any{}
	}
	prepared, err := s.actors.Prepare(ctx, draft)
	if err != nil {
		return nil, err
	}
	defer prepared.Dispose()

	rtBinding := RuntimeBindingPatch(draft, prepared.Runtime)
	capSnap := EntryCapabilities(prepared.Entry, draft)
	if capSnap == nil {
		capSnap = map[string]any{}
	}

	created, err := s.publisher.CreateSession(ctx, CreateSessionInput{
		SessionID:           draft.SessionID,
		Provider:            draft.Provider,
		ExecutionAccountRef: draft.ExecutionAccountRef,
		ProjectPath:         draft.ProjectPath,
		Policy:              draft.Policy,
		RuntimeBinding:      rtBinding,
		CapabilitySnapshot:  capSnap,
	})
	if err != nil {
		return nil, err
	}
	_, _ = s.actors.Register(created, prepared)
	return created, nil
}

// ResolveSession 按 ID 或 nativeSessionId 领养/重绑定或新建 Work 会话。
func (s *Service) ResolveSession(ctx context.Context, in CreateSessionInput) (*ResolveSessionResult, error) {
	res, err := s.sessionResolver.Resolve(ctx, in)
	if err != nil {
		return nil, err
	}
	if res == nil || res.Session == nil {
		return res, nil
	}
	refreshed, changed := RefreshSlashCapabilities(res.Session, func(provider string) ([]string, bool) {
		cmds := ProviderSlashCommandNames(s.opts.HostHomeDir, provider)
		return cmds, len(cmds) > 0
	})
	if !changed {
		return res, nil
	}
	updated, err := s.publisher.UpdateCapabilitySnapshot(ctx, res.Session.SessionID, refreshed)
	if err != nil {
		return nil, err
	}
	return &ResolveSessionResult{Status: res.Status, Session: updated}, nil
}

// OpenChatSession 打开或迁移 legacy 纯聊天会话。
func (s *Service) OpenChatSession(ctx context.Context, in OpenChatSessionInput) (*Session, error) {
	sess, err := s.chatSessions.Open(ctx, in)
	if err != nil {
		return nil, err
	}
	refreshed, changed := RefreshSlashCapabilities(sess, func(provider string) ([]string, bool) {
		cmds := ProviderSlashCommandNames(s.opts.HostHomeDir, provider)
		return cmds, len(cmds) > 0
	})
	if !changed {
		return sess, nil
	}
	return s.publisher.UpdateCapabilitySnapshot(ctx, sess.SessionID, refreshed)
}

// ListSessions 列出满足过滤条件的会话。
func (s *Service) ListSessions(ctx context.Context, filter ListSessionsFilter) ([]Session, error) {
	return s.publisher.ListSessions(ctx, filter)
}

// DeleteSession 物理删除处于空闲或关闭态的会话及关联附件与旧版聊天记录。
func (s *Service) DeleteSession(ctx context.Context, sessionID string) (map[string]any, error) {
	sess, err := s.publisher.RequireSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if sess.State != "idle" && sess.State != "closed" {
		return nil, NewError("chat_session_busy", http.StatusConflict, map[string]any{"state": sess.State})
	}
	s.actors.Dispose(sessionID)
	s.composerMu.Lock()
	delete(s.composerCache, sessionID)
	delete(s.composerTasks, sessionID)
	s.composerMu.Unlock()

	deleted, err := s.publisher.DeleteSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	s.chatSessions.CleanupLegacySource(deleted)
	return map[string]any{
		"sessionId": deleted.SessionID,
		"provider":  deleted.Provider,
	}, nil
}

// GetSnapshot 读取会话最新快照（actor 在内存时以动态路由能力覆盖）。
func (s *Service) GetSnapshot(ctx context.Context, sessionID string) (*Snapshot, error) {
	if _, err := s.publisher.RequireSession(ctx, sessionID); err != nil {
		return nil, err
	}
	snap, err := s.publisher.GetSnapshot(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if caps := s.actors.GetCapabilities(ctx, sessionID); len(caps) > 0 {
		snap.CapabilitySnapshot = caps
	}
	return snap, nil
}

// ReadTimeline 分页读取会话时间线条目。
func (s *Service) ReadTimeline(ctx context.Context, sessionID, before string, limit int) (*TimelinePage, error) {
	if _, err := s.publisher.RequireSession(ctx, sessionID); err != nil {
		return nil, err
	}
	return s.publisher.ReadTimeline(ctx, sessionID, before, limit)
}

// UploadAttachments 持久化并预处理单次请求的多个附件。
func (s *Service) UploadAttachments(ctx context.Context, sessionID string, uploads []AttachmentUploadInput) ([]Attachment, error) {
	return s.attachments.Upload(ctx, sessionID, uploads)
}

// ReadEvents 增量读取事件；若客户端游标跨出保留窗口或因历史压缩存在序号空洞则返回 gap + snapshot 重置。
func (s *Service) ReadEvents(ctx context.Context, sessionID string, after int64) (*ReadEventsResult, error) {
	sess, err := s.publisher.RequireSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if after < 0 {
		after = 0
	}
	bounds, err := s.publisher.GetEventBounds(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	throughSeq := sess.LastEventSeq
	if bounds.LastSeq > throughSeq {
		throughSeq = bounds.LastSeq
	}
	firstSeq := int64(0)
	if bounds.FirstSeq != nil {
		firstSeq = *bounds.FirstSeq
	}
	firstRetained := retainedFirstSeq(firstSeq, throughSeq, s.eventRetentionLimit)
	if after > throughSeq || after < firstRetained-1 {
		snap, serr := s.GetSnapshot(ctx, sessionID)
		if serr != nil {
			return nil, serr
		}
		return &ReadEventsResult{Gap: true, Snapshot: snap, Events: []EventEnvelope{}, ThroughSeq: snap.ThroughSeq}, nil
	}
	events, err := s.publisher.ListEvents(ctx, sessionID, after, nil, s.eventRetentionLimit)
	if err != nil {
		return nil, err
	}
	if !isContiguousFrom(after, events) {
		snap, serr := s.GetSnapshot(ctx, sessionID)
		if serr != nil {
			return nil, serr
		}
		return &ReadEventsResult{Gap: true, Snapshot: snap, Events: []EventEnvelope{}, ThroughSeq: snap.ThroughSeq}, nil
	}
	return &ReadEventsResult{Gap: false, Events: events, ThroughSeq: throughSeq}, nil
}

// Subscribe 注册实时事件监听器并返回取消函数。
func (s *Service) Subscribe(sessionID string, listener EventListener) (func(), error) {
	return s.eventHub.Subscribe(sessionID, listener)
}

// DispatchCommand 向目标会话 Actor 派发一条幂等命令并按需同步模型能力快照。
func (s *Service) DispatchCommand(ctx context.Context, sessionID string, input map[string]any) (map[string]any, error) {
	if s.recovery != nil {
		if err := s.recovery.WaitForSession(ctx, sessionID); err != nil {
			return nil, err
		}
	}
	sess, err := s.publisher.RequireSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	cmdID := strings.TrimSpace(asString(input["commandId"]))
	cmdType := strings.TrimSpace(asString(input["type"]))
	trace := s.traceLifecycle.Start(map[string]any{
		"provider":  sess.Provider,
		"sessionId": sessionID,
		"commandId": cmdID,
	})
	trace.Mark("actorDequeued", nil)

	if cmdType == "turn.submit" {
		s.checkpointBeforeTurn(ctx, sess, cmdID)
	}

	actor, err := s.actors.Acquire(ctx, sess, nil)
	if err != nil {
		trace.Finish(map[string]any{"status": "failed", "errorCode": errCodeOf(err, "chat_command_failed")})
		return nil, s.wrapBranchError(ctx, sessionID, cmdType, cmdID, err)
	}
	trace.Mark("runtimeAcquired", nil)

	dispatchInput := CloneMap(input)
	if dispatchInput == nil {
		dispatchInput = map[string]any{}
	}
	dispatchInput["sessionId"] = sessionID
	dispatchInput["trace"] = trace

	result, err := actor.Dispatch(ctx, dispatchInput)
	if err != nil {
		trace.Finish(map[string]any{"status": "failed", "errorCode": errCodeOf(err, "chat_command_failed")})
		return nil, s.wrapBranchError(ctx, sessionID, cmdType, cmdID, err)
	}

	s.syncModelCapabilities(ctx, sess, cmdType)
	isDup, _ := result["duplicate"].(bool)
	if isDup || !trace.IsRunBound() {
		status := "completed"
		if isDup {
			status = "duplicate"
		}
		trace.Finish(map[string]any{"status": status})
	}
	out := CloneMap(result)
	if out == nil {
		out = map[string]any{}
	}
	out["sessionId"] = sessionID
	return out, nil
}

func (s *Service) wrapBranchError(ctx context.Context, sessionID, cmdType, cmdID string, err error) error {
	if cmdType != "session.fork" && cmdType != "turn.regenerate" {
		return err
	}
	var ce *Error
	code := "chat_branch_failed"
	status := http.StatusInternalServerError
	details := map[string]any{}
	if errors.As(err, &ce) {
		if ce.Code != "" {
			code = ce.Code
		}
		if ce.StatusCode > 0 {
			status = ce.StatusCode
		}
		if ce.Details != nil {
			details = CloneMap(ce.Details)
		}
	}
	op, _ := s.store.BranchOperations.Read(ctx, sessionID, cmdID)
	accepted, _ := s.publisher.GetCommand(ctx, cmdID)
	disp := "new_command"
	if op != nil || (accepted != nil && (accepted.Status == "completed" || accepted.Status == "accepted")) {
		disp = "resume"
	}
	details["commandRecovery"] = map[string]any{
		"commandId":   cmdID,
		"disposition": disp,
	}
	wrapped := NewError(code, status, details)
	wrapped.Cause = err
	return wrapped
}

func (s *Service) branchChatSession(ctx context.Context, hctx CommandHandlerContext) (map[string]any, error) {
	sess, err := s.publisher.RequireSession(ctx, hctx.Command.SessionID)
	if err != nil {
		return nil, err
	}
	var child *Session
	if IsChatSession(sess) {
		child, err = s.publisher.BranchSession(ctx, hctx.Command)
		if err != nil {
			return nil, err
		}
	} else {
		child, err = s.branchWorkSession(ctx, hctx.Command, hctx.HistoryBranch)
		if err != nil {
			return nil, err
		}
	}
	if hctx.Command.Type == "turn.regenerate" {
		genCmdID := hctx.Command.CommandID + ":generate"
		existing, _ := s.publisher.GetCommand(ctx, genCmdID)
		if existing == nil {
			seed, serr := s.publisher.ReadHistorySeed(ctx, child.SessionID)
			if serr != nil {
				return nil, serr
			}
			var regenPayload map[string]any
			if seed != nil {
				regenPayload = seed.Regeneration
			}
			_, derr := s.DispatchCommand(ctx, child.SessionID, map[string]any{
				"commandId": genCmdID,
				"type":      "turn.submit",
				"payload":   regenPayload,
			})
			if derr != nil {
				return nil, derr
			}
		}
	}
	latest, err := s.publisher.GetSession(ctx, child.SessionID)
	if err != nil {
		return nil, err
	}
	return map[string]any{"session": latest}, nil
}

func (s *Service) branchWorkSession(ctx context.Context, cmd *Command, historyBranch HistoryBranchPort) (*Session, error) {
	if existing, err := s.store.WorkBranches.Existing(ctx, cmd); err == nil && existing != nil {
		return existing, nil
	}
	if historyBranch == nil {
		return nil, NewError("chat_branch_mode_unsupported", http.StatusUnprocessableEntity, nil)
	}
	op, _ := s.store.BranchOperations.Read(ctx, cmd.SessionID, cmd.CommandID)
	var plan map[string]any
	if op != nil && len(op.Plan) > 0 {
		plan = op.Plan
	} else {
		parent, err := s.publisher.RequireSession(ctx, cmd.SessionID)
		if err != nil {
			return nil, err
		}
		plan, err = historyBranch.Plan(ctx, parent, cmd)
		if err != nil {
			return nil, err
		}
	}
	if _, err := PrepareNativeBranch(ctx, s.store.BranchOperations, cmd, plan, historyBranch.Native()); err != nil {
		return nil, err
	}
	child, err := s.store.WorkBranches.Commit(ctx, cmd)
	if err != nil {
		return nil, err
	}
	_, _ = s.publisher.PublishSince(ctx, child.SessionID, 0)
	return child, nil
}

func (s *Service) syncModelCapabilities(ctx context.Context, previous *Session, cmdType string) {
	if previous == nil || (cmdType != "session.policy.set" && cmdType != "turn.submit") {
		return
	}
	sess, err := s.publisher.GetSession(ctx, previous.SessionID)
	if err != nil || sess == nil || !IsChatSession(sess) {
		return
	}
	if asString(previous.Policy["model"]) == asString(sess.Policy["model"]) {
		return
	}
	caps := s.actors.GetCapabilities(ctx, sess.SessionID)
	if len(caps) == 0 || SameCapabilitySnapshot(caps, sess.CapabilitySnapshot) {
		return
	}
	if _, err := s.publisher.UpdateCapabilitySnapshot(ctx, sess.SessionID, caps); err != nil {
		return
	}
	_, _ = s.publisher.AppendEvent(ctx, sess.SessionID, EventDraft{
		Type:   "session.runtime.rebound",
		Source: sessionEventSource(sess),
		Payload: map[string]any{
			"capabilitySnapshot": caps,
		},
	})
}

func (s *Service) checkpointBeforeTurn(ctx context.Context, sess *Session, commandID string) {
	if s.workspaceCheckpoints == nil || strings.TrimSpace(sess.ProjectPath) == "" {
		return
	}
	cp, err := s.workspaceCheckpoints(ctx, sess.ProjectPath)
	if err != nil || cp == nil {
		return
	}
	label := strings.TrimSpace("aih turn " + commandID)
	_, _ = cp.Snapshot(ctx, sess.SessionID, label)
}

// WorkspaceCheckpointAction 执行列表、差异查看或恢复检查点操作。
func (s *Service) WorkspaceCheckpointAction(ctx context.Context, sessionID, action, commit string) (any, error) {
	sess, err := s.publisher.RequireSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if s.workspaceCheckpoints == nil || strings.TrimSpace(sess.ProjectPath) == "" {
		return nil, NewError("workspace_checkpoints_unavailable", http.StatusConflict, nil)
	}
	cp, err := s.workspaceCheckpoints(ctx, sess.ProjectPath)
	if err != nil || cp == nil {
		return nil, NewError("workspace_checkpoints_unavailable", http.StatusConflict, nil)
	}
	switch action {
	case "list":
		return cp.List(ctx, sessionID)
	case "changes":
		return cp.Changes(ctx, commit)
	case "restore":
		if err := s.WaitForActorIdle(ctx, sessionID); err != nil {
			return nil, err
		}
		return cp.Restore(ctx, sessionID, commit)
	default:
		return nil, NewError("invalid_checkpoint_action", http.StatusBadRequest, nil)
	}
}

// GetCommandCatalog 返回当前会话可用指令清单。
func (s *Service) GetCommandCatalog(ctx context.Context, sessionID string) ([]CommandCatalogEntry, error) {
	sess, err := s.publisher.RequireSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	actor, err := s.actors.Acquire(ctx, sess, nil)
	if err != nil {
		return nil, err
	}
	projected := *sess
	if caps := s.actors.GetCapabilities(ctx, sessionID); len(caps) > 0 {
		projected.CapabilitySnapshot = caps
	}
	return s.catalog.List(ctx, &projected, actor.SupportsHistoryBranch()), nil
}

// GetSessionCapabilities 返回会话有效能力快照。
func (s *Service) GetSessionCapabilities(ctx context.Context, sessionID string) (map[string]any, error) {
	sess, err := s.publisher.RequireSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if caps := s.actors.GetCapabilities(ctx, sessionID); len(caps) > 0 {
		return caps, nil
	}
	if sess.CapabilitySnapshot != nil {
		return sess.CapabilitySnapshot, nil
	}
	return map[string]any{}, nil
}

// ReadComposerCatalog 读取（并短时缓存/去重）会话可用模型与推理强度目录。
func (s *Service) ReadComposerCatalog(ctx context.Context, sessionID string) (map[string]any, error) {
	if s.recovery != nil {
		if err := s.recovery.WaitForSession(ctx, sessionID); err != nil {
			return nil, err
		}
	}
	sess, err := s.publisher.RequireSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	s.composerMu.Lock()
	if cached, ok := s.composerCache[sessionID]; ok && time.Since(cached.updatedAt) < composerCatalogCacheTTL {
		s.composerMu.Unlock()
		return CloneMap(cached.value), nil
	}
	if flight, ok := s.composerTasks[sessionID]; ok {
		s.composerMu.Unlock()
		select {
		case <-flight.done:
			return CloneMap(flight.val), flight.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	flight := &composerFlight{done: make(chan struct{})}
	s.composerTasks[sessionID] = flight
	s.composerMu.Unlock()

	val, err := func() (map[string]any, error) {
		actor, aerr := s.actors.Acquire(ctx, sess, nil)
		if aerr != nil {
			return nil, aerr
		}
		cat, cerr := actor.ReadComposerCatalog(ctx)
		if cerr != nil {
			return nil, cerr
		}
		out := CloneMap(cat)
		if out == nil {
			out = map[string]any{}
		}
		out["sessionId"] = sess.SessionID
		return out, nil
	}()

	s.composerMu.Lock()
	if err == nil {
		s.composerCache[sessionID] = composerCacheEntry{updatedAt: time.Now(), value: val}
	}
	if s.composerTasks[sessionID] == flight {
		delete(s.composerTasks, sessionID)
	}
	flight.val = val
	flight.err = err
	close(flight.done)
	s.composerMu.Unlock()

	if err != nil {
		return nil, err
	}
	return CloneMap(val), nil
}

// PrewarmComposerCatalog 预热单条会话的模型目录缓存。
func (s *Service) PrewarmComposerCatalog(ctx context.Context, sessionID string) (map[string]any, error) {
	return s.ReadComposerCatalog(ctx, sessionID)
}

// ScheduleSessionPrewarm 异步触发单条会话的目录或运行时预热，并在 Service.Close 时等待收尾。
func (s *Service) ScheduleSessionPrewarm(session *Session) {
	if s == nil || session == nil || strings.TrimSpace(session.SessionID) == "" || s.prewarmCtx == nil {
		return
	}
	if s.prewarmCtx.Err() != nil {
		return
	}
	copied := *session
	s.prewarmWG.Add(1)
	go func() {
		defer s.prewarmWG.Done()
		ctx, cancel := context.WithTimeout(s.prewarmCtx, 5*time.Second)
		defer cancel()
		if IsChatSession(&copied) {
			_, _ = s.PrewarmComposerCatalog(ctx, copied.SessionID)
			return
		}
		_, _ = s.DispatchCommand(ctx, copied.SessionID, map[string]any{
			"commandId": "runtime-prewarm:" + strings.TrimPrefix(s.store.NewID("prewarm"), "prewarm-"),
			"type":      "runtime.prewarm",
			"payload":   map[string]any{},
		})
	}()
}

// PrewarmRecentComposerCatalogs 并行预热最近纯聊天会话的 Composer 目录。
func (s *Service) PrewarmRecentComposerCatalogs(ctx context.Context, limit int) {
	if limit <= 0 {
		limit = 8
	}
	if limit > 32 {
		limit = 32
	}
	sessions, err := s.publisher.ListSessions(ctx, ListSessionsFilter{ChatOnly: true, Limit: limit})
	if err != nil || len(sessions) == 0 {
		return
	}
	for i := 0; i < len(sessions); i += 2 {
		end := i + 2
		if end > len(sessions) {
			end = len(sessions)
		}
		var wg sync.WaitGroup
		for _, sess := range sessions[i:end] {
			sid := sess.SessionID
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, _ = s.PrewarmComposerCatalog(ctx, sid)
			}()
		}
		wg.Wait()
	}
}

// ReadArtifact 按 ID 读取对话产物（如不支持则返回 nil, nil）。
func (s *Service) ReadArtifact(ctx context.Context, artifactID string) (*Artifact, error) {
	if s.artifactReader == nil {
		return nil, nil
	}
	return s.artifactReader.Read(ctx, strings.TrimSpace(artifactID))
}

func (s *Service) observePublishedEvent(ev EventEnvelope) {
	evMap := structToMap(ev)
	s.extensions.Observe(evMap, ExtensionContext{SessionID: ev.SessionID, Source: "runtime"})
	s.traceLifecycle.ObservePublishedEvent(ev)
	if s.queueAutomation != nil {
		s.queueAutomation.Observe(ev)
	}
}

// Close 停止队列自动化、释放全部常驻 Actor 与可选内部资源。
func (s *Service) Close() error {
	if s.prewarmCancel != nil {
		s.prewarmCancel()
	}
	s.prewarmWG.Wait()
	if s.queueAutomation != nil {
		s.queueAutomation.Close()
	}
	if s.actors != nil {
		s.actors.Close()
	}
	s.closeRunsControl()
	s.composerMu.Lock()
	s.composerCache = map[string]composerCacheEntry{}
	s.composerTasks = map[string]*composerFlight{}
	s.composerMu.Unlock()
	if s.extensions != nil {
		s.extensions.Close()
	}
	if s.traceLifecycle != nil {
		s.traceLifecycle.Close()
	}
	if s.ownsCodexPool && s.codexPool != nil {
		_ = s.codexPool.Close()
	}
	if s.ownsStore && s.store != nil {
		return s.store.Close()
	}
	return nil
}

type defaultRuntimeResolver struct {
	aiHomeDir   string
	hostHomeDir string
	codexBinary string
}

func (r *defaultRuntimeResolver) Resolve(_ context.Context, provider string, opts RuntimeResolveOptions) (RuntimeDescriptor, error) {
	prov := sessionchat.NormalizeProvider(provider)
	scope := strings.TrimSpace(opts.RuntimeScope)
	if scope == "" {
		scope = "default"
	}
	fp := prov + ":" + scope
	if prov == "codex" && !IsGatewayRuntimeScope(scope) {
		bin := r.codexBinary
		if bin == "" {
			if resolved, err := providercli.ResolveBinary("codex", ""); err == nil {
				bin = resolved
			}
		}
		if bin != "" {
			if info, err := os.Stat(bin); err == nil {
				fp = fmt.Sprintf("codex:%s:%d:%d", scope, info.Size(), info.ModTime().UnixMilli())
			}
		}
	} else if !opts.Chat && !IsGatewayRuntimeScope(scope) {
		if resolved, err := providercli.ResolveBinary(prov, ""); err == nil {
			if info, err := os.Stat(resolved); err == nil {
				fp = fmt.Sprintf("%s:%s:%d:%d", prov, scope, info.Size(), info.ModTime().UnixMilli())
			}
		}
	}
	return RuntimeDescriptor{
		Provider:     prov,
		RuntimeScope: scope,
		Fingerprint:  fp,
		Version:      "go-v1",
	}, nil
}

type defaultDriverRegistry struct {
	svc *Service
}

func (r *defaultDriverRegistry) Resolve(ctx context.Context, provider string, opts DriverResolveOptions) (*DriverEntry, error) {
	sess := opts.Session
	rt := opts.Runtime
	prov := sessionchat.NormalizeProvider(provider)
	if sess == nil {
		return nil, NewError("chat_driver_session_required", http.StatusUnprocessableEntity, nil)
	}
	if IsChatSession(sess) {
		return r.resolveChatDriver(ctx, sess, rt)
	}
	if prov == "codex" {
		return r.resolveCodexEntry(ctx, sess, rt)
	}
	return r.resolveNativeEntry(sess, rt)
}

func (r *defaultDriverRegistry) resolveChatDriver(_ context.Context, sess *Session, rt RuntimeDescriptor) (*DriverEntry, error) {
	s := r.svc
	codexSession := *sess
	codexSession.Provider = "codex"
	composerCatalogFn := func(ctx context.Context) (map[string]any, error) {
		cat, err := s.modelResolver.ReadComposerCatalog(ctx, &codexSession)
		if err != nil {
			return nil, err
		}
		return map[string]any{
			"models":       cat.Models,
			"defaultModel": cat.DefaultModel,
		}, nil
	}
	return CreateCapabilityRoutedChatDriverEntry(CapabilityRoutedDriverOptions{
		Session:         &codexSession,
		Store:           s.publisher,
		Catalog:         s.modelResolver,
		CanonicalCaps:   CodexCapabilities(rt),
		ComposerCatalog: composerCatalogFn,
		Diagnostics:     s.opts.Diagnostics,
		CreateGoEntry: func(_ context.Context) (*DriverEntry, error) {
			return CreateGoChatDriverEntry(GoChatDriverOptions{
				Session:         &codexSession,
				Store:           s.publisher,
				Streamer:        s.opts.ChatStreamer,
				ComposerCatalog: composerCatalogFn,
			})
		},
		CreateNodeEntry: func(ctx context.Context) (*DriverEntry, error) {
			workDir, err := ChatWorkingDirectory(s.opts.AIHomeDir, sess.SessionID)
			if err != nil {
				workDir = s.opts.AIHomeDir
			}
			fallbackSess := codexSession
			fallbackSess.ProjectPath = workDir
			entry, err := r.resolveCodexEntry(ctx, &fallbackSess, rt)
			if err != nil {
				return nil, err
			}
			wrapped := WithRuntimePrewarmLifecycle(*entry)
			return &wrapped, nil
		},
	})
}

func (r *defaultDriverRegistry) resolveCodexEntry(ctx context.Context, sess *Session, rt RuntimeDescriptor) (*DriverEntry, error) {
	s := r.svc
	opts := CodexDriverOptions{
		Session:            sess,
		Runtime:            rt,
		Client:             s.opts.CodexRPCClient,
		Pool:               s.codexPool,
		Store:              s.publisher,
		ModelCatalog:       s.modelResolver,
		AIHomeDir:          s.opts.AIHomeDir,
		HostHomeDir:        s.opts.HostHomeDir,
		ExecutablePath:     s.opts.CodexExecutablePath,
		IsModelEnabled:     s.opts.IsModelEnabled,
		ReleaseFailureSink: s.opts.ReleaseFailureSink,
		RemoteTools:        s.opts.RemoteTools,
	}
	var entry *DriverEntry
	var err error
	if s.opts.CodexDriverFactory != nil {
		entry, err = s.opts.CodexDriverFactory(ctx, opts)
	} else {
		entry, err = CreateCodexDriverEntry(opts)
	}
	if err != nil {
		return nil, err
	}
	wrapped := WithRuntimePrewarmLifecycle(*entry)
	return &wrapped, nil
}

func (r *defaultDriverRegistry) resolveNativeEntry(sess *Session, rt RuntimeDescriptor) (*DriverEntry, error) {
	s := r.svc
	entry, err := CreateNativeSessionDriverEntry(NativeDriverOptions{
		Session:                 sess,
		Runtime:                 rt,
		Store:                   s.publisher,
		AIHomeDir:               s.opts.AIHomeDir,
		HostHomeDir:             s.opts.HostHomeDir,
		ApprovalCallbackURL:     s.opts.ApprovalCallbackURL,
		Runner:                  s.opts.NativeRunner,
		ResolveFallbackAccounts: s.opts.ResolveFallbackAccounts,
		ReadModels:              s.opts.ReadProviderModels,
		ResolveDefaultModel:     s.opts.ResolveDefaultModel,
		GetAdoptedRun:           s.opts.GetAdoptedNativeRun,
		OnRunRegistered:         s.RegisterActiveRun,
		OnRunUnregistered:       s.UnregisterActiveRun,
		OnSurfaceCreated:        s.RegisterApprovalSurface,
		OnSurfaceDisposed:       s.UnregisterApprovalSurface,
		OnSurfaceRunBound:       s.BindApprovalSurfaceRun,
		OnSurfaceRunUnbound:     s.UnbindApprovalSurfaceRun,
	})
	if err != nil {
		return nil, err
	}
	wrapped := WithRuntimePrewarmLifecycle(*entry)
	return &wrapped, nil
}

func retainedFirstSeq(firstSeq, throughSeq int64, limit int) int64 {
	if throughSeq == 0 {
		return 1
	}
	if firstSeq <= 0 {
		firstSeq = 1
	}
	cand := throughSeq - int64(limit) + 1
	if cand > firstSeq {
		return cand
	}
	return firstSeq
}

func isContiguousFrom(after int64, events []EventEnvelope) bool {
	expected := after + 1
	for _, ev := range events {
		if ev.Seq != expected {
			return false
		}
		expected++
	}
	return true
}

func errCodeOf(err error, fallback string) string {
	var ce *Error
	if errors.As(err, &ce) && ce.Code != "" {
		return ce.Code
	}
	return fallback
}
