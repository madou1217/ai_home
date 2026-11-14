package chatruntime

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	// InitialTimelineItemLimit 是首屏默认加载的时间线条目数量。
	InitialTimelineItemLimit = 30

	// InitialTimelineMinMessages 是首屏自动向前补页的最低对话消息条数。
	InitialTimelineMinMessages = 12

	// InitialTimelineItemCeiling 是首屏补页的最大条目上限。
	InitialTimelineItemCeiling = 200

	// TimelineHistoryCompactionMarker 标记历史导入事件一次性整理已完成。
	TimelineHistoryCompactionMarker = "chat_runtime.timeline_history_compaction.v1"

	defaultCompactionDelay = 60 * time.Second
)

// StoreOptions 配置 Store 打开行为与后台维护任务。
type StoreOptions struct {
	DBPath                  string
	Clock                   func() int64
	IDFactory               func(prefix string) string
	EnableHistoryCompaction bool
	HistoryCompactionDelay  time.Duration
}

// QueueStepInput 描述单轮启动或结算时附带的队列交接。
type QueueStepInput struct {
	QueueID string
	LeaseID string
	Outcome string
	Result  map[string]any
}

// BeginTurnInput 描述 turn 开始时的事务更新载荷。
type BeginTurnInput struct {
	ResumeQueue bool
	Policy      map[string]any
	ActiveTurn  *ActiveTurn
	Event       EventDraft
	Queue       *QueueStepInput
}

// TurnTransitionResult 描述 turn 开始/推进/结算事务返回。
type TurnTransitionResult struct {
	Event   EventEnvelope `json:"event"`
	Queue   *QueueEntry   `json:"queue,omitempty"`
	Session *Session      `json:"session"`
}

// SettleTurnInput 描述 turn 终态结算载荷。
type SettleTurnInput struct {
	Event EventDraft
	Queue *QueueStepInput
}

// GoalUpdateResult 描述设置/清空目标后的状态。
type GoalUpdateResult struct {
	Goal    map[string]any `json:"goal"`
	Event   EventEnvelope  `json:"event"`
	Session *Session       `json:"session"`
}

// HistoryCompactionStats 统计一次性历史压缩执行情况。
type HistoryCompactionStats struct {
	Skipped       bool  `json:"skipped"`
	Sessions      int   `json:"sessions"`
	RowsCompacted int   `json:"rowsCompacted"`
	RowsMerged    int   `json:"rowsMerged"`
	PrewarmPruned int64 `json:"prewarmPruned"`
	BytesSaved    int64 `json:"bytesSaved"`
}

// Store 聚合 Chat Runtime 在 app-state.db 上的全量持久化仓库与协调操作。
type Store struct {
	db                  *Database
	clock               func() int64
	idFactory           func(string) string
	Events              *EventRepository
	Sessions            *SessionRepository
	NativeResponseItems *NativeResponseItemRepository
	Attachments         *AttachmentRepository
	Commands            *CommandRepository
	FailedTurns         *FailedTurnRepository
	Queue               *QueueRepository
	Interactions        *InteractionRepository
	Recovery            *RecoveryRepository
	TimelineImports     *TimelineImportRepository
	Branches            *SessionBranchRepository
	BranchOperations    *BranchOperationRepository
	WorkBranches        *WorkBranchRepository
	NativeThreadItems   *NativeThreadItemRepository

	compactCancel context.CancelFunc
	compactWG     sync.WaitGroup
}

// OpenStore 使用默认时钟和 ID 生成器打开 Chat Runtime 存储。
func OpenStore(ctx context.Context, dbPath string) (*Store, error) {
	return OpenStoreWithOptions(ctx, StoreOptions{
		DBPath:                  dbPath,
		EnableHistoryCompaction: true,
	})
}

// OpenStoreWithOptions 使用定制配置打开 Chat Runtime 存储并可选启动后台压缩。
func OpenStoreWithOptions(ctx context.Context, opts StoreOptions) (*Store, error) {
	clock := opts.Clock
	if clock == nil {
		clock = func() int64 { return time.Now().UnixMilli() }
	}
	idFactory := opts.IDFactory
	if idFactory == nil {
		idFactory = DefaultIDFactory
	}
	db, err := OpenDatabase(ctx, opts.DBPath, clock)
	if err != nil {
		return nil, err
	}
	events := newEventRepository(db, idFactory)
	sessions := newSessionRepository(db, events, idFactory)
	nativeResp := newNativeResponseItemRepository(db, sessions)
	store := &Store{
		db:                  db,
		clock:               clock,
		idFactory:           idFactory,
		Events:              events,
		Sessions:            sessions,
		NativeResponseItems: nativeResp,
		Attachments:         newAttachmentRepository(db, sessions, idFactory),
		Commands:            newCommandRepository(db),
		FailedTurns:         newFailedTurnRepository(db),
		Queue:               newQueueRepository(db, events, idFactory),
		Interactions:        newInteractionRepository(db, events, idFactory),
		Recovery:            newRecoveryRepository(db, events, sessions),
		TimelineImports:     newTimelineImportRepository(db, events),
		NativeThreadItems:   newNativeThreadItemRepository(db, nativeResp),
	}
	store.Branches = newSessionBranchRepository(store)
	store.BranchOperations = newBranchOperationRepository(store)
	store.WorkBranches = newWorkBranchRepository(store)

	if opts.EnableHistoryCompaction {
		delay := opts.HistoryCompactionDelay
		if delay <= 0 {
			delay = defaultCompactionDelay
		}
		store.scheduleHistoryCompaction(delay)
	}
	return store, nil
}

// DefaultIDFactory 生成带前缀的 UUID 样式唯一标识。
func DefaultIDFactory(prefix string) string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	uuid := fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(b[0:4]),
		hex.EncodeToString(b[4:6]),
		hex.EncodeToString(b[6:8]),
		hex.EncodeToString(b[8:10]),
		hex.EncodeToString(b[10:16]),
	)
	if strings.TrimSpace(prefix) == "" {
		return uuid
	}
	return prefix + "-" + uuid
}

// Close 取消后台任务并关闭 SQLite 连接。
func (s *Store) Close() error {
	if s == nil {
		return nil
	}
	if s.compactCancel != nil {
		s.compactCancel()
	}
	s.compactWG.Wait()
	if s.db != nil {
		return s.db.Close()
	}
	return nil
}

func (s *Store) Database() *Database {
	return s.db
}

func (s *Store) Clock() int64 {
	return s.clock()
}

func (s *Store) NewID(prefix string) string {
	return s.idFactory(prefix)
}

func (s *Store) CreateSession(ctx context.Context, in CreateSessionInput) (*Session, error) {
	return s.Sessions.Create(ctx, in)
}

func (s *Store) ResolveSession(ctx context.Context, in CreateSessionInput) (*ResolveSessionResult, error) {
	return s.Sessions.Resolve(ctx, in)
}

func (s *Store) FindSessionByNativeIdentity(ctx context.Context, provider, nativeSessionID string) (*Session, error) {
	return s.Sessions.FindByNativeIdentity(ctx, provider, nativeSessionID)
}

func (s *Store) GetSession(ctx context.Context, sessionID string) (*Session, error) {
	return s.Sessions.Get(ctx, sessionID)
}

func (s *Store) RequireSession(ctx context.Context, sessionID string) (*Session, error) {
	return s.Sessions.Require(ctx, sessionID)
}

func (s *Store) DeleteSession(ctx context.Context, sessionID string) (*Session, error) {
	deleted, attPaths, err := s.Sessions.Delete(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	cleanupPersistedAttachments(attPaths)
	return deleted, nil
}

func (s *Store) ListSessions(ctx context.Context, filter ListSessionsFilter) ([]Session, error) {
	return s.Sessions.List(ctx, filter)
}

func (s *Store) UpdateRuntimeBinding(ctx context.Context, sessionID string, patch map[string]any, replacement *NativeThreadReplacement) (*Session, error) {
	return s.Sessions.UpdateRuntimeBinding(ctx, sessionID, patch, replacement)
}

func (s *Store) UpdateExecutionContext(ctx context.Context, sessionID, execAccountRef string, runtimeBinding, capSnapshot map[string]any) (*Session, error) {
	return s.Sessions.UpdateExecutionContext(ctx, sessionID, execAccountRef, runtimeBinding, capSnapshot)
}

func (s *Store) UpdateCapabilitySnapshot(ctx context.Context, sessionID string, caps map[string]any) (*Session, error) {
	return s.Sessions.UpdateCapabilitySnapshot(ctx, sessionID, caps)
}

func (s *Store) UpdatePolicy(ctx context.Context, sessionID string, patch map[string]any) (*Session, error) {
	return s.Sessions.UpdatePolicy(ctx, sessionID, patch)
}

func (s *Store) SetSessionState(ctx context.Context, sessionID, state string, activeTurn *ActiveTurn) (*Session, error) {
	return s.Sessions.UpdateState(ctx, sessionID, state, activeTurn)
}

func (s *Store) UpdateActiveTurnAnchor(ctx context.Context, sessionID, runID, nativeTurnID, clientUserMsgID string) (*Session, error) {
	return s.Sessions.UpdateActiveTurnAnchor(ctx, sessionID, runID, nativeTurnID, clientUserMsgID)
}

func (s *Store) SetGoal(ctx context.Context, sessionID string, goal map[string]any, source string) (*GoalUpdateResult, error) {
	var out *GoalUpdateResult
	err := s.db.withTx(ctx, func(tx *sql.Tx) error {
		session, err := s.Sessions.requireTx(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		ctxState := CloneMap(mapOrNil(session.Policy["contextState"]))
		ctxState["goal"] = CloneMap(goal)
		if strings.TrimSpace(source) != "" {
			ctxState["goalSource"] = strings.TrimSpace(source)
		}
		if _, err := s.Sessions.updatePolicyInTx(ctx, tx, sessionID, map[string]any{"contextState": ctxState}); err != nil {
			return err
		}
		payload := map[string]any{"goal": CloneMap(goal)}
		if strings.TrimSpace(source) != "" {
			payload["goalSource"] = strings.TrimSpace(source)
		}
		ev, err := s.Events.appendInTx(ctx, tx, sessionID, EventDraft{
			Type:    "session.goal.updated",
			Source:  runtimeEventSource(session.Provider, session.RuntimeBinding),
			Payload: payload,
		}, true, nil)
		if err != nil {
			return err
		}
		updated, err := s.Sessions.requireTx(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		out = &GoalUpdateResult{Goal: CloneMap(goal), Event: ev, Session: updated}
		return nil
	})
	return out, err
}

func (s *Store) ClearGoal(ctx context.Context, sessionID string) (*GoalUpdateResult, error) {
	var out *GoalUpdateResult
	err := s.db.withTx(ctx, func(tx *sql.Tx) error {
		session, err := s.Sessions.requireTx(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		ctxState := CloneMap(mapOrNil(session.Policy["contextState"]))
		var goalID string
		if prevGoal, ok := ctxState["goal"].(map[string]any); ok {
			goalID = strings.TrimSpace(asString(prevGoal["threadId"]))
		}
		delete(ctxState, "goal")
		delete(ctxState, "goalSource")
		if _, err := s.Sessions.updatePolicyInTx(ctx, tx, sessionID, map[string]any{"contextState": ctxState}); err != nil {
			return err
		}
		payload := map[string]any{}
		if goalID != "" {
			payload["goalId"] = goalID
		}
		ev, err := s.Events.appendInTx(ctx, tx, sessionID, EventDraft{
			Type:    "session.goal.cleared",
			Source:  runtimeEventSource(session.Provider, session.RuntimeBinding),
			Payload: payload,
		}, true, nil)
		if err != nil {
			return err
		}
		updated, err := s.Sessions.requireTx(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		out = &GoalUpdateResult{Goal: nil, Event: ev, Session: updated}
		return nil
	})
	return out, err
}

func (s *Store) BeginTurn(ctx context.Context, sessionID string, in BeginTurnInput) (*TurnTransitionResult, error) {
	var out *TurnTransitionResult
	err := s.db.withTx(ctx, func(tx *sql.Tx) error {
		if in.ResumeQueue {
			sess, err := s.Sessions.requireTx(ctx, tx, sessionID)
			if err != nil {
				return err
			}
			if ctrl, ok := sess.Policy["queueControl"].(map[string]any); ok && ctrl["paused"] == true {
				nextCtrl := CloneMap(ctrl)
				nextCtrl["paused"] = false
				if _, err := s.Sessions.updatePolicyInTx(ctx, tx, sessionID, map[string]any{"queueControl": nextCtrl}); err != nil {
					return err
				}
			}
		}
		if len(in.Policy) > 0 {
			if _, err := s.Sessions.updatePolicyInTx(ctx, tx, sessionID, in.Policy); err != nil {
				return err
			}
		}
		if err := s.Sessions.updateStateTx(ctx, tx, sessionID, "starting", in.ActiveTurn); err != nil {
			return err
		}
		ev, err := s.Events.appendInTx(ctx, tx, sessionID, in.Event, true, nil)
		if err != nil {
			return err
		}
		var qEntry *QueueEntry
		if in.Queue != nil {
			qEntry, err = s.Queue.markRunningInTx(ctx, tx, in.Queue.QueueID, in.Queue.LeaseID)
			if err != nil {
				return err
			}
		}
		updated, err := s.Sessions.requireTx(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		out = &TurnTransitionResult{Event: ev, Queue: qEntry, Session: updated}
		return nil
	})
	return out, err
}

func (s *Store) TransitionTurnPhase(ctx context.Context, sessionID, state string, activeTurn *ActiveTurn, event EventDraft) (*TurnTransitionResult, error) {
	var out *TurnTransitionResult
	err := s.db.withTx(ctx, func(tx *sql.Tx) error {
		if err := s.Sessions.updateStateTx(ctx, tx, sessionID, state, activeTurn); err != nil {
			return err
		}
		ev, err := s.Events.appendInTx(ctx, tx, sessionID, event, true, nil)
		if err != nil {
			return err
		}
		updated, err := s.Sessions.requireTx(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		out = &TurnTransitionResult{Event: ev, Session: updated}
		return nil
	})
	return out, err
}

func (s *Store) SettleTurn(ctx context.Context, sessionID string, in SettleTurnInput) (*TurnTransitionResult, error) {
	var out *TurnTransitionResult
	err := s.db.withTx(ctx, func(tx *sql.Tx) error {
		if err := s.Events.turnMetrics.finishInTx(ctx, tx, sessionID, in.Event); err != nil {
			return err
		}
		outcomeUnknown, err := settleTurnTimelineTx(ctx, tx, s.Events, s.db, sessionID, in.Event)
		if err != nil {
			return err
		}
		if err := s.Sessions.updateStateTx(ctx, tx, sessionID, "idle", nil); err != nil {
			return err
		}
		sess, err := s.Sessions.requireTx(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		wasPaused := false
		if ctrl, ok := sess.Policy["queueControl"].(map[string]any); ok {
			wasPaused = ctrl["paused"] == true
		}
		reason := "completed"
		if outcomeUnknown {
			reason = "tool_outcome_unknown"
		} else if in.Event.Type == "turn.interrupted" {
			reason = "user_stop"
		} else if in.Event.Type == "turn.failed" {
			reason = "turn_failed"
		}
		nextQueueCtrl := map[string]any{
			"paused":    wasPaused || outcomeUnknown || in.Event.Type != "turn.completed",
			"lastRunId": in.Event.RunID,
			"reason":    reason,
		}
		if _, err := s.Sessions.updatePolicyInTx(ctx, tx, sessionID, map[string]any{"queueControl": nextQueueCtrl}); err != nil {
			return err
		}
		if _, err := s.Recovery.expirePendingInTx(ctx, tx, sessionID, "turn_terminal"); err != nil {
			return err
		}
		var qEntry *QueueEntry
		if in.Queue != nil {
			qEntry, err = s.Queue.settleInTx(ctx, tx, in.Queue.QueueID, in.Queue.LeaseID, in.Queue.Outcome, in.Queue.Result)
			if err != nil {
				return err
			}
		}
		draft := in.Event
		if outcomeUnknown && draft.Type == "turn.failed" {
			p := CloneMap(draft.Payload)
			p["retryable"] = false
			p["outcomeUnknown"] = true
			draft.Payload = p
		}
		ev, err := s.Events.appendInTx(ctx, tx, sessionID, draft, true, nil)
		if err != nil {
			return err
		}
		updated, err := s.Sessions.requireTx(ctx, tx, sessionID)
		if err != nil {
			return err
		}
		out = &TurnTransitionResult{Event: ev, Queue: qEntry, Session: updated}
		return nil
	})
	return out, err
}

func (s *Store) AcceptCommand(ctx context.Context, input map[string]any) (*AcceptCommandResult, error) {
	return s.Commands.Accept(ctx, input)
}

func (s *Store) GetCommand(ctx context.Context, commandID string) (*Command, error) {
	return s.Commands.Get(ctx, commandID)
}

func (s *Store) GetRetrySubmission(ctx context.Context, sessionID, sourceTurnID string) (*Command, error) {
	return s.FailedTurns.RequireSubmission(ctx, sessionID, sourceTurnID)
}

func (s *Store) CompleteCommand(ctx context.Context, commandID, status string, result map[string]any) (*Command, error) {
	return s.Commands.Complete(ctx, commandID, status, result)
}

func (s *Store) AppendEvent(ctx context.Context, sessionID string, draft EventDraft) (EventEnvelope, error) {
	return s.Events.Append(ctx, sessionID, draft)
}

func (s *Store) ImportTimeline(ctx context.Context, sessionID string, drafts []EventDraft) (*ImportResult, error) {
	return s.TimelineImports.Import(ctx, sessionID, drafts)
}

func (s *Store) ListEvents(ctx context.Context, sessionID string, after int64, through *int64, limit int) ([]EventEnvelope, error) {
	return s.Events.List(ctx, sessionID, after, through, limit)
}

func (s *Store) GetEventBounds(ctx context.Context, sessionID string) (EventBounds, error) {
	if _, err := s.Sessions.Require(ctx, sessionID); err != nil {
		return EventBounds{}, err
	}
	return s.Events.GetBounds(ctx, sessionID)
}

func (s *Store) CreateAttachments(ctx context.Context, sessionID string, inputs []AttachmentInput) ([]Attachment, error) {
	return s.Attachments.CreateMany(ctx, sessionID, inputs)
}

func (s *Store) ResolveAttachmentPaths(ctx context.Context, sessionID string, attachmentIDs []string) ([]string, error) {
	return s.Attachments.ResolvePaths(ctx, sessionID, attachmentIDs)
}

func (s *Store) Enqueue(ctx context.Context, sessionID string, input EnqueueInput) (*QueueEntry, error) {
	return s.Queue.Enqueue(ctx, sessionID, input)
}

func (s *Store) EditQueueItem(ctx context.Context, queueID string, patch map[string]any) (*QueueEntry, error) {
	return s.Queue.Edit(ctx, queueID, patch)
}

func (s *Store) RemoveQueueItem(ctx context.Context, queueID string) (*QueueEntry, error) {
	return s.Queue.Remove(ctx, queueID)
}

func (s *Store) MoveQueueItem(ctx context.Context, queueID, beforeQueueID string) (*QueueEntry, error) {
	return s.Queue.Move(ctx, queueID, beforeQueueID)
}

func (s *Store) LeaseQueueItem(ctx context.Context, sessionID string, input LeaseQueueInput) (*QueueEntry, error) {
	return s.Queue.Lease(ctx, sessionID, input)
}

func (s *Store) LeaseNextQueueItem(ctx context.Context, sessionID string, input LeaseQueueInput) (*QueueEntry, error) {
	return s.Queue.LeaseNext(ctx, sessionID, input)
}

func (s *Store) MarkQueueRunning(ctx context.Context, queueID, leaseID string) (*QueueEntry, error) {
	return s.Queue.MarkRunning(ctx, queueID, leaseID)
}

func (s *Store) SettleQueueItem(ctx context.Context, queueID, leaseID, outcome string, result map[string]any) (*QueueEntry, error) {
	return s.Queue.Settle(ctx, queueID, leaseID, outcome, result)
}

func (s *Store) ListQueue(ctx context.Context, sessionID string, activeOnly bool) ([]QueueEntry, error) {
	return s.Queue.List(ctx, sessionID, activeOnly)
}

func (s *Store) CreateInteraction(ctx context.Context, input CreateInteractionInput) (*Interaction, error) {
	return s.Interactions.Create(ctx, input)
}

func (s *Store) ValidateInteraction(ctx context.Context, interactionID string, input ResolveInteractionInput) (*Interaction, error) {
	return s.Interactions.Validate(ctx, interactionID, input)
}

func (s *Store) ResolveInteraction(ctx context.Context, interactionID string, input ResolveInteractionInput) (*Interaction, error) {
	return s.Interactions.Resolve(ctx, interactionID, input)
}

func (s *Store) ClaimInteractionResolution(ctx context.Context, interactionID string, input ResolveInteractionInput) (*Interaction, error) {
	return s.Interactions.ClaimResolution(ctx, interactionID, input)
}

func (s *Store) FinishInteractionResolution(ctx context.Context, claim *Interaction) (*Interaction, error) {
	return s.Interactions.FinishResolution(ctx, claim)
}

func (s *Store) ReleaseInteractionResolution(ctx context.Context, claim *Interaction) (*Interaction, error) {
	return s.Interactions.ReleaseResolution(ctx, claim)
}

func (s *Store) AcknowledgeExternalInteraction(ctx context.Context, interactionID string) (*Interaction, error) {
	return s.Interactions.AcknowledgeExternal(ctx, interactionID)
}

// ExpireInteraction 将挂起交互标记为已过期并记录过期事件。
func (s *Store) ExpireInteraction(ctx context.Context, interactionID, reason string) (*Interaction, error) {
	return s.Interactions.Expire(ctx, interactionID, reason)
}

func (s *Store) ListRecoveryCandidates(ctx context.Context) ([]Session, error) {
	return s.Recovery.ListCandidates(ctx)
}

func (s *Store) BeginRestartRecovery(ctx context.Context, sessionID string) (*RecoveryState, error) {
	return s.Recovery.Begin(ctx, sessionID)
}

func (s *Store) CompleteRestartRecovery(ctx context.Context, sessionID string, input CompleteRecoveryInput) (*RecoveryState, error) {
	return s.Recovery.Complete(ctx, sessionID, input)
}

func (s *Store) FailRestartRecovery(ctx context.Context, sessionID string, errInput any) (*Session, error) {
	return s.Recovery.Fail(ctx, sessionID, errInput)
}

func (s *Store) ReadRestartRecovery(ctx context.Context, sessionID string) (*RecoveryState, error) {
	return s.Recovery.Describe(ctx, sessionID, true)
}

func (s *Store) BranchSession(ctx context.Context, cmd *Command) (*Session, error) {
	return s.Branches.Create(ctx, cmd)
}

func (s *Store) ReadHistorySeed(ctx context.Context, sessionID string) (*HistorySeed, error) {
	return s.Branches.Read(ctx, sessionID)
}

func (s *Store) RecordNativeResponseItem(ctx context.Context, sessionID string, ev NativeResponseItemEvidence) error {
	return s.NativeResponseItems.Record(ctx, sessionID, ev)
}

func (s *Store) ReadNativeResponseItem(ctx context.Context, sessionID, itemID string) (map[string]any, error) {
	return s.NativeResponseItems.Read(ctx, sessionID, itemID)
}

func (s *Store) MarkNativeHistoryCoverage(ctx context.Context, sessionID string, ev NativeHistoryBoundaryEvidence) (string, error) {
	return s.NativeResponseItems.MarkCoverage(ctx, sessionID, ev)
}

// ReadTimeline 分页查询指定会话的时间线条目。
func (s *Store) ReadTimeline(ctx context.Context, sessionID, before string, limit int) (*TimelinePage, error) {
	session, err := s.Sessions.Require(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = InitialTimelineItemLimit
	} else if limit > 200 {
		limit = 200
	}
	// ReadTimelinePage 最大单页支持 100；>100 时分两次向前回补保持分页上限兼容。
	if limit <= 100 {
		events, hasMore, err := s.Events.ReadTimelinePage(ctx, sessionID, before, limit)
		if err != nil {
			return nil, err
		}
		items := ProjectTimeline(events)
		var nextBefore *string
		if hasMore && len(items) > 0 {
			id := items[0].ID
			nextBefore = &id
		}
		return &TimelinePage{
			SessionID:  sessionID,
			Items:      items,
			HasMore:    hasMore,
			NextBefore: nextBefore,
			ThroughSeq: session.LastEventSeq,
		}, nil
	}

	remaining := limit
	curBefore := before
	var combined []EventEnvelope
	var finalMore bool
	for remaining > 0 {
		batch := remaining
		if batch > 100 {
			batch = 100
		}
		events, hasMore, err := s.Events.ReadTimelinePage(ctx, sessionID, curBefore, batch)
		if err != nil {
			return nil, err
		}
		combined = append(events, combined...)
		finalMore = hasMore
		proj := ProjectTimeline(combined)
		if !hasMore || len(proj) == 0 {
			break
		}
		remaining -= batch
		curBefore = proj[0].ID
	}
	items := ProjectTimeline(combined)
	var nextBefore *string
	if finalMore && len(items) > 0 {
		id := items[0].ID
		nextBefore = &id
	}
	return &TimelinePage{
		SessionID:  sessionID,
		Items:      items,
		HasMore:    finalMore,
		NextBefore: nextBefore,
		ThroughSeq: session.LastEventSeq,
	}, nil
}

// ReadInitialTimeline 构建首屏时间线窗口，必要时按条向前补够最低对话消息数。
func (s *Store) ReadInitialTimeline(ctx context.Context, sessionID string) ([]TimelineItem, bool, error) {
	var events []EventEnvelope
	var hasMore bool
	before := ""
	for {
		pageEvents, pageMore, err := s.Events.ReadTimelinePage(ctx, sessionID, before, InitialTimelineItemLimit)
		if err != nil {
			return nil, false, err
		}
		events = append(pageEvents, events...)
		hasMore = pageMore
		timeline := ProjectTimeline(events)
		msgCount := 0
		for _, item := range timeline {
			if item.Kind == "message" {
				msgCount++
			}
		}
		if !hasMore || msgCount >= InitialTimelineMinMessages || len(timeline) >= InitialTimelineItemCeiling || len(timeline) == 0 {
			return timeline, hasMore, nil
		}
		before = timeline[0].ID
	}
}

// GetSnapshot 读取会话的权威完整快照（状态、队列、活跃交互、首屏时间线及最近失败轮次）。
func (s *Store) GetSnapshot(ctx context.Context, sessionID string) (*Snapshot, error) {
	session, err := s.Sessions.Require(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	timeline, hasMore, err := s.ReadInitialTimeline(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	queue, err := s.Queue.List(ctx, sessionID, true)
	if err != nil {
		return nil, err
	}
	interactions, err := s.Interactions.ListActive(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	failedTurn, err := s.FailedTurns.Get(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	var nextBefore *string
	if hasMore && len(timeline) > 0 {
		id := timeline[0].ID
		nextBefore = &id
	}
	snap := &Snapshot{
		SessionID:          sessionID,
		State:              session.State,
		ThroughSeq:         session.LastEventSeq,
		ActiveTurn:         CloneActiveTurn(session.ActiveTurn),
		FailedTurn:         failedTurn,
		Policy:             CloneMap(session.Policy),
		Queue:              queue,
		Interactions:       interactions,
		Timeline:           timeline,
		TimelineHasMore:    hasMore,
		TimelineNextBefore: nextBefore,
	}
	if len(session.RuntimeBinding) > 0 {
		snap.RuntimeBinding = CloneMap(session.RuntimeBinding)
	}
	if len(session.CapabilitySnapshot) > 0 {
		snap.CapabilitySnapshot = CloneMap(session.CapabilitySnapshot)
	}
	return normalizeSnapshot(snap), nil
}

func normalizeSnapshot(snap *Snapshot) *Snapshot {
	if snap.Queue == nil {
		snap.Queue = []QueueEntry{}
	}
	if snap.Interactions == nil {
		snap.Interactions = []Interaction{}
	}
	if snap.Timeline == nil {
		snap.Timeline = []TimelineItem{}
	}
	if snap.Policy == nil {
		snap.Policy = map[string]any{}
	}
	if _, err := ValidateSessionState(snap.State); err != nil {
		snap.State = "idle"
	}
	return snap
}

func (s *Store) scheduleHistoryCompaction(delay time.Duration) {
	bgCtx, cancel := context.WithCancel(context.Background())
	s.compactCancel = cancel
	s.compactWG.Add(1)
	go func() {
		defer s.compactWG.Done()
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-bgCtx.Done():
			return
		case <-timer.C:
		}
		_, _ = s.CompactStoredTimelineHistory(bgCtx)
	}()
}

// CompactStoredTimelineHistory 幂等压缩历史导入时间线事件并清理过期预热事件。
func (s *Store) CompactStoredTimelineHistory(ctx context.Context) (HistoryCompactionStats, error) {
	stats := HistoryCompactionStats{}
	done := false
	err := s.db.withRead(ctx, func(db *sql.DB) error {
		var marker string
		err := db.QueryRowContext(ctx, `SELECT value FROM app_kv WHERE key = ?`, TimelineHistoryCompactionMarker).Scan(&marker)
		if err == nil {
			done = true
			return nil
		}
		if err == sql.ErrNoRows || strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return nil
		}
		return err
	})
	if err != nil {
		return stats, err
	}
	if done {
		stats.Skipped = true
		return stats, nil
	}

	var sessionIDs []string
	if err := s.db.withRead(ctx, func(db *sql.DB) error {
		rows, err := db.QueryContext(ctx, `SELECT session_id FROM chat_runtime_sessions ORDER BY session_id`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return err
			}
			sessionIDs = append(sessionIDs, id)
		}
		return rows.Err()
	}); err != nil {
		return stats, err
	}

	for _, id := range sessionIDs {
		if ctx.Err() != nil {
			return stats, ctx.Err()
		}
		if err := s.db.withTx(ctx, func(tx *sql.Tx) error {
			if err := compactHistoryPayloadsTx(ctx, tx, id, &stats); err != nil {
				return err
			}
			if err := mergeStaleRepeatsTx(ctx, tx, id, &stats); err != nil {
				return err
			}
			return pruneStalePrewarmTx(ctx, tx, id, &stats)
		}); err != nil {
			return stats, err
		}
		stats.Sessions++
	}

	if err := s.db.withTx(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`); err != nil {
			return err
		}
		encoded, _ := json.Marshal(stats)
		_, err := tx.ExecContext(ctx, `
			INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
		`, TimelineHistoryCompactionMarker, string(encoded), s.clock())
		return err
	}); err != nil {
		return stats, err
	}
	return stats, nil
}

func compactHistoryPayloadsTx(ctx context.Context, tx *sql.Tx, sessionID string, stats *HistoryCompactionStats) error {
	rows, err := tx.QueryContext(ctx, `
		SELECT event_id, payload_json FROM chat_runtime_events
		WHERE session_id = ? AND event_id LIKE 'history-%' AND type LIKE 'timeline.item.%'
	`, sessionID)
	if err != nil {
		return err
	}
	type rowData struct{ eventID, payloadJSON string }
	var list []rowData
	for rows.Next() {
		var r rowData
		if err := rows.Scan(&r.eventID, &r.payloadJSON); err != nil {
			_ = rows.Close()
			return err
		}
		list = append(list, r)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, r := range list {
		payload := parseJSONObject(r.payloadJSON)
		rawItem, ok := payload["item"].(map[string]any)
		if !ok || rawItem == nil {
			continue
		}
		compacted := CompactTimelineItem(rawItem)
		if CanonicalJSONEquals(compacted, rawItem) {
			continue
		}
		nextPayload := CloneMap(payload)
		nextPayload["item"] = compacted
		nextBytes, err := json.Marshal(nextPayload)
		if err != nil {
			continue
		}
		stats.BytesSaved += int64(len(r.payloadJSON) - len(nextBytes))
		stats.RowsCompacted++
		if _, err := tx.ExecContext(ctx, `UPDATE chat_runtime_events SET payload_json = ? WHERE event_id = ?`, string(nextBytes), r.eventID); err != nil {
			return err
		}
	}
	return nil
}

func mergeStaleRepeatsTx(ctx context.Context, tx *sql.Tx, sessionID string, stats *HistoryCompactionStats) error {
	rows, err := tx.QueryContext(ctx, `
		SELECT event_id, item_id, type, payload_json FROM chat_runtime_events
		WHERE session_id = ? AND item_id IS NOT NULL AND type LIKE 'timeline.item.%'
		ORDER BY item_id, seq
	`, sessionID)
	if err != nil {
		return err
	}
	type rowData struct{ eventID, itemID, evType, payloadJSON string }
	var list []rowData
	for rows.Next() {
		var r rowData
		if err := rows.Scan(&r.eventID, &r.itemID, &r.evType, &r.payloadJSON); err != nil {
			_ = rows.Close()
			return err
		}
		list = append(list, r)
	}
	_ = rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	var keeper *rowData
	for i := range list {
		r := &list[i]
		isHistory := strings.HasPrefix(r.eventID, "history-")
		if keeper != nil && keeper.itemID == r.itemID && isHistory && keeper.evType == r.evType &&
			samePayloadWithoutUpdatedAt(keeper.payloadJSON, r.payloadJSON) {
			if _, err := tx.ExecContext(ctx, `UPDATE chat_runtime_events SET payload_json = ? WHERE event_id = ?`, r.payloadJSON, keeper.eventID); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM chat_runtime_events WHERE event_id = ?`, r.eventID); err != nil {
				return err
			}
			stats.BytesSaved += int64(len(r.payloadJSON))
			stats.RowsMerged++
			keeper.payloadJSON = r.payloadJSON
			continue
		}
		if isHistory {
			copyR := *r
			keeper = &copyR
		} else {
			keeper = nil
		}
	}
	return nil
}

func samePayloadWithoutUpdatedAt(aJSON, bJSON string) bool {
	a := parseJSONObject(aJSON)
	b := parseJSONObject(bJSON)
	if itemA, ok := a["item"].(map[string]any); ok {
		c := CloneMap(itemA)
		delete(c, "updatedAt")
		a["item"] = c
	}
	if itemB, ok := b["item"].(map[string]any); ok {
		c := CloneMap(itemB)
		delete(c, "updatedAt")
		b["item"] = c
	}
	return CanonicalJSONEquals(a, b)
}

func pruneStalePrewarmTx(ctx context.Context, tx *sql.Tx, sessionID string, stats *HistoryCompactionStats) error {
	res, err := tx.ExecContext(ctx, `
		DELETE FROM chat_runtime_events
		WHERE session_id = ? AND type LIKE 'runtime.prewarm.%'
		  AND seq <= (SELECT last_event_seq FROM chat_runtime_sessions WHERE session_id = ?) - ?
	`, sessionID, sessionID, PrewarmRetainedEventWindow)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	stats.PrewarmPruned += n
	return nil
}

// 未使用导入防警告检查：保持 maps 可按需使用。
var _ = maps.Copy[map[string]any, map[string]any]
var _ = http.StatusOK
