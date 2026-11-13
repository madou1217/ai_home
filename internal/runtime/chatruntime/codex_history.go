package chatruntime

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/core/inference"
)

const (
	defaultCodexHistoryPageLimit = 100
	defaultMaxCodexHistoryPages  = 1000
	defaultCodexReplayTimeout    = 5 * time.Second
	defaultCodexCleanupTimeout   = 5 * time.Second
)

// CodexToolOrder 协调 rawResponseItem 与 typed lifecycle 事件的发布顺序，保证工具卡与正文不乱序。
type CodexToolOrder struct {
	mu                 sync.Mutex
	calls              map[string]*codexOrderedCall
	order              []string
	cursor             int
	aliases            map[string]any // *codexOrderedCall | struct{} (ambiguous)
	outputsBeforeCalls map[string]struct{}
	nextSlot           int
}

type codexOrderedCall struct {
	slot       string
	primary    string
	sourceIDs  map[string]struct{}
	aliases    []string
	events     []codexQueuedToolEvent
	flush      bool
	outputSeen bool
	ambiguous  bool
	released   bool
}

type codexQueuedToolEvent struct {
	fn   func() error
	done chan error
}

var codexAmbiguousSentinel = struct{}{}

// NewCodexToolOrder 构造单轮工具顺序协调器。
func NewCodexToolOrder() *CodexToolOrder {
	return &CodexToolOrder{
		calls:              make(map[string]*codexOrderedCall),
		aliases:            make(map[string]any),
		outputsBeforeCalls: make(map[string]struct{}),
	}
}

// ObserveRaw 记录 rawResponseItem 中的工具调用或结果并推进可释放槽位。
func (o *CodexToolOrder) ObserveRaw(msg CodexJSONRPCMessage) {
	if msg.Method != "rawResponseItem/completed" {
		return
	}
	item, _ := msg.Params["item"].(map[string]any)
	if item == nil {
		return
	}
	stage, aliases, sourceID := codexRawToolIdentity(item)
	if len(aliases) == 0 {
		return
	}
	o.mu.Lock()
	if stage == "call" {
		o.registerLocked(aliases, sourceID)
	} else if stage == "output" {
		o.noteOutputLocked(aliases)
	}
	writes := o.collectDrainLocked()
	o.mu.Unlock()
	runCodexOrderedWrites(writes)
}

// DispatchOrdered 若事件关联已登记工具槽位则排队保序发送，否则直接执行 fn。
func (o *CodexToolOrder) DispatchOrdered(callID string, fn func() error) error {
	if fn == nil {
		return nil
	}
	o.mu.Lock()
	call := o.resolveLocked(callID)
	if call == nil || call.released || call.ambiguous {
		o.mu.Unlock()
		return fn()
	}
	done := make(chan error, 1)
	call.events = append(call.events, codexQueuedToolEvent{fn: fn, done: done})
	writes := o.collectDrainLocked()
	o.mu.Unlock()
	runCodexOrderedWrites(writes)
	return <-done
}

// Flush 强制释放全部剩余挂起工具槽位中的事件。
func (o *CodexToolOrder) Flush() {
	o.mu.Lock()
	for i := o.cursor; i < len(o.order); i++ {
		if call := o.calls[o.order[i]]; call != nil {
			call.flush = true
		}
	}
	writes := o.collectDrainLocked()
	o.mu.Unlock()
	runCodexOrderedWrites(writes)
}

func (o *CodexToolOrder) registerLocked(aliases []string, sourceID string) {
	uniq := uniqueNonEmptyStrings(aliases)
	if len(uniq) == 0 {
		return
	}
	var prior *codexOrderedCall
	priorCount := 0
	for _, a := range uniq {
		if owner, ok := o.aliases[a].(*codexOrderedCall); ok && owner != nil {
			if prior == nil {
				prior = owner
				priorCount = 1
			} else if prior != owner {
				priorCount++
			}
		}
	}
	if priorCount != 1 {
		prior = nil
	}
	source := strings.TrimSpace(sourceID)
	samePrimary := prior != nil && prior.primary == uniq[0]
	sourceConflict := samePrimary && source != "" && len(prior.sourceIDs) > 0
	if sourceConflict {
		_, exists := prior.sourceIDs[source]
		sourceConflict = !exists
	}
	allFreeOrPrior := true
	if samePrimary && !sourceConflict {
		for _, a := range uniq {
			if cur, exists := o.aliases[a]; exists && cur != prior {
				allFreeOrPrior = false
				break
			}
		}
		if allFreeOrPrior {
			for _, a := range uniq {
				o.bindAliasLocked(a, prior)
			}
			if source != "" {
				prior.sourceIDs[source] = struct{}{}
			}
			return
		}
	}

	o.nextSlot++
	call := &codexOrderedCall{
		slot:       fmt.Sprintf("tool-%d", o.nextSlot),
		primary:    uniq[0],
		sourceIDs:  make(map[string]struct{}),
		aliases:    uniq,
		outputSeen: false,
	}
	if source != "" {
		call.sourceIDs[source] = struct{}{}
	}
	for _, a := range uniq {
		if _, seen := o.outputsBeforeCalls[a]; seen {
			call.outputSeen = true
		}
		delete(o.outputsBeforeCalls, a)
	}
	o.calls[call.slot] = call
	o.order = append(o.order, call.slot)
	for _, a := range uniq {
		o.bindAliasLocked(a, call)
	}
}

func (o *CodexToolOrder) noteOutputLocked(aliases []string) {
	for _, a := range uniqueNonEmptyStrings(aliases) {
		if owner, ok := o.aliases[a].(*codexOrderedCall); ok && owner != nil {
			owner.outputSeen = true
		} else if _, exists := o.aliases[a]; !exists {
			o.outputsBeforeCalls[a] = struct{}{}
		}
	}
}

func (o *CodexToolOrder) resolveLocked(alias string) *codexOrderedCall {
	clean := strings.TrimSpace(alias)
	if clean == "" {
		return nil
	}
	owner, ok := o.aliases[clean].(*codexOrderedCall)
	if !ok {
		return nil
	}
	return owner
}

func (o *CodexToolOrder) bindAliasLocked(alias string, call *codexOrderedCall) {
	existing, exists := o.aliases[alias]
	if !exists {
		o.aliases[alias] = call
		return
	}
	if existing == call || existing == codexAmbiguousSentinel {
		if existing == codexAmbiguousSentinel {
			call.ambiguous = true
		}
		return
	}
	if other, ok := existing.(*codexOrderedCall); ok && other != nil {
		other.ambiguous = true
	}
	call.ambiguous = true
	o.aliases[alias] = codexAmbiguousSentinel
}

func (o *CodexToolOrder) collectDrainLocked() []codexQueuedToolEvent {
	var writes []codexQueuedToolEvent
	for o.cursor < len(o.order) {
		call := o.calls[o.order[o.cursor]]
		if call == nil {
			o.cursor++
			continue
		}
		if !call.ambiguous && len(call.events) == 0 && !call.outputSeen && !call.flush {
			break
		}
		call.released = true
		o.cursor++
		writes = append(writes, call.events...)
		call.events = nil
	}
	return writes
}

func runCodexOrderedWrites(writes []codexQueuedToolEvent) {
	for _, q := range writes {
		err := q.fn()
		q.done <- err
		close(q.done)
	}
}

func codexRawToolIdentity(item map[string]any) (string, []string, string) {
	t := asString(item["type"])
	sourceID := asString(item["id"])
	switch t {
	case "function_call", "custom_tool_call":
		callID := asString(item["call_id"])
		return "call", []string{callID, sourceID}, sourceID
	case "local_shell_call":
		return "call", []string{asString(item["call_id"]), sourceID}, sourceID
	case "web_search_call":
		return "call", []string{sourceID, asString(item["call_id"])}, sourceID
	case "function_call_output", "custom_tool_call_output":
		return "output", []string{asString(item["call_id"]), sourceID}, sourceID
	default:
		return "", nil, ""
	}
}

func uniqueNonEmptyStrings(in []string) []string {
	out := make([]string, 0, len(in))
	seen := make(map[string]struct{}, len(in))
	for _, s := range in {
		clean := strings.TrimSpace(s)
		if clean == "" {
			continue
		}
		if _, ok := seen[clean]; ok {
			continue
		}
		seen[clean] = struct{}{}
		out = append(out, clean)
	}
	return out
}

// CodexInteractionReplayGate 在重启重连后验证挂起交互请求是否如实重放。
type CodexInteractionReplayGate struct {
	provider  string
	sessionID string
	timeout   time.Duration

	mu       sync.Mutex
	expected map[string]Interaction
	failure  error
	waitCh   chan struct{}
	timer    *time.Timer
}

// NewCodexInteractionReplayGate 构造恢复期交互重放验证门。
func NewCodexInteractionReplayGate(provider, sessionID string, timeout time.Duration) *CodexInteractionReplayGate {
	if timeout <= 0 {
		timeout = defaultCodexReplayTimeout
	}
	return &CodexInteractionReplayGate{
		provider:  provider,
		sessionID: sessionID,
		timeout:   timeout,
		expected:  make(map[string]Interaction),
	}
}

// Expect 登记重启前未解决、重连后必须收到的挂起交互列表。
func (g *CodexInteractionReplayGate) Expect(interactions []Interaction) {
	g.Cancel()
	g.mu.Lock()
	defer g.mu.Unlock()
	g.failure = nil
	for _, it := range interactions {
		id := strings.TrimSpace(it.InteractionID)
		if id != "" {
			g.expected[id] = it
		}
	}
}

// Capture 检查重连期间收到的 interaction.requested 是否与预期挂起交互匹配。
func (g *CodexInteractionReplayGate) Capture(interaction map[string]any, env *CodexInteractionEnvelope) (replayed bool, err error) {
	if env == nil {
		return false, nil
	}
	id, err := NativeInteractionID("codex", g.sessionID, env.NativeThreadID, fmt.Sprintf("%v", env.RequestID))
	if err != nil {
		g.Fail(err)
		return false, err
	}
	g.mu.Lock()
	expected, ok := g.expected[id]
	if !ok {
		g.mu.Unlock()
		return false, nil
	}
	if !sameRecoveredInteraction(expected, interaction) {
		mismatchErr := NewError("codex_pending_interaction_replay_mismatch", http.StatusConflict, map[string]any{"interactionId": id})
		g.mu.Unlock()
		g.Fail(mismatchErr)
		return true, mismatchErr
	}
	delete(g.expected, id)
	remaining := len(g.expected)
	g.mu.Unlock()
	if remaining == 0 {
		g.resolve()
	}
	return true, nil
}

// Wait 等待全部预期交互重放完成或超时失败。
func (g *CodexInteractionReplayGate) Wait(ctx context.Context) error {
	g.mu.Lock()
	if g.failure != nil {
		err := g.failure
		g.mu.Unlock()
		return err
	}
	if len(g.expected) == 0 {
		g.mu.Unlock()
		return nil
	}
	if g.waitCh == nil {
		g.waitCh = make(chan struct{})
		g.timer = time.AfterFunc(g.timeout, func() {
			g.mu.Lock()
			ids := make([]string, 0, len(g.expected))
			for id := range g.expected {
				ids = append(ids, id)
			}
			g.mu.Unlock()
			sort.Strings(ids)
			g.Fail(NewError("codex_pending_interaction_replay_missing", http.StatusServiceUnavailable, map[string]any{"interactionIds": ids}))
		})
	}
	ch := g.waitCh
	g.mu.Unlock()

	if ctx == nil {
		<-ch
	} else {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ch:
		}
	}
	g.mu.Lock()
	err := g.failure
	g.mu.Unlock()
	return err
}

// Cancel 清空等待列表并唤醒所有等待方。
func (g *CodexInteractionReplayGate) Cancel() {
	g.mu.Lock()
	g.expected = make(map[string]Interaction)
	g.failure = nil
	g.resolveLocked()
	g.mu.Unlock()
}

// Fail 标记重放失败并释放等待方。
func (g *CodexInteractionReplayGate) Fail(err error) {
	g.mu.Lock()
	g.expected = make(map[string]Interaction)
	g.failure = err
	g.resolveLocked()
	g.mu.Unlock()
}

func (g *CodexInteractionReplayGate) resolve() {
	g.mu.Lock()
	g.resolveLocked()
	g.mu.Unlock()
}

func (g *CodexInteractionReplayGate) resolveLocked() {
	if g.timer != nil {
		g.timer.Stop()
		g.timer = nil
	}
	if g.waitCh != nil {
		close(g.waitCh)
		g.waitCh = nil
	}
}

func sameRecoveredInteraction(expected Interaction, actual map[string]any) bool {
	if expected.Kind != asString(actual["kind"]) {
		return false
	}
	if expected.ItemID != asString(actual["itemId"]) {
		return false
	}
	return CanonicalJSONEquals(expected.Payload, actual["payload"])
}

// CodexUserMessageLink 关联 rawResponseItem(user message) 与 item/started(userMessage)。
type CodexUserMessageLink struct {
	mu      sync.Mutex
	pending []string
}

// Observe 记录 raw user message 或将其与 typed userMessage 配对返回 rawMessageID。
func (l *CodexUserMessageLink) Observe(msg CodexJSONRPCMessage) string {
	item, _ := msg.Params["item"].(map[string]any)
	if item == nil {
		return ""
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if msg.Method == "rawResponseItem/completed" {
		if asString(item["type"]) == "message" && asString(item["role"]) == "user" {
			if id := strings.TrimSpace(asString(item["id"])); id != "" {
				l.pending = append(l.pending, id)
			}
		}
		return ""
	}
	if (msg.Method == "item/started" || msg.Method == "item/completed") && asString(item["type"]) == "userMessage" {
		if len(l.pending) == 0 {
			return ""
		}
		id := l.pending[0]
		l.pending = l.pending[1:]
		return id
	}
	return ""
}

// CodexSessionEventBridgeOptions 配置 Codex 事件桥接器。
type CodexSessionEventBridgeOptions struct {
	Store            *PublishingStore
	Provider         string
	SessionID        string
	ReplayTimeout    time.Duration
	OnUnknownMethod  func(string)
	OnInteractionErr func(map[string]any)
}

// CodexBridgeObservation 描述单条通知/请求在桥接器中的映射与落库结果。
type CodexBridgeObservation struct {
	Mapped         CodexMappedMessage
	ProviderTurnID string
	Compaction     bool
	Err            error
}

type codexCompactionWaiter struct {
	threadID string
	ch       chan error
}

// CodexSessionEventBridge 把 Codex app-server 流事件与双向交互请求落盘并广播给 Canonical 事件线。
type CodexSessionEventBridge struct {
	store            *PublishingStore
	provider         string
	sessionID        string
	replayGate       *CodexInteractionReplayGate
	userMessageLink  *CodexUserMessageLink
	onUnknownMethod  func(string)
	onInteractionErr func(map[string]any)

	mu                sync.Mutex
	envelopes         map[string]*CodexInteractionEnvelope
	compactionWaiters []*codexCompactionWaiter
}

// NewCodexSessionEventBridge 构造 Codex 事件桥。
func NewCodexSessionEventBridge(opts CodexSessionEventBridgeOptions) *CodexSessionEventBridge {
	provider := strings.TrimSpace(opts.Provider)
	if provider == "" {
		provider = "codex"
	}
	return &CodexSessionEventBridge{
		store:            opts.Store,
		provider:         provider,
		sessionID:        opts.SessionID,
		replayGate:       NewCodexInteractionReplayGate(provider, opts.SessionID, opts.ReplayTimeout),
		userMessageLink:  &CodexUserMessageLink{},
		onUnknownMethod:  opts.OnUnknownMethod,
		onInteractionErr: opts.OnInteractionErr,
		envelopes:        make(map[string]*CodexInteractionEnvelope),
	}
}

// ExpectReplays 设置恢复重连时必须重放的挂起交互列表。
func (b *CodexSessionEventBridge) ExpectReplays(interactions []Interaction) {
	b.replayGate.Expect(interactions)
}

// WaitForExpectedReplays 等待重放门禁通过或超时。
func (b *CodexSessionEventBridge) WaitForExpectedReplays(ctx context.Context) error {
	return b.replayGate.Wait(ctx)
}

// CancelExpectedReplays 取消等待中的交互重放门禁。
func (b *CodexSessionEventBridge) CancelExpectedReplays() {
	b.replayGate.Cancel()
}

// LookupEnvelope 取回待回答交互对应的私密原生请求信封。
func (b *CodexSessionEventBridge) LookupEnvelope(interactionID string) *CodexInteractionEnvelope {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.envelopes[strings.TrimSpace(interactionID)]
}

// RemoveEnvelope 移除已解决交互的私密信封。
func (b *CodexSessionEventBridge) RemoveEnvelope(interactionID string) {
	b.mu.Lock()
	delete(b.envelopes, strings.TrimSpace(interactionID))
	b.mu.Unlock()
}

// WaitForCompaction 登记等待下一次 thread/compacted 生命周期完成信号。
func (b *CodexSessionEventBridge) WaitForCompaction(ctx context.Context, threadID string) error {
	w := &codexCompactionWaiter{
		threadID: strings.TrimSpace(threadID),
		ch:       make(chan error, 1),
	}
	b.mu.Lock()
	b.compactionWaiters = append(b.compactionWaiters, w)
	b.mu.Unlock()
	if ctx == nil {
		return <-w.ch
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-w.ch:
		return err
	}
}

// CancelCompactionWaiters 解除所有压缩等待方（出错或清理时调用）。
func (b *CodexSessionEventBridge) CancelCompactionWaiters(err error) {
	b.mu.Lock()
	waiters := b.compactionWaiters
	b.compactionWaiters = nil
	b.mu.Unlock()
	for _, w := range waiters {
		w.ch <- err
		close(w.ch)
	}
}

func (b *CodexSessionEventBridge) resolveCompactionWaiters(threadID string, err error) {
	cleanThread := strings.TrimSpace(threadID)
	b.mu.Lock()
	remaining := make([]*codexCompactionWaiter, 0, len(b.compactionWaiters))
	matched := make([]*codexCompactionWaiter, 0)
	for _, w := range b.compactionWaiters {
		if w.threadID == "" || w.threadID == cleanThread {
			matched = append(matched, w)
		} else {
			remaining = append(remaining, w)
		}
	}
	b.compactionWaiters = remaining
	b.mu.Unlock()
	for _, w := range matched {
		w.ch <- err
		close(w.ch)
	}
}

// MarkHistoryCoverage 记录指定原生回合的响应项覆盖边界（complete 或 gap）。
func (b *CodexSessionEventBridge) MarkHistoryCoverage(ctx context.Context, threadID, turnID, boundary string) error {
	if b.store == nil || strings.TrimSpace(threadID) == "" || strings.TrimSpace(turnID) == "" {
		return nil
	}
	_, err := b.store.MarkNativeHistoryCoverage(ctx, b.sessionID, NativeHistoryBoundaryEvidence{
		ThreadID: threadID,
		TurnID:   turnID,
		Boundary: boundary,
	})
	return err
}

// ForwardNotification 把 Codex 通知转换为 Canonical 事件并写入 Store（同时记录分支证据）。
func (b *CodexSessionEventBridge) ForwardNotification(
	ctx context.Context,
	msg CodexJSONRPCMessage,
	turnID, runID, runtimeScope string,
	toolOrder *CodexToolOrder,
	model string,
) CodexBridgeObservation {
	if msg.Params != nil && msg.Method == "item/completed" && model != "" {
		msg.Params = CloneMap(msg.Params)
		msg.Params["model"] = model
	}
	if toolOrder != nil && msg.Method == "rawResponseItem/completed" {
		toolOrder.ObserveRaw(msg)
	}
	b.recordNativeEvidence(ctx, msg)

	mapped := MapCodexAppServerMessage(msg, b.sessionID, b.onUnknownMethod)
	if mapped.Classification == "known_noop" {
		return CodexBridgeObservation{Mapped: mapped, ProviderTurnID: mapped.TurnID}
	}

	compaction := msg.Method == "thread/compacted"
	if compaction {
		b.resolveCompactionWaiters(asString(msg.Params["threadId"]), nil)
	}

	if mapped.Type == "stream.error" && compaction {
		b.resolveCompactionWaiters(asString(msg.Params["threadId"]), NewErrorWithMessage("codex_compaction_failed", http.StatusBadGateway, asString(mapped.Payload["message"]), nil))
	}

	if mapped.Type == "turn.metrics.updated" && mapped.Payload != nil {
		// Codex tokenUsage/updated 只在 totals 非空时带上 totals。
	}

	err := b.persistMapped(ctx, mapped, turnID, runID, runtimeScope, toolOrder)
	return CodexBridgeObservation{
		Mapped:         mapped,
		ProviderTurnID: mapped.TurnID,
		Compaction:     compaction,
		Err:            err,
	}
}

// ForwardServerRequest 处理服务端发起的双向请求（审批/提问/elicitation），校验重放门禁并写入 Store。
func (b *CodexSessionEventBridge) ForwardServerRequest(
	ctx context.Context,
	msg CodexJSONRPCMessage,
	turnID, runID, runtimeScope string,
) CodexBridgeObservation {
	mapped := MapCodexAppServerMessage(msg, b.sessionID, b.onUnknownMethod)
	if mapped.Type != "interaction.requested" || mapped.Envelope == nil {
		err := b.persistMapped(ctx, mapped, turnID, runID, runtimeScope, nil)
		return CodexBridgeObservation{Mapped: mapped, ProviderTurnID: mapped.TurnID, Err: err}
	}

	interaction, _ := mapped.Payload["interaction"].(map[string]any)
	interactionID := asString(interaction["interactionId"])
	b.mu.Lock()
	b.envelopes[interactionID] = mapped.Envelope
	b.mu.Unlock()

	replayed, replayErr := b.replayGate.Capture(interaction, mapped.Envelope)
	if replayErr != nil {
		return CodexBridgeObservation{Mapped: mapped, ProviderTurnID: mapped.TurnID, Err: replayErr}
	}
	if replayed {
		return CodexBridgeObservation{Mapped: mapped, ProviderTurnID: mapped.TurnID}
	}

	_, err := b.store.CreateInteraction(ctx, CreateInteractionInput{
		InteractionID: interactionID,
		SessionID:     b.sessionID,
		ItemID:        asString(interaction["itemId"]),
		Kind:          asString(interaction["kind"]),
		Revision:      1,
		Payload:       asMap(interaction["payload"]),
	})
	if err != nil {
		return CodexBridgeObservation{Mapped: mapped, ProviderTurnID: mapped.TurnID, Err: err}
	}
	if mapped.TurnID != "" || turnID != "" {
		effectiveTurnID := turnID
		if effectiveTurnID == "" {
			effectiveTurnID = mapped.TurnID
		}
		_, err = b.store.AppendEvent(ctx, b.sessionID, EventDraft{
			Type:   "interaction.requested",
			TurnID: effectiveTurnID,
			RunID:  runID,
			ItemID: asString(interaction["itemId"]),
			Source: b.eventSource(runtimeScope),
			Payload: map[string]any{
				"interaction": interaction,
			},
		})
	} else {
		_, err = b.store.AppendEvent(ctx, b.sessionID, EventDraft{
			Type:   "interaction.requested",
			RunID:  runID,
			ItemID: asString(interaction["itemId"]),
			Source: b.eventSource(runtimeScope),
			Payload: map[string]any{
				"interaction": interaction,
			},
		})
	}
	return CodexBridgeObservation{Mapped: mapped, ProviderTurnID: mapped.TurnID, Err: err}
}

func (b *CodexSessionEventBridge) recordNativeEvidence(ctx context.Context, msg CodexJSONRPCMessage) {
	if b.store == nil || msg.Params == nil {
		return
	}
	rawMsgID := b.userMessageLink.Observe(msg)
	threadID := strings.TrimSpace(asString(msg.Params["threadId"]))
	turnID := strings.TrimSpace(asString(msg.Params["turnId"]))
	switch msg.Method {
	case "rawResponseItem/completed":
		if item, ok := msg.Params["item"].(map[string]any); ok && threadID != "" && turnID != "" {
			_ = b.store.RecordNativeResponseItem(ctx, b.sessionID, NativeResponseItemEvidence{
				ThreadID: threadID,
				TurnID:   turnID,
				Item:     item,
			})
		}
	case "item/completed":
		if item, ok := msg.Params["item"].(map[string]any); ok && threadID != "" && turnID != "" {
			_ = b.store.Store().NativeThreadItems.Record(ctx, b.sessionID, NativeThreadItemEvidence{
				ThreadID:     threadID,
				TurnID:       turnID,
				Item:         item,
				RawMessageID: rawMsgID,
			})
		}
	case "turn/started":
		if turn, ok := msg.Params["turn"].(map[string]any); ok {
			tid := strings.TrimSpace(asString(turn["id"]))
			if tid != "" && threadID != "" {
				_ = b.MarkHistoryCoverage(ctx, threadID, tid, "gap")
			}
		}
	case "turn/completed":
		if turn, ok := msg.Params["turn"].(map[string]any); ok {
			tid := strings.TrimSpace(asString(turn["id"]))
			if tid != "" && threadID != "" && asString(turn["status"]) == "completed" {
				_ = b.MarkHistoryCoverage(ctx, threadID, tid, "complete")
			}
		}
	}
}

func (b *CodexSessionEventBridge) persistMapped(
	ctx context.Context,
	mapped CodexMappedMessage,
	turnID, runID, runtimeScope string,
	toolOrder *CodexToolOrder,
) error {
	if b.store == nil {
		return nil
	}
	// turn.completed / turn.failed / turn.interrupted / turn.started 由 TurnLifecycle 推进或直接结算，
	// 但 session.goal.* / timeline.item.* / turn.metrics.updated / stream.error / interaction.resolved 需要写入事件流。
	switch mapped.Type {
	case "", "turn.started", "turn.completed", "turn.failed", "turn.interrupted":
		return nil
	case "session.goal.updated":
		if goal, ok := mapped.Payload["goal"].(map[string]any); ok {
			_, err := b.store.SetGoal(ctx, b.sessionID, goal, "codex")
			return err
		}
		return nil
	case "session.goal.cleared":
		_, err := b.store.ClearGoal(ctx, b.sessionID)
		return err
	case "interaction.resolved":
		id := asString(mapped.Payload["interactionId"])
		b.RemoveEnvelope(id)
		_, err := b.store.AcknowledgeExternalInteraction(ctx, id)
		return err
	}

	emit := func() error {
		payload := mapped.Payload
		if item, ok := payload["item"].(map[string]any); ok && turnID != "" {
			cp := CloneMap(item)
			cp["turnId"] = turnID
			payload = CloneMap(payload)
			payload["item"] = cp
		}
		_, err := b.store.AppendEvent(ctx, b.sessionID, EventDraft{
			Type:    mapped.Type,
			TurnID:  turnID,
			RunID:   runID,
			ItemID:  mapped.ItemID,
			Source:  b.eventSource(runtimeScope),
			Payload: payload,
		})
		return err
	}

	if toolOrder != nil {
		if callID := canonicalOrderedCallID(mapped); callID != "" {
			return toolOrder.DispatchOrdered(callID, emit)
		}
	}
	return emit()
}

func canonicalOrderedCallID(mapped CodexMappedMessage) string {
	switch mapped.Type {
	case "timeline.item.started", "timeline.item.updated", "timeline.item.completed":
		if item, ok := mapped.Payload["item"].(map[string]any); ok {
			if detail, okD := item["detail"].(map[string]any); okD {
				if cid := strings.TrimSpace(asString(detail["callId"])); cid != "" {
					return cid
				}
			}
			return strings.TrimSpace(asString(item["id"]))
		}
	case "timeline.item.delta":
		return strings.TrimSpace(asString(mapped.ItemID))
	}
	return ""
}

func (b *CodexSessionEventBridge) eventSource(runtimeScope string) EventSource {
	scope := strings.TrimSpace(runtimeScope)
	if scope == "" {
		scope = "unbound"
	}
	return EventSource{
		Provider:  b.provider,
		RuntimeID: b.provider + ":" + scope,
	}
}

func asMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

// HydrateCodexHistoryResponse 当 thread/read 或 thread/resume 返回摘要或游标时翻页补全全部 turns。
func HydrateCodexHistoryResponse(ctx context.Context, client CodexRPCClient, response map[string]any, threadID string) (map[string]any, error) {
	if strings.TrimSpace(threadID) == "" {
		return nil, NewError("codex_history_thread_required", http.StatusInternalServerError, nil)
	}
	thread, _ := response["thread"].(map[string]any)
	if thread == nil {
		return nil, NewError("codex_history_response_invalid", http.StatusBadGateway, nil)
	}
	if asString(thread["id"]) != threadID {
		return nil, NewError("codex_history_thread_mismatch", http.StatusBadGateway, map[string]any{
			"actual":   asString(thread["id"]),
			"expected": threadID,
		})
	}
	if !codexNeedsPagedTurns(response, thread) {
		return response, nil
	}

	existing, _ := thread["turns"].([]any)
	turnCursor := firstNonEmpty(asString(response["turnsBackwardsCursor"]), asString(response["turns_backwards_cursor"]))
	itemCursor := firstNonEmpty(asString(response["itemsBackwardsCursor"]), asString(response["items_backwards_cursor"]))
	initialPage, _ := firstNonNil(response["initialTurnsPage"], response["initial_turns_page"]).(map[string]any)

	useBackwards := turnCursor != "" && itemCursor == "" && initialPage == nil && !anyPartialTurn(existing)
	sortDir := "asc"
	var startCursor string
	if useBackwards {
		sortDir = "desc"
		startCursor = turnCursor
	}
	pagedTurns, err := readPagedCodexTurns(ctx, client, threadID, startCursor, sortDir)
	if err != nil {
		return nil, err
	}

	byID := make(map[string]map[string]any, len(pagedTurns))
	order := make([]string, 0, len(pagedTurns))
	for _, pt := range pagedTurns {
		id := asString(pt["id"])
		byID[id] = pt
		order = append(order, id)
	}

	combined := append([]any(nil), existing...)
	if initialPage != nil {
		if initData, ok := initialPage["data"].([]any); ok {
			combined = append(combined, initData...)
		}
	}
	for _, rawTurn := range combined {
		tm, ok := rawTurn.(map[string]any)
		if !ok || strings.TrimSpace(asString(tm["id"])) == "" {
			return nil, NewError("codex_history_turn_invalid", http.StatusBadGateway, nil)
		}
		tid := asString(tm["id"])
		if paged, exists := byID[tid]; exists {
			if !isPartialCodexTurn(tm) {
				liveItems, _ := tm["items"].([]any)
				pagedItems, _ := paged["items"].([]any)
				merged := mergeLiveCodexItems(liveItems, pagedItems)
				cp := CloneMap(paged)
				cp["items"] = merged
				byID[tid] = cp
			}
			continue
		}
		if isPartialCodexTurn(tm) {
			return nil, NewError("codex_history_incomplete", http.StatusBadGateway, map[string]any{"nativeTurnId": tid})
		}
		if _, hasItems := tm["items"].([]any); !hasItems {
			return nil, NewError("codex_history_turn_invalid", http.StatusBadGateway, nil)
		}
		byID[tid] = tm
		order = append(order, tid)
	}

	finalTurns := make([]any, 0, len(order))
	for _, id := range order {
		finalTurns = append(finalTurns, byID[id])
	}
	outThread := CloneMap(thread)
	outThread["turns"] = finalTurns
	outResp := CloneMap(response)
	outResp["thread"] = outThread
	for _, k := range []string{"turnsBackwardsCursor", "turns_backwards_cursor", "itemsBackwardsCursor", "items_backwards_cursor", "initialTurnsPage", "initial_turns_page"} {
		delete(outResp, k)
	}
	return outResp, nil
}

func readPagedCodexTurns(ctx context.Context, client CodexRPCClient, threadID, cursor, sortDirection string) ([]map[string]any, error) {
	turns := make([]map[string]any, 0)
	seenCursors := make(map[string]struct{})
	seenTurns := make(map[string]struct{})
	cur := strings.TrimSpace(cursor)
	for pageNum := 0; pageNum < defaultMaxCodexHistoryPages; pageNum++ {
		if cur != "" {
			if _, dup := seenCursors[cur]; dup {
				return nil, NewError("codex_history_pagination_loop", http.StatusBadGateway, nil)
			}
			seenCursors[cur] = struct{}{}
		}
		params := map[string]any{
			"threadId":      threadID,
			"limit":         defaultCodexHistoryPageLimit,
			"sortDirection": sortDirection,
			"itemsView":     "full",
		}
		if cur != "" {
			params["cursor"] = cur
		}
		page, err := client.Request(ctx, "thread/turns/list", params)
		if err != nil {
			return nil, err
		}
		data, ok := page["data"].([]any)
		if !ok {
			return nil, NewError("codex_history_page_invalid", http.StatusBadGateway, nil)
		}
		for _, rawTurn := range data {
			tm, okT := rawTurn.(map[string]any)
			tid := strings.TrimSpace(asString(tm["id"]))
			if !okT || tid == "" {
				return nil, NewError("codex_history_turn_invalid", http.StatusBadGateway, nil)
			}
			if _, okI := tm["items"].([]any); !okI || isPartialCodexTurn(tm) {
				return nil, NewError("codex_history_incomplete", http.StatusBadGateway, map[string]any{"nativeTurnId": tid})
			}
			if _, dup := seenTurns[tid]; dup {
				return nil, NewError("codex_history_turn_duplicate", http.StatusBadGateway, nil)
			}
			seenTurns[tid] = struct{}{}
			turns = append(turns, tm)
		}
		next := firstNonEmpty(asString(page["nextCursor"]), asString(page["next_cursor"]))
		if next == "" {
			if sortDirection == "desc" {
				for i, j := 0, len(turns)-1; i < j; i, j = i+1, j-1 {
					turns[i], turns[j] = turns[j], turns[i]
				}
			}
			return turns, nil
		}
		cur = next
	}
	return nil, NewError("codex_history_pagination_limit", http.StatusBadGateway, map[string]any{"maxPages": defaultMaxCodexHistoryPages})
}

func codexNeedsPagedTurns(resp, thread map[string]any) bool {
	if resp == nil || thread == nil {
		return true
	}
	turns, ok := thread["turns"].([]any)
	if !ok {
		return true
	}
	for _, k := range []string{"turnsBackwardsCursor", "turns_backwards_cursor", "itemsBackwardsCursor", "items_backwards_cursor", "initialTurnsPage", "initial_turns_page"} {
		if resp[k] != nil && resp[k] != "" {
			return true
		}
	}
	return anyPartialTurn(turns)
}

func anyPartialTurn(turns []any) bool {
	for _, raw := range turns {
		if m, ok := raw.(map[string]any); ok && isPartialCodexTurn(m) {
			return true
		}
	}
	return false
}

func isPartialCodexTurn(turn map[string]any) bool {
	view := firstNonEmpty(asString(turn["itemsView"]), asString(turn["items_view"]))
	return view != "" && view != "full"
}

func mergeLiveCodexItems(live, paged []any) []any {
	pageKeys := make(map[string]struct{}, len(paged))
	for _, entry := range paged {
		if m, ok := entry.(map[string]any); ok {
			pageKeys[codexHistoryItemKey(m)] = struct{}{}
		}
	}
	before := make(map[string][]any)
	anchor := "__TAIL__"
	for i := len(live) - 1; i >= 0; i-- {
		m, ok := live[i].(map[string]any)
		if !ok {
			continue
		}
		key := codexHistoryItemKey(m)
		if _, exists := pageKeys[key]; exists {
			anchor = key
			continue
		}
		before[anchor] = append(before[anchor], m)
	}
	reverseSlice := func(s []any) []any {
		out := make([]any, len(s))
		for i := range s {
			out[i] = s[len(s)-1-i]
		}
		return out
	}
	merged := make([]any, 0, len(paged)+len(live))
	for _, entry := range paged {
		m, ok := entry.(map[string]any)
		if ok {
			k := codexHistoryItemKey(m)
			merged = append(merged, reverseSlice(before[k])...)
		}
		merged = append(merged, entry)
	}
	merged = append(merged, reverseSlice(before["__TAIL__"])...)
	return merged
}

func codexHistoryItemKey(item map[string]any) string {
	id := strings.TrimSpace(asString(item["id"]))
	if asString(item["type"]) == "userMessage" {
		if cid := strings.TrimSpace(asString(item["clientId"])); cid != "" {
			return "user:" + cid
		}
	}
	return "item:" + id
}

// ProjectCodexSessionHistory 将完整的 Codex thread turns 投影为 Canonical ImportTimeline 草案事件。
func ProjectCodexSessionHistory(resp map[string]any, threadID, runtimeID string) ([]EventDraft, error) {
	thread, _ := resp["thread"].(map[string]any)
	if thread == nil {
		return nil, nil
	}
	rawTurns, _ := thread["turns"].([]any)
	drafts := make([]EventDraft, 0)
	for _, rawTurn := range rawTurns {
		turn, okT := rawTurn.(map[string]any)
		if !okT {
			continue
		}
		tid := strings.TrimSpace(asString(turn["id"]))
		turnStatus := asString(turn["status"])
		items, _ := turn["items"].([]any)
		for _, rawItem := range items {
			im, okI := rawItem.(map[string]any)
			if !okI {
				continue
			}
			itemID := strings.TrimSpace(asString(im["id"]))
			if itemID == "" {
				continue
			}
			completed := turnStatus != "inProgress" || asString(im["status"]) != "inProgress"
			tlItem := BuildCodexTimelineItem(im, map[string]any{}, completed)
			if tid != "" {
				tlItem["turnId"] = tid
			}
			sum := sha256.Sum256([]byte("codex:" + threadID + ":" + tid + ":" + itemID))
			evType := "timeline.item.started"
			if completed {
				evType = "timeline.item.completed"
			}
			drafts = append(drafts, EventDraft{
				EventID: "codex-hist-" + hex.EncodeToString(sum[:])[:24],
				Type:    evType,
				TurnID:  tid,
				ItemID:  itemID,
				Source: EventSource{
					Provider:  "codex",
					RuntimeID: firstNonEmptyStr(runtimeID, "codex:history"),
				},
				Payload: map[string]any{"item": tlItem},
			})
		}
	}
	return drafts, nil
}

// CodexSessionHistorySync 协调按 threadId 单飞同步 Codex 历史进 Canonical 时间线。
type CodexSessionHistorySync struct {
	client    CodexRPCClient
	store     *PublishingStore
	sessionID string
	threadFn  func() string
	runtimeID string

	mu       sync.Mutex
	inFlight map[string]chan error
}

// NewCodexSessionHistorySync 构造 Codex 历史同步器。
func NewCodexSessionHistorySync(client CodexRPCClient, store *PublishingStore, sessionID, runtimeID string, threadFn func() string) *CodexSessionEventBridgeSync {
	return &CodexSessionEventBridgeSync{
		CodexSessionHistorySync: &CodexSessionHistorySync{
			client:    client,
			store:     store,
			sessionID: sessionID,
			threadFn:  threadFn,
			runtimeID: runtimeID,
			inFlight:  make(map[string]chan error),
		},
	}
}

// CodexSessionEventBridgeSync 为历史同步保留简洁公开包装类型。
type CodexSessionEventBridgeSync struct {
	*CodexSessionHistorySync
}

// Run 执行或合并正在进行的 thread/read 历史导入。
func (h *CodexSessionHistorySync) Run(ctx context.Context) error {
	if h == nil || h.client == nil || h.store == nil || h.threadFn == nil {
		return nil
	}
	threadID := strings.TrimSpace(h.threadFn())
	if threadID == "" {
		return nil
	}
	h.mu.Lock()
	if ch := h.inFlight[threadID]; ch != nil {
		h.mu.Unlock()
		<-ch
		return nil
	}
	ch := make(chan error, 1)
	h.inFlight[threadID] = ch
	h.mu.Unlock()

	err := h.synchronize(ctx, threadID)
	h.mu.Lock()
	delete(h.inFlight, threadID)
	h.mu.Unlock()
	ch <- err
	close(ch)
	return err
}

func (h *CodexSessionHistorySync) synchronize(ctx context.Context, threadID string) error {
	raw, err := h.client.Request(ctx, "thread/read", map[string]any{
		"threadId":     threadID,
		"includeTurns": true,
	})
	if err != nil {
		return err
	}
	hydrated, err := HydrateCodexHistoryResponse(ctx, h.client, raw, threadID)
	if err != nil {
		return err
	}
	drafts, err := ProjectCodexSessionHistory(hydrated, threadID, h.runtimeID)
	if err != nil || len(drafts) == 0 {
		return err
	}
	_, err = h.store.ImportTimeline(ctx, h.sessionID, drafts)
	return err
}

// ImportRecovered 在重连/重启恢复期直接把 thread/resume 响应补全后导入时间线。
func (h *CodexSessionHistorySync) ImportRecovered(ctx context.Context, response map[string]any, threadID string) error {
	if h == nil || h.store == nil || response == nil || strings.TrimSpace(threadID) == "" {
		return nil
	}
	hydrated, err := HydrateCodexHistoryResponse(ctx, h.client, response, threadID)
	if err != nil {
		return err
	}
	drafts, err := ProjectCodexSessionHistory(hydrated, threadID, h.runtimeID)
	if err != nil || len(drafts) == 0 {
		return err
	}
	_, err = h.store.ImportTimeline(ctx, h.sessionID, drafts)
	return err
}

// ReadCodexHistorySeed 读取原生线程或祖先种子并按目标模型上下文预算裁剪。
func ReadCodexHistorySeed(
	ctx context.Context,
	client CodexRPCClient,
	threadID string,
	excludeTurnID string,
	contextWindow int,
	percent int,
	initialHistory []map[string]any,
	readNativeItem func(itemID string) (map[string]any, error),
) ([]map[string]any, error) {
	raw, err := client.Request(ctx, "thread/read", map[string]any{
		"threadId":     threadID,
		"includeTurns": true,
	})
	if err != nil {
		return nil, err
	}
	hydrated, err := HydrateCodexHistoryResponse(ctx, client, raw, threadID)
	if err != nil {
		return nil, err
	}
	thread, _ := hydrated["thread"].(map[string]any)
	rawTurns, _ := thread["turns"].([]any)

	items := make([]map[string]any, 0, len(initialHistory))
	ids := make(map[string]struct{})
	for _, ih := range initialHistory {
		items = append(items, CloneMap(ih))
		if id := strings.TrimSpace(asString(ih["id"])); id != "" {
			ids[id] = struct{}{}
		}
	}
	for _, rt := range rawTurns {
		tm, ok := rt.(map[string]any)
		if !ok || asString(tm["id"]) == excludeTurnID {
			continue
		}
		turnItems, _ := tm["items"].([]any)
		for _, ri := range turnItems {
			im, okI := ri.(map[string]any)
			if !okI {
				continue
			}
			iid := asString(im["id"])
			if iid != "" {
				if _, seen := ids[iid]; seen {
					continue
				}
			}
			converted, err := codexSeedResponseItem(im, readNativeItem)
			if err != nil {
				return nil, err
			}
			items = append(items, converted)
			if iid != "" {
				ids[iid] = struct{}{}
			}
		}
	}
	budgeted := BudgetHistoryItems(items, contextWindow, percent)
	return budgeted.Items, nil
}

func codexSeedResponseItem(item map[string]any, readNativeItem func(string) (map[string]any, error)) (map[string]any, error) {
	itemType := asString(item["type"])
	itemID := asString(item["id"])
	switch itemType {
	case "agentMessage":
		if text, ok := item["text"].(string); ok {
			out := map[string]any{
				"id":      itemID,
				"type":    "message",
				"role":    "assistant",
				"content": []map[string]any{{"type": "output_text", "text": text}},
			}
			if phase := strings.TrimSpace(asString(item["phase"])); phase != "" {
				out["phase"] = phase
			}
			return out, nil
		}
	case "userMessage":
		if rawContent, ok := item["content"].([]any); ok {
			parts := make([]map[string]any, 0, len(rawContent))
			for _, rc := range rawContent {
				pm, _ := rc.(map[string]any)
				part, err := codexSeedInputItem(pm)
				if err != nil {
					return nil, err
				}
				parts = append(parts, part)
			}
			return map[string]any{
				"id":      itemID,
				"type":    "message",
				"role":    "user",
				"content": parts,
			}, nil
		}
	case "reasoning":
		if readNativeItem != nil {
			raw, err := readNativeItem(itemID)
			if err == nil && raw != nil && asString(raw["type"]) == "reasoning" && asString(raw["id"]) == itemID {
				return raw, nil
			}
		}
	}
	return nil, NewError("codex_history_seed_unsupported", http.StatusUnprocessableEntity, map[string]any{"itemType": itemType, "itemId": itemID})
}

func codexSeedInputItem(pm map[string]any) (map[string]any, error) {
	pt := asString(pm["type"])
	if pt == "text" {
		if text, ok := pm["text"].(string); ok {
			return map[string]any{"type": "input_text", "text": text}, nil
		}
	}
	if pt == "image" {
		if u, ok := pm["url"].(string); ok {
			out := map[string]any{"type": "input_image", "image_url": u}
			if d := pm["detail"]; d != nil {
				out["detail"] = d
			}
			return out, nil
		}
	}
	if pt == "localImage" {
		if p, ok := pm["path"].(string); ok {
			mime := GuessImageMimeType(p)
			if mime != "" {
				raw, err := os.ReadFile(p)
				if err == nil {
					out := map[string]any{
						"type":      "input_image",
						"image_url": "data:" + mime + ";base64," + base64.StdEncoding.EncodeToString(raw),
					}
					if d := pm["detail"]; d != nil {
						out["detail"] = d
					}
					return out, nil
				}
			}
		}
	}
	return nil, NewError("codex_history_seed_input_unsupported", http.StatusUnprocessableEntity, map[string]any{"inputType": pt})
}

// CodexWorkBranch 实现 Codex work 会话的分支规划与原生 fork/inject 持久化端口。
type CodexWorkBranch struct {
	client      CodexRPCClient
	store       *PublishingStore
	sessionID   string
	getThreadID func() string
	getPolicy   func() map[string]any
}

// Plan 生成单次分支或重生成所需的截断计划。
func (w *CodexWorkBranch) Plan(ctx context.Context, sess *Session, cmd *Command) (map[string]any, error) {
	if w.client == nil || w.store == nil {
		return nil, NewError("chat_branch_mode_unsupported", http.StatusUnprocessableEntity, nil)
	}
	threadID := strings.TrimSpace(w.getThreadID())
	if threadID == "" && sess != nil {
		threadID = strings.TrimSpace(asString(sess.RuntimeBinding["nativeSessionId"]))
	}
	if threadID == "" {
		return nil, NewError("codex_native_session_missing", http.StatusConflict, nil)
	}
	capture, err := w.store.Store().WorkBranches.Capture(ctx, cmd)
	if err != nil {
		return nil, err
	}
	rawResp, err := w.client.Request(ctx, "thread/read", map[string]any{
		"threadId":     threadID,
		"includeTurns": true,
	})
	if err != nil {
		return nil, err
	}
	hydrated, err := HydrateCodexHistoryResponse(ctx, w.client, rawResp, threadID)
	if err != nil {
		return nil, err
	}
	thread, _ := hydrated["thread"].(map[string]any)
	turnsRaw, _ := thread["turns"].([]any)

	var retained []map[string]any
	nativeIDs := make(map[string]struct{})
	for _, rt := range turnsRaw {
		if tm, ok := rt.(map[string]any); ok && !isDiscardedBranchTurn(tm) {
			retained = append(retained, tm)
			if id := asString(tm["id"]); id != "" {
				nativeIDs[id] = struct{}{}
			}
		}
	}

	parentSeed, _ := w.store.ReadHistorySeed(ctx, sess.SessionID)
	anchorItemID := capture.AnchorItemID
	excludeMsg := cmd.Type == "turn.regenerate"

	var targetTurn map[string]any
	var targetIdx int
	var targetItem map[string]any
	matchCount := 0
	for _, tm := range retained {
		turnID := asString(tm["id"])
		items, _ := tm["items"].([]any)
		for idx, ri := range items {
			im, ok := ri.(map[string]any)
			if ok && asString(im["id"]) == anchorItemID {
				matchCount++
				targetTurn = tm
				targetIdx = idx
				targetItem = im
			}
		}
		if matchCount == 0 && turnID != "" {
			recs, _ := w.store.Store().NativeThreadItems.ReadTurn(ctx, sess.SessionID, threadID, turnID)
			for _, rec := range recs {
				if asString(rec.Item["id"]) == anchorItemID {
					matchCount++
					targetTurn = tm
					targetItem = rec.Item
				}
			}
		}
	}
	if matchCount != 1 || targetTurn == nil {
		return nil, NewError("codex_fork_message_identity_unavailable", http.StatusConflict, nil)
	}
	if asString(targetTurn["status"]) != "completed" {
		return nil, NewError("codex_fork_turn_not_completed", http.StatusConflict, nil)
	}
	itemType := asString(targetItem["type"])
	if itemType != "agentMessage" && itemType != "userMessage" {
		return nil, NewError("codex_fork_message_required", http.StatusUnprocessableEntity, nil)
	}

	targetTurnID := asString(targetTurn["id"])
	coverage, _ := w.store.Store().NativeResponseItems.Coverage(ctx, sess.SessionID, threadID, targetTurnID)
	rawTurn, _ := w.store.Store().NativeResponseItems.ReadTurn(ctx, sess.SessionID, threadID, targetTurnID)
	var diskLinks map[string]string
	if coverage != "complete" {
		if pathStr := strings.TrimSpace(asString(thread["path"])); pathStr != "" {
			if home, ok := w.client.GetVerifiedRuntimeHome(); ok {
				diskItems, links, diskErr := readCodexRolloutTurn(home.CodexHome, pathStr, threadID, targetTurnID)
				if diskErr == nil {
					rawTurn = diskItems
					diskLinks = links
					coverage = "complete"
				}
			}
		}
	}
	if coverage != "complete" || len(rawTurn) == 0 {
		return nil, NewError("codex_fork_raw_history_incomplete", http.StatusConflict, nil)
	}

	rawMsgID := ""
	threadItems, _ := w.store.Store().NativeThreadItems.ReadTurn(ctx, sess.SessionID, threadID, targetTurnID)
	for _, rec := range threadItems {
		if asString(rec.Item["id"]) == anchorItemID {
			rawMsgID = rec.RawMessageID
			break
		}
	}
	if rawMsgID == "" && diskLinks != nil {
		rawMsgID = diskLinks[anchorItemID]
	}
	lookupRawID := firstNonEmptyStr(rawMsgID, anchorItemID)

	rawMatches := make([]int, 0, 1)
	for i, ri := range rawTurn {
		if asString(ri["id"]) == lookupRawID {
			rawMatches = append(rawMatches, i)
		}
	}
	if len(rawMatches) != 1 {
		return nil, NewError("codex_fork_raw_message_identity_unavailable", http.StatusConflict, nil)
	}
	cut := rawMatches[0]
	rawTarget := rawTurn[cut]
	wantRole := "user"
	if itemType == "agentMessage" {
		wantRole = "assistant"
	}
	if asString(rawTarget["type"]) != "message" || asString(rawTarget["role"]) != wantRole {
		return nil, NewError("codex_fork_raw_message_identity_unavailable", http.StatusConflict, nil)
	}

	sliceEnd := cut + 1
	if excludeMsg {
		sliceEnd = cut
	}
	prefixItems := make([]map[string]any, 0, sliceEnd)
	for i := 0; i < sliceEnd; i++ {
		prefixItems = append(prefixItems, CloneMap(rawTurn[i]))
	}

	turnItems, _ := targetTurn["items"].([]any)
	plan := map[string]any{
		"threadId":     threadID,
		"sourceItemId": asString(cmd.Payload["sourceItemId"]),
		"projection": map[string]any{
			"anchorItemId": anchorItemID,
		},
	}
	if !excludeMsg && itemType == "agentMessage" && targetIdx == len(turnItems)-1 && cut == len(rawTurn)-1 {
		plan["lastTurnId"] = targetTurnID
		plan["items"] = []map[string]any{}
	} else {
		plan["beforeTurnId"] = targetTurnID
		plan["items"] = prefixItems
	}
	_ = nativeIDs
	_ = parentSeed
	return plan, nil
}

// Native 返回用于实际执行 thread/fork 与 thread/inject_items 的端口。
func (w *CodexWorkBranch) Native() NativeBranchPort {
	model := ""
	if w.getPolicy != nil {
		model = strings.TrimSpace(asString(w.getPolicy()["model"]))
	}
	return &codexBranchOperationPort{
		client: w.client,
		model:  model,
	}
}

type codexBranchOperationPort struct {
	client CodexRPCClient
	model  string
}

func (p *codexBranchOperationPort) Fork(ctx context.Context, op *BranchOperation) (map[string]any, error) {
	if op == nil || op.Plan == nil {
		return nil, NewError("codex_fork_boundary_required", http.StatusUnprocessableEntity, nil)
	}
	lastTurnID := strings.TrimSpace(asString(op.Plan["lastTurnId"]))
	beforeTurnID := strings.TrimSpace(asString(op.Plan["beforeTurnId"]))
	if (lastTurnID != "") == (beforeTurnID != "") {
		return nil, NewError("codex_fork_boundary_required", http.StatusUnprocessableEntity, nil)
	}
	forkThreadID := firstNonEmptyStr(strings.TrimSpace(asString(op.Plan["forkThreadId"])), op.SourceThreadID)
	threadSource := fmt.Sprintf("aih:branch:%s:%s", op.SessionID, op.CommandID)
	params := map[string]any{
		"threadId":              forkThreadID,
		"excludeTurns":          true,
		"deferGoalContinuation": true,
		"threadSource":          threadSource,
	}
	if lastTurnID != "" {
		params["lastTurnId"] = lastTurnID
	} else {
		params["beforeTurnId"] = beforeTurnID
	}
	if p.model != "" {
		params["model"] = p.model
	}
	resp, err := p.client.Request(ctx, "thread/fork", ApplyCodexNativeHistoryPolicy(params))
	if err != nil {
		return nil, err
	}
	thread, _ := resp["thread"].(map[string]any)
	newThreadID := strings.TrimSpace(asString(thread["id"]))
	if newThreadID == "" || newThreadID == op.SourceThreadID {
		return nil, NewError("codex_fork_receipt_identity_conflict", http.StatusConflict, nil)
	}
	receipt := map[string]any{
		"threadId":       newThreadID,
		"sourceThreadId": op.SourceThreadID,
		"threadSource":   threadSource,
	}
	if fpid := strings.TrimSpace(asString(op.Plan["forkThreadId"])); fpid != "" {
		receipt["forkParentThreadId"] = fpid
	}
	return receipt, nil
}

func (p *codexBranchOperationPort) RecoverFork(_ context.Context, _ *BranchOperation) (map[string]any, error) {
	return nil, nil
}

func (p *codexBranchOperationPort) Inject(ctx context.Context, op *BranchOperation) error {
	if op == nil || op.Receipt == nil {
		return NewError("codex_fork_receipt_identity_conflict", http.StatusConflict, nil)
	}
	childThreadID := strings.TrimSpace(asString(op.Receipt["threadId"]))
	params := map[string]any{
		"threadId":     childThreadID,
		"excludeTurns": true,
	}
	if p.model != "" {
		params["model"] = p.model
	}
	resp, err := p.client.Request(ctx, "thread/resume", ApplyCodexNativeHistoryPolicy(params))
	if err != nil {
		return err
	}
	thread, _ := resp["thread"].(map[string]any)
	if strings.TrimSpace(asString(thread["id"])) != childThreadID {
		return NewError("codex_fork_receipt_identity_conflict", http.StatusConflict, nil)
	}
	if status, _ := thread["status"].(map[string]any); asString(status["type"]) == "active" {
		return NewError("codex_fork_child_busy", http.StatusConflict, nil)
	}
	_, err = p.client.Request(ctx, "thread/inject_items", map[string]any{
		"threadId": childThreadID,
		"items":    op.Plan["items"],
	})
	return err
}

func (p *codexBranchOperationPort) RecoverInjection(_ context.Context, _ *BranchOperation) (string, error) {
	return "unknown", nil
}

func isDiscardedBranchTurn(turn map[string]any) bool {
	if turn == nil {
		return true
	}
	status := strings.ToLower(strings.TrimSpace(asString(turn["status"])))
	status = strings.NewReplacer(" ", "_", "-", "_").Replace(status)
	switch status {
	case "stale", "rollback", "rolled_back", "rolledback", "reverted", "reversed", "superseded":
		return true
	}
	return turn["stale"] == true || turn["rollback"] == true || turn["rolledBack"] == true ||
		turn["rolled_back"] == true || turn["superseded"] == true
}

func readCodexRolloutTurn(codexHome, rolloutPath, threadID, turnID string) ([]map[string]any, map[string]string, error) {
	realHome, err := filepath.EvalSymlinks(codexHome)
	if err != nil || strings.TrimSpace(realHome) == "" {
		return nil, nil, NewError("codex_rollout_turn_evidence_unavailable", http.StatusConflict, nil)
	}
	realPath, err := filepath.EvalSymlinks(rolloutPath)
	if err != nil || !strings.HasPrefix(realPath, realHome+string(os.PathSeparator)) {
		return nil, nil, NewError("codex_rollout_turn_evidence_unavailable", http.StatusConflict, nil)
	}
	f, err := os.Open(realPath)
	if err != nil {
		return nil, nil, NewError("codex_rollout_turn_evidence_unavailable", http.StatusConflict, nil)
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	header := true
	started := false
	completed := false
	var items []map[string]any
	ids := make(map[string]struct{})
	links := make(map[string]string)
	linker := &CodexUserMessageLink{}

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var rec map[string]any
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			return nil, nil, NewError("codex_rollout_turn_evidence_unavailable", http.StatusConflict, nil)
		}
		recType := asString(rec["type"])
		payload, _ := rec["payload"].(map[string]any)
		if header {
			header = false
			if recType != "session_meta" || asString(payload["id"]) != threadID {
				return nil, nil, NewError("codex_rollout_turn_evidence_unavailable", http.StatusConflict, nil)
			}
			continue
		}
		if recType == "event_msg" && asString(payload["type"]) == "thread_rolled_back" {
			return nil, nil, NewError("codex_rollout_turn_evidence_unavailable", http.StatusConflict, nil)
		}
		if recType == "event_msg" && asString(payload["type"]) == "task_started" && asString(payload["turn_id"]) == turnID {
			if started {
				return nil, nil, NewError("codex_rollout_turn_evidence_unavailable", http.StatusConflict, nil)
			}
			started = true
			continue
		}
		if !started || completed {
			continue
		}
		if recType == "event_msg" && asString(payload["type"]) == "task_started" {
			return nil, nil, NewError("codex_rollout_turn_evidence_unavailable", http.StatusConflict, nil)
		}
		if recType == "event_msg" && asString(payload["type"]) == "task_complete" && asString(payload["turn_id"]) == turnID {
			completed = true
			continue
		}
		if recType == "compacted" {
			return nil, nil, NewError("codex_rollout_turn_evidence_unavailable", http.StatusConflict, nil)
		}
		if recType == "response_item" {
			pid := asString(payload["id"])
			if pid == "" {
				return nil, nil, NewError("codex_rollout_turn_evidence_unavailable", http.StatusConflict, nil)
			}
			if _, dup := ids[pid]; dup {
				return nil, nil, NewError("codex_rollout_turn_evidence_unavailable", http.StatusConflict, nil)
			}
			ids[pid] = struct{}{}
			items = append(items, payload)
			linker.Observe(CodexJSONRPCMessage{
				Method: "rawResponseItem/completed",
				Params: map[string]any{"threadId": threadID, "turnId": turnID, "item": payload},
			})
		} else if recType == "event_msg" && asString(payload["type"]) == "item_completed" && asString(payload["turn_id"]) == turnID {
			if um, ok := payload["item"].(map[string]any); ok && asString(um["type"]) == "UserMessage" {
				copied := CloneMap(um)
				copied["type"] = "userMessage"
				rawID := linker.Observe(CodexJSONRPCMessage{
					Method: "item/started",
					Params: map[string]any{"threadId": threadID, "turnId": turnID, "item": copied},
				})
				if rawID != "" {
					links[asString(um["id"])] = rawID
				}
			}
		}
	}
	if !started || !completed || len(items) == 0 {
		return nil, nil, NewError("codex_rollout_turn_evidence_unavailable", http.StatusConflict, nil)
	}
	return items, links, nil
}

// CodexSessionGoalSync 同步当前绑定原生线程上的目标进度与状态。
type CodexSessionGoalSync struct {
	client    CodexRPCClient
	store     *PublishingStore
	sessionID string
	bridge    *CodexSessionEventBridge
	runtimeID string
}

// Refresh 从常驻 app-server 主动拉取一次 thread/goal/get（不可用时按空目标清理）。
func (g *CodexSessionGoalSync) Refresh(ctx context.Context, threadID, turnID, runID, runtimeScope string) error {
	if g == nil || g.client == nil || strings.TrimSpace(threadID) == "" {
		return nil
	}
	resp, err := g.client.Request(ctx, "thread/goal/get", map[string]any{"threadId": threadID})
	if err != nil {
		return nil
	}
	if goal, ok := resp["goal"].(map[string]any); ok && len(goal) > 0 {
		_ = g.bridge.ForwardNotification(ctx, CodexJSONRPCMessage{
			Method: "thread/goal/updated",
			Params: map[string]any{"threadId": threadID, "turnId": turnID, "goal": goal},
		}, turnID, runID, runtimeScope, nil, "")
	}
	return nil
}

// CodexModelEntry 描述 app-server model/list 返回的单条原生模型元数据。
type CodexModelEntry struct {
	Model                    string   `json:"model"`
	DisplayName              string   `json:"displayName"`
	IsDefault                bool     `json:"isDefault"`
	SupportedReasoningEffort []string `json:"supportedReasoningEfforts"`
	DefaultReasoningEffort   string   `json:"defaultReasoningEffort"`
}

// CodexNativeModelCatalog 管理按 client 共享缓存的 model/list 与思考档位解析。
type CodexNativeModelCatalog struct {
	client         CodexRPCClient
	isModelEnabled func(model string) bool

	mu     sync.Mutex
	cached []CodexModelEntry
}

// NewCodexNativeModelCatalog 构造 Codex 原生模型目录读取器。
func NewCodexNativeModelCatalog(client CodexRPCClient, isModelEnabled func(string) bool) *CodexNativeModelCatalog {
	return &CodexNativeModelCatalog{
		client:         client,
		isModelEnabled: isModelEnabled,
	}
}

// Prewarm 建连并预加载模型列表。
func (c *CodexNativeModelCatalog) Prewarm(ctx context.Context) error {
	if err := c.client.EnsureConnected(ctx); err != nil {
		return err
	}
	if err := requireVerifiedExecutionCredential(c.client.GetVerifiedAccountIdentity()); err != nil {
		return err
	}
	_, err := c.loadCatalog(ctx)
	return err
}

// ReadComposerCatalog 返回对齐 composer/catalog HTTP 接口的模型目录载荷。
func (c *CodexNativeModelCatalog) ReadComposerCatalog(ctx context.Context) (map[string]any, error) {
	entries, err := c.enabledCatalog(ctx)
	if err != nil {
		return nil, err
	}
	models := make([]ComposerModelEntry, 0, len(entries))
	defaultModel := ""
	for _, entry := range entries {
		if entry.IsDefault && defaultModel == "" {
			defaultModel = entry.Model
		}
		label := entry.DisplayName
		if label == "" {
			label = entry.Model
		}
		models = append(models, ComposerModelEntry{
			ID:               entry.Model,
			Label:            label,
			SupportedEfforts: append([]string(nil), entry.SupportedReasoningEffort...),
			DefaultEffort:    entry.DefaultReasoningEffort,
		})
	}
	if defaultModel == "" && len(models) > 0 {
		defaultModel = models[0].ID
	}
	return map[string]any{
		"models":       models,
		"defaultModel": defaultModel,
	}, nil
}

// ResolveTurnSettings 根据请求与策略选择合法的 model 与对齐后的 reasoningEffort。
func (c *CodexNativeModelCatalog) ResolveTurnSettings(ctx context.Context, requestedModel, requestedEffort string) (TurnModelSettings, error) {
	catalog, err := c.enabledCatalog(ctx)
	if err != nil {
		return TurnModelSettings{}, err
	}
	reqModel := strings.TrimSpace(requestedModel)
	var chosen *CodexModelEntry
	for i := range catalog {
		if reqModel != "" && catalog[i].Model == reqModel {
			chosen = &catalog[i]
			break
		}
	}
	if len(catalog) == 0 || (reqModel != "" && chosen == nil) {
		avail := make([]string, 0, len(catalog))
		for _, entry := range catalog {
			avail = append(avail, entry.Model)
		}
		return TurnModelSettings{}, NewError("codex_native_model_unavailable", http.StatusUnprocessableEntity, map[string]any{
			"model":           reqModel,
			"availableModels": avail,
		})
	}
	if chosen == nil {
		for i := range catalog {
			if catalog[i].IsDefault {
				chosen = &catalog[i]
				break
			}
		}
		if chosen == nil {
			chosen = &catalog[0]
		}
	}

	reqEff := strings.ToLower(strings.TrimSpace(requestedEffort))
	var ladder []inference.ReasoningEffort
	for _, e := range chosen.SupportedReasoningEffort {
		ladder = append(ladder, inference.ReasoningEffort(e))
	}
	finalEff := chosen.DefaultReasoningEffort
	if len(ladder) == 0 {
		finalEff = ""
	} else if reqEff != "" {
		if aligned, ok := inference.AlignReasoningEffort(inference.ReasoningEffort(reqEff), nil, ladder); ok {
			finalEff = string(aligned)
		} else {
			return TurnModelSettings{}, NewError("codex_native_reasoning_effort_unsupported", http.StatusUnprocessableEntity, map[string]any{
				"model":                     chosen.Model,
				"reasoningEffort":           reqEff,
				"supportedReasoningEfforts": chosen.SupportedReasoningEffort,
			})
		}
	}
	return TurnModelSettings{
		Model:           chosen.Model,
		ReasoningEffort: finalEff,
	}, nil
}

func (c *CodexNativeModelCatalog) enabledCatalog(ctx context.Context) ([]CodexModelEntry, error) {
	if err := c.client.EnsureConnected(ctx); err != nil {
		return nil, err
	}
	if err := requireVerifiedExecutionCredential(c.client.GetVerifiedAccountIdentity()); err != nil {
		return nil, err
	}
	all, err := c.loadCatalog(ctx)
	if err != nil {
		return nil, err
	}
	if c.isModelEnabled == nil {
		return all, nil
	}
	out := make([]CodexModelEntry, 0, len(all))
	for _, entry := range all {
		if c.isModelEnabled(entry.Model) {
			out = append(out, entry)
		}
	}
	return out, nil
}

func (c *CodexNativeModelCatalog) loadCatalog(ctx context.Context) ([]CodexModelEntry, error) {
	c.mu.Lock()
	if len(c.cached) > 0 {
		out := append([]CodexModelEntry(nil), c.cached...)
		c.mu.Unlock()
		return out, nil
	}
	c.mu.Unlock()

	resp, err := c.client.Request(ctx, "model/list", map[string]any{"includeHidden": false})
	if err != nil {
		return nil, err
	}
	data, _ := resp["data"].([]any)
	entries := make([]CodexModelEntry, 0, len(data))
	for _, raw := range data {
		m, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		modelName := strings.TrimSpace(asString(m["model"]))
		if modelName == "" {
			continue
		}
		var efforts []string
		if rawEffs, okE := m["supportedReasoningEfforts"].([]any); okE {
			for _, re := range rawEffs {
				if rm, okRM := re.(map[string]any); okRM {
					if eff := strings.ToLower(strings.TrimSpace(asString(rm["reasoningEffort"]))); eff != "" {
						efforts = append(efforts, eff)
					}
				}
			}
		}
		defEff := strings.ToLower(strings.TrimSpace(asString(m["defaultReasoningEffort"])))
		if defEff == "" {
			return nil, NewError("codex_native_model_catalog_invalid", http.StatusBadGateway, map[string]any{"model": modelName, "field": "defaultReasoningEffort"})
		}
		display := firstNonEmptyStr(strings.TrimSpace(asString(m["displayName"])), strings.TrimSpace(asString(m["name"])), modelName)
		entries = append(entries, CodexModelEntry{
			Model:                    modelName,
			DisplayName:              display,
			IsDefault:                m["isDefault"] == true,
			SupportedReasoningEffort: efforts,
			DefaultReasoningEffort:   defEff,
		})
	}
	if len(entries) == 0 {
		return nil, NewError("codex_native_model_catalog_empty", http.StatusBadGateway, nil)
	}
	c.mu.Lock()
	c.cached = entries
	c.mu.Unlock()
	return entries, nil
}

func requireVerifiedExecutionCredential(identity *CodexVerifiedIdentity) error {
	if identity == nil || !identity.Verified {
		return NewError("codex_native_model_identity_not_verified", http.StatusServiceUnavailable, nil)
	}
	verifiedOAuth := identity.Kind == "oauth" && (identity.Assurance == "identity" || identity.Assurance == "runtime-home")
	verifiedKey := identity.Kind == "api-key" && identity.Assurance == "execution-credential"
	if !verifiedOAuth && !verifiedKey {
		return NewError("codex_native_model_identity_not_verified", http.StatusServiceUnavailable, nil)
	}
	return nil
}
