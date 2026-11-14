package chatruntime

import (
	"context"
	"strings"
	"sync"
)

const publishPageSize = 500

// PublishingStoreOptions 配置 PublishingStore 的事件总线与回调钩子。
type PublishingStoreOptions struct {
	Store              *Store
	EventHub           *EventHub
	OnCommandPersisted func(commandID string, trace *TraceRecord)
	OnEventPublished   func(event EventEnvelope)
}

type sessionDeliveryQueue struct {
	mu       sync.Mutex
	draining bool
	lastSeq  int64
	buf      []EventEnvelope
}

// PublishingStore 在 Store 持久化的同时按严格序号顺序向 EventHub 发布已提交事件。
type PublishingStore struct {
	store              *Store
	eventHub           *EventHub
	onCommandPersisted func(commandID string, trace *TraceRecord)
	onEventPublished   func(event EventEnvelope)

	sessMu sync.Mutex
	opMu   map[string]*sync.Mutex
	queues map[string]*sessionDeliveryQueue
}

// NewPublishingStore 构造带事件广播语义的存储包装器。
func NewPublishingStore(opts PublishingStoreOptions) *PublishingStore {
	hub := opts.EventHub
	if hub == nil {
		hub = NewEventHub()
	}
	onCmd := opts.OnCommandPersisted
	if onCmd == nil {
		onCmd = func(string, *TraceRecord) {}
	}
	onEvt := opts.OnEventPublished
	if onEvt == nil {
		onEvt = func(EventEnvelope) {}
	}
	return &PublishingStore{
		store:              opts.Store,
		eventHub:           hub,
		onCommandPersisted: onCmd,
		onEventPublished:   onEvt,
		opMu:               make(map[string]*sync.Mutex),
		queues:             make(map[string]*sessionDeliveryQueue),
	}
}

// Store 返回底层持久化 Store。
func (p *PublishingStore) Store() *Store { return p.store }

// EventHub 返回关联的内存事件总线。
func (p *PublishingStore) EventHub() *EventHub { return p.eventHub }

func (p *PublishingStore) sessionLock(sessionID string) *sync.Mutex {
	p.sessMu.Lock()
	defer p.sessMu.Unlock()
	m := p.opMu[sessionID]
	if m == nil {
		m = &sync.Mutex{}
		p.opMu[sessionID] = m
	}
	return m
}

func (p *PublishingStore) deliveryQueue(sessionID string) *sessionDeliveryQueue {
	p.sessMu.Lock()
	defer p.sessMu.Unlock()
	q := p.queues[sessionID]
	if q == nil {
		q = &sessionDeliveryQueue{}
		p.queues[sessionID] = q
	}
	return q
}

func (p *PublishingStore) deliver(sessionID string, events []EventEnvelope) {
	if len(events) == 0 {
		return
	}
	q := p.deliveryQueue(sessionID)
	q.mu.Lock()
	for _, ev := range events {
		if ev.Seq > 0 && ev.Seq <= q.lastSeq {
			continue
		}
		if ev.Seq > q.lastSeq {
			q.lastSeq = ev.Seq
		}
		q.buf = append(q.buf, ev)
	}
	if q.draining {
		q.mu.Unlock()
		return
	}
	q.draining = true
	for len(q.buf) > 0 {
		batch := q.buf
		q.buf = nil
		q.mu.Unlock()
		for _, ev := range batch {
			p.publishSingle(ev)
		}
		q.mu.Lock()
	}
	q.draining = false
	q.mu.Unlock()
}

func (p *PublishingStore) publishSingle(ev EventEnvelope) {
	_, _ = p.eventHub.Publish(ev)
	func() {
		defer func() { _ = recover() }()
		p.onEventPublished(ev)
	}()
}

// PublishDirectly 直接向 EventHub 与回调发布一条传输层/瞬时事件（不经过顺序队列去重）。
func (p *PublishingStore) PublishDirectly(ev EventEnvelope) {
	p.publishSingle(ev)
}

func (p *PublishingStore) collectSince(ctx context.Context, sessionID string, after int64) ([]EventEnvelope, error) {
	sess, err := p.store.GetSession(ctx, sessionID)
	if err != nil {
		return nil, err
	}
	if sess == nil {
		return nil, nil
	}
	through := sess.LastEventSeq
	cursor := after
	if cursor < 0 {
		cursor = 0
	}
	var out []EventEnvelope
	for cursor < through {
		events, err := p.store.ListEvents(ctx, sessionID, cursor, &through, publishPageSize)
		if err != nil {
			return nil, err
		}
		if len(events) == 0 {
			return nil, publishSequenceError(sessionID, cursor+1, through, nil)
		}
		for _, ev := range events {
			if ev.Seq != cursor+1 || ev.Seq > through {
				actual := ev.Seq
				return nil, publishSequenceError(sessionID, cursor+1, through, &actual)
			}
			out = append(out, ev)
			cursor = ev.Seq
		}
	}
	return out, nil
}

// PublishSince 读取自 after 之后已持久化的连续事件并向订阅者发布，返回发布条数。
func (p *PublishingStore) PublishSince(ctx context.Context, sessionID string, after int64) (int, error) {
	sid := strings.TrimSpace(sessionID)
	if sid == "" {
		return 0, nil
	}
	mu := p.sessionLock(sid)
	mu.Lock()
	events, err := p.collectSince(ctx, sid, after)
	mu.Unlock()
	if err != nil {
		return 0, err
	}
	p.deliver(sid, events)
	return len(events), nil
}

func publishKnown[T any](p *PublishingStore, ctx context.Context, sessionID string, op func() (T, error)) (T, error) {
	var zero T
	sid := strings.TrimSpace(sessionID)
	if sid == "" {
		return op()
	}
	mu := p.sessionLock(sid)
	mu.Lock()
	var after int64
	if sess, err := p.store.GetSession(ctx, sid); err == nil && sess != nil {
		after = sess.LastEventSeq
	}
	res, err := op()
	if err != nil {
		mu.Unlock()
		return zero, err
	}
	events, collectErr := p.collectSince(ctx, sid, after)
	mu.Unlock()
	if collectErr != nil {
		return res, collectErr
	}
	p.deliver(sid, events)
	return res, nil
}

func (p *PublishingStore) CreateSession(ctx context.Context, in CreateSessionInput) (*Session, error) {
	sess, err := p.store.CreateSession(ctx, in)
	if err != nil {
		return nil, err
	}
	if _, pubErr := p.PublishSince(ctx, sess.SessionID, 0); pubErr != nil {
		return sess, pubErr
	}
	return sess, nil
}

func (p *PublishingStore) GetSession(ctx context.Context, sessionID string) (*Session, error) {
	return p.store.GetSession(ctx, sessionID)
}

func (p *PublishingStore) RequireSession(ctx context.Context, sessionID string) (*Session, error) {
	return p.store.RequireSession(ctx, sessionID)
}

func (p *PublishingStore) FindSessionByNativeIdentity(ctx context.Context, provider, nativeSessionID string) (*Session, error) {
	return p.store.FindSessionByNativeIdentity(ctx, provider, nativeSessionID)
}

func (p *PublishingStore) DeleteSession(ctx context.Context, sessionID string) (*Session, error) {
	return p.store.DeleteSession(ctx, sessionID)
}

func (p *PublishingStore) BranchSession(ctx context.Context, cmd *Command) (*Session, error) {
	child, err := p.store.BranchSession(ctx, cmd)
	if err != nil {
		return nil, err
	}
	if _, pubErr := p.PublishSince(ctx, child.SessionID, 0); pubErr != nil {
		return child, pubErr
	}
	return child, nil
}

func (p *PublishingStore) ReadHistorySeed(ctx context.Context, sessionID string) (*HistorySeed, error) {
	return p.store.ReadHistorySeed(ctx, sessionID)
}

func (p *PublishingStore) RecordNativeResponseItem(ctx context.Context, sessionID string, ev NativeResponseItemEvidence) error {
	return p.store.RecordNativeResponseItem(ctx, sessionID, ev)
}

func (p *PublishingStore) ReadNativeResponseItem(ctx context.Context, sessionID, itemID string) (map[string]any, error) {
	return p.store.ReadNativeResponseItem(ctx, sessionID, itemID)
}

func (p *PublishingStore) MarkNativeHistoryCoverage(ctx context.Context, sessionID string, ev NativeHistoryBoundaryEvidence) (string, error) {
	return p.store.MarkNativeHistoryCoverage(ctx, sessionID, ev)
}

func (p *PublishingStore) CreateAttachments(ctx context.Context, sessionID string, inputs []AttachmentInput) ([]Attachment, error) {
	return p.store.CreateAttachments(ctx, sessionID, inputs)
}

func (p *PublishingStore) ResolveAttachmentPaths(ctx context.Context, sessionID string, attachmentIDs []string) ([]string, error) {
	return p.store.ResolveAttachmentPaths(ctx, sessionID, attachmentIDs)
}

func (p *PublishingStore) ListSessions(ctx context.Context, filter ListSessionsFilter) ([]Session, error) {
	return p.store.ListSessions(ctx, filter)
}

func (p *PublishingStore) UpdateRuntimeBinding(ctx context.Context, sessionID string, patch map[string]any, replacement *NativeThreadReplacement) (*Session, error) {
	return publishKnown(p, ctx, sessionID, func() (*Session, error) {
		return p.store.UpdateRuntimeBinding(ctx, sessionID, patch, replacement)
	})
}

func (p *PublishingStore) UpdateExecutionContext(ctx context.Context, sessionID, execAccountRef string, runtimeBinding, capSnapshot map[string]any) (*Session, error) {
	return publishKnown(p, ctx, sessionID, func() (*Session, error) {
		return p.store.UpdateExecutionContext(ctx, sessionID, execAccountRef, runtimeBinding, capSnapshot)
	})
}

func (p *PublishingStore) UpdateCapabilitySnapshot(ctx context.Context, sessionID string, caps map[string]any) (*Session, error) {
	return p.store.UpdateCapabilitySnapshot(ctx, sessionID, caps)
}

func (p *PublishingStore) UpdatePolicy(ctx context.Context, sessionID string, patch map[string]any) (*Session, error) {
	return publishKnown(p, ctx, sessionID, func() (*Session, error) {
		return p.store.UpdatePolicy(ctx, sessionID, patch)
	})
}

func (p *PublishingStore) SetGoal(ctx context.Context, sessionID string, goal map[string]any, source string) (*GoalUpdateResult, error) {
	return publishKnown(p, ctx, sessionID, func() (*GoalUpdateResult, error) {
		return p.store.SetGoal(ctx, sessionID, goal, source)
	})
}

func (p *PublishingStore) ClearGoal(ctx context.Context, sessionID string) (*GoalUpdateResult, error) {
	return publishKnown(p, ctx, sessionID, func() (*GoalUpdateResult, error) {
		return p.store.ClearGoal(ctx, sessionID)
	})
}

func (p *PublishingStore) SetSessionState(ctx context.Context, sessionID, state string, activeTurn *ActiveTurn) (*Session, error) {
	return p.store.SetSessionState(ctx, sessionID, state, activeTurn)
}

func (p *PublishingStore) BeginTurn(ctx context.Context, sessionID string, in BeginTurnInput) (*TurnTransitionResult, error) {
	return publishKnown(p, ctx, sessionID, func() (*TurnTransitionResult, error) {
		return p.store.BeginTurn(ctx, sessionID, in)
	})
}

func (p *PublishingStore) TransitionTurnPhase(ctx context.Context, sessionID, state string, activeTurn *ActiveTurn, event EventDraft) (*TurnTransitionResult, error) {
	return publishKnown(p, ctx, sessionID, func() (*TurnTransitionResult, error) {
		return p.store.TransitionTurnPhase(ctx, sessionID, state, activeTurn, event)
	})
}

func (p *PublishingStore) UpdateActiveTurnAnchor(ctx context.Context, sessionID, runID, nativeTurnID, clientUserMsgID string) (*Session, error) {
	return p.store.UpdateActiveTurnAnchor(ctx, sessionID, runID, nativeTurnID, clientUserMsgID)
}

func (p *PublishingStore) AcceptCommand(ctx context.Context, input map[string]any, trace *TraceRecord) (*AcceptCommandResult, error) {
	res, err := p.store.AcceptCommand(ctx, input)
	if err != nil {
		return nil, err
	}
	cmdID, _ := input["commandId"].(string)
	p.onCommandPersisted(strings.TrimSpace(cmdID), trace)
	return res, nil
}

func (p *PublishingStore) GetCommand(ctx context.Context, commandID string) (*Command, error) {
	return p.store.GetCommand(ctx, commandID)
}

func (p *PublishingStore) GetRetrySubmission(ctx context.Context, sessionID, sourceTurnID string) (*Command, error) {
	return p.store.GetRetrySubmission(ctx, sessionID, sourceTurnID)
}

func (p *PublishingStore) CompleteCommand(ctx context.Context, commandID, status string, result map[string]any) (*Command, error) {
	return p.store.CompleteCommand(ctx, commandID, status, result)
}

func (p *PublishingStore) AppendEvent(ctx context.Context, sessionID string, draft EventDraft) (EventEnvelope, error) {
	sid := strings.TrimSpace(sessionID)
	mu := p.sessionLock(sid)
	mu.Lock()
	ev, err := p.store.AppendEvent(ctx, sessionID, draft)
	mu.Unlock()
	if err != nil {
		return EventEnvelope{}, err
	}
	p.deliver(ev.SessionID, []EventEnvelope{ev})
	return ev, nil
}

func (p *PublishingStore) ImportTimeline(ctx context.Context, sessionID string, drafts []EventDraft) (*ImportResult, error) {
	return publishKnown(p, ctx, sessionID, func() (*ImportResult, error) {
		return p.store.ImportTimeline(ctx, sessionID, drafts)
	})
}

func (p *PublishingStore) ListEvents(ctx context.Context, sessionID string, after int64, through *int64, limit int) ([]EventEnvelope, error) {
	return p.store.ListEvents(ctx, sessionID, after, through, limit)
}

func (p *PublishingStore) GetEventBounds(ctx context.Context, sessionID string) (EventBounds, error) {
	return p.store.GetEventBounds(ctx, sessionID)
}

func (p *PublishingStore) Enqueue(ctx context.Context, sessionID string, input EnqueueInput) (*QueueEntry, error) {
	return publishKnown(p, ctx, sessionID, func() (*QueueEntry, error) {
		return p.store.Enqueue(ctx, sessionID, input)
	})
}

func (p *PublishingStore) EditQueueItem(ctx context.Context, queueID string, patch map[string]any) (*QueueEntry, error) {
	sid := p.queueSessionID(ctx, queueID)
	return publishKnown(p, ctx, sid, func() (*QueueEntry, error) {
		return p.store.EditQueueItem(ctx, queueID, patch)
	})
}

func (p *PublishingStore) RemoveQueueItem(ctx context.Context, queueID string) (*QueueEntry, error) {
	sid := p.queueSessionID(ctx, queueID)
	return publishKnown(p, ctx, sid, func() (*QueueEntry, error) {
		return p.store.RemoveQueueItem(ctx, queueID)
	})
}

func (p *PublishingStore) MoveQueueItem(ctx context.Context, queueID, beforeQueueID string) (*QueueEntry, error) {
	sid := p.queueSessionID(ctx, queueID)
	return publishKnown(p, ctx, sid, func() (*QueueEntry, error) {
		return p.store.MoveQueueItem(ctx, queueID, beforeQueueID)
	})
}

func (p *PublishingStore) LeaseQueueItem(ctx context.Context, sessionID string, input LeaseQueueInput) (*QueueEntry, error) {
	return publishKnown(p, ctx, sessionID, func() (*QueueEntry, error) {
		return p.store.LeaseQueueItem(ctx, sessionID, input)
	})
}

func (p *PublishingStore) LeaseNextQueueItem(ctx context.Context, sessionID string, input LeaseQueueInput) (*QueueEntry, error) {
	return publishKnown(p, ctx, sessionID, func() (*QueueEntry, error) {
		return p.store.LeaseNextQueueItem(ctx, sessionID, input)
	})
}

func (p *PublishingStore) MarkQueueRunning(ctx context.Context, queueID, leaseID string) (*QueueEntry, error) {
	sid := p.queueSessionID(ctx, queueID)
	return publishKnown(p, ctx, sid, func() (*QueueEntry, error) {
		return p.store.MarkQueueRunning(ctx, queueID, leaseID)
	})
}

func (p *PublishingStore) SettleQueueItem(ctx context.Context, queueID, leaseID, outcome string, result map[string]any) (*QueueEntry, error) {
	sid := p.queueSessionID(ctx, queueID)
	return publishKnown(p, ctx, sid, func() (*QueueEntry, error) {
		return p.store.SettleQueueItem(ctx, queueID, leaseID, outcome, result)
	})
}

func (p *PublishingStore) SettleTurn(ctx context.Context, sessionID string, in SettleTurnInput) (*TurnTransitionResult, error) {
	return publishKnown(p, ctx, sessionID, func() (*TurnTransitionResult, error) {
		return p.store.SettleTurn(ctx, sessionID, in)
	})
}

func (p *PublishingStore) ListQueue(ctx context.Context, sessionID string, activeOnly bool) ([]QueueEntry, error) {
	return p.store.ListQueue(ctx, sessionID, activeOnly)
}

func (p *PublishingStore) ListRecoveryCandidates(ctx context.Context) ([]Session, error) {
	return p.store.ListRecoveryCandidates(ctx)
}

func (p *PublishingStore) BeginRestartRecovery(ctx context.Context, sessionID string) (*RecoveryState, error) {
	return publishKnown(p, ctx, sessionID, func() (*RecoveryState, error) {
		return p.store.BeginRestartRecovery(ctx, sessionID)
	})
}

func (p *PublishingStore) CompleteRestartRecovery(ctx context.Context, sessionID string, input CompleteRecoveryInput) (*RecoveryState, error) {
	return publishKnown(p, ctx, sessionID, func() (*RecoveryState, error) {
		return p.store.CompleteRestartRecovery(ctx, sessionID, input)
	})
}

func (p *PublishingStore) FailRestartRecovery(ctx context.Context, sessionID string, errInput any) (*Session, error) {
	return publishKnown(p, ctx, sessionID, func() (*Session, error) {
		return p.store.FailRestartRecovery(ctx, sessionID, errInput)
	})
}

func (p *PublishingStore) ReadRestartRecovery(ctx context.Context, sessionID string) (*RecoveryState, error) {
	return p.store.ReadRestartRecovery(ctx, sessionID)
}

func (p *PublishingStore) CreateInteraction(ctx context.Context, input CreateInteractionInput) (*Interaction, error) {
	return publishKnown(p, ctx, input.SessionID, func() (*Interaction, error) {
		return p.store.CreateInteraction(ctx, input)
	})
}

func (p *PublishingStore) ValidateInteraction(ctx context.Context, interactionID string, input ResolveInteractionInput) (*Interaction, error) {
	return p.store.ValidateInteraction(ctx, interactionID, input)
}

func (p *PublishingStore) ResolveInteraction(ctx context.Context, interactionID string, input ResolveInteractionInput) (*Interaction, error) {
	sid := p.interactionSessionID(ctx, interactionID)
	return publishKnown(p, ctx, sid, func() (*Interaction, error) {
		return p.store.ResolveInteraction(ctx, interactionID, input)
	})
}

func (p *PublishingStore) ClaimInteractionResolution(ctx context.Context, interactionID string, input ResolveInteractionInput) (*Interaction, error) {
	sid := p.interactionSessionID(ctx, interactionID)
	return publishKnown(p, ctx, sid, func() (*Interaction, error) {
		return p.store.ClaimInteractionResolution(ctx, interactionID, input)
	})
}

func (p *PublishingStore) FinishInteractionResolution(ctx context.Context, claim *Interaction) (*Interaction, error) {
	if claim == nil {
		return nil, ErrInvalid("chat_interaction_required")
	}
	sid := p.interactionSessionID(ctx, claim.InteractionID)
	return publishKnown(p, ctx, sid, func() (*Interaction, error) {
		return p.store.FinishInteractionResolution(ctx, claim)
	})
}

func (p *PublishingStore) ReleaseInteractionResolution(ctx context.Context, claim *Interaction) (*Interaction, error) {
	if claim == nil {
		return nil, ErrInvalid("chat_interaction_required")
	}
	sid := p.interactionSessionID(ctx, claim.InteractionID)
	return publishKnown(p, ctx, sid, func() (*Interaction, error) {
		return p.store.ReleaseInteractionResolution(ctx, claim)
	})
}

func (p *PublishingStore) AcknowledgeExternalInteraction(ctx context.Context, interactionID string) (*Interaction, error) {
	sid := p.interactionSessionID(ctx, interactionID)
	return publishKnown(p, ctx, sid, func() (*Interaction, error) {
		return p.store.AcknowledgeExternalInteraction(ctx, interactionID)
	})
}

// ExpireInteraction 在 PublishingStore 中将交互置为已过期并广播 interaction.expired 事件。
func (p *PublishingStore) ExpireInteraction(ctx context.Context, interactionID, reason string) (*Interaction, error) {
	sid := p.interactionSessionID(ctx, interactionID)
	return publishKnown(p, ctx, sid, func() (*Interaction, error) {
		return p.store.ExpireInteraction(ctx, interactionID, reason)
	})
}

func (p *PublishingStore) GetSnapshot(ctx context.Context, sessionID string) (*Snapshot, error) {
	return p.store.GetSnapshot(ctx, sessionID)
}

func (p *PublishingStore) ReadTimeline(ctx context.Context, sessionID, before string, limit int) (*TimelinePage, error) {
	return p.store.ReadTimeline(ctx, sessionID, before, limit)
}

func (p *PublishingStore) Close() error {
	return p.store.Close()
}

func (p *PublishingStore) queueSessionID(ctx context.Context, queueID string) string {
	item, err := p.store.Queue.Get(ctx, queueID)
	if err != nil || item == nil {
		return ""
	}
	return item.SessionID
}

func (p *PublishingStore) interactionSessionID(ctx context.Context, interactionID string) string {
	item, err := p.store.Interactions.Get(ctx, interactionID)
	if err != nil || item == nil {
		return ""
	}
	return item.SessionID
}

func publishSequenceError(sessionID string, expectedSeq, throughSeq int64, actualSeq *int64) error {
	details := map[string]any{
		"sessionId":   sessionID,
		"expectedSeq": expectedSeq,
		"throughSeq":  throughSeq,
	}
	if actualSeq != nil {
		details["actualSeq"] = *actualSeq
	}
	return NewError("chat_runtime_publish_sequence_gap", 500, details)
}
