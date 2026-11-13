package chatruntime

import (
	"context"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
)

var toolBoundaryKinds = map[string]struct{}{
	"tool":        {},
	"shell":       {},
	"file_change": {},
	"subagent":    {},
}

// AutomaticQueueAction 描述由持久化事件触发的自动队列动作。
type AutomaticQueueAction struct {
	Type           string
	SessionID      string
	RunID          string
	Identity       string
	BoundaryItemID string
	Policy         string
}

// AutomaticQueueBoundaryStrategy 解析事件流中的工具边界与回合终结边界。
type AutomaticQueueBoundaryStrategy struct{}

// Resolve 判断一条已落库事件是否应触发自动插队（steer）或回合后出队（follow-up）。
func (AutomaticQueueBoundaryStrategy) Resolve(ev EventEnvelope, sess *Session) *AutomaticQueueAction {
	if sess == nil {
		return nil
	}
	if act := resolveToolBoundaryAction(ev, sess); act != nil {
		return act
	}
	return resolveFollowUpAction(ev, sess)
}

func resolveToolBoundaryAction(ev EventEnvelope, sess *Session) *AutomaticQueueAction {
	if ev.Type != "timeline.item.completed" || strings.TrimSpace(ev.RunID) == "" {
		return nil
	}
	if sess.ActiveTurn == nil || sess.ActiveTurn.RunID != ev.RunID {
		return nil
	}
	if sess.State != "running" && sess.State != "waiting_input" {
		return nil
	}
	item, _ := ev.Payload["item"].(map[string]any)
	boundaryItemID := strings.TrimSpace(ev.ItemID)
	if boundaryItemID == "" && item != nil {
		boundaryItemID = strings.TrimSpace(asString(item["id"]))
	}
	kind := ""
	if item != nil {
		kind = asString(item["kind"])
	}
	if boundaryItemID == "" {
		return nil
	}
	if _, ok := toolBoundaryKinds[kind]; !ok {
		return nil
	}
	return &AutomaticQueueAction{
		Type:           "tool_boundary",
		SessionID:      ev.SessionID,
		RunID:          ev.RunID,
		Identity:       boundaryItemID,
		BoundaryItemID: boundaryItemID,
		Policy:         "after_tool_boundary",
	}
}

func resolveFollowUpAction(ev EventEnvelope, sess *Session) *AutomaticQueueAction {
	if sess.State != "idle" || sess.ActiveTurn != nil {
		return nil
	}
	lastRunID := queueControlLastRunID(sess)
	if queueControlPaused(sess) || lastRunID == "" {
		return nil
	}
	completed := ev.Type == "turn.completed" && ev.RunID == lastRunID
	arrived := false
	if ev.Type == "queue.item.added" {
		if entry, _ := ev.Payload["entry"].(map[string]any); entry != nil {
			arrived = asString(entry["policy"]) == "after_turn"
		}
	}
	if !completed && !arrived {
		return nil
	}
	return &AutomaticQueueAction{
		Type:      "turn_terminal",
		SessionID: ev.SessionID,
		Identity:  lastRunID,
		RunID:     lastRunID,
		Policy:    "after_turn",
	}
}

// AutomaticQueueCoordinatorOptions 配置自动出队协调器。
type AutomaticQueueCoordinatorOptions struct {
	Store           *PublishingStore
	DispatchCommand func(ctx context.Context, sessionID string, input map[string]any) (map[string]any, error)
	WaitForIdle     func(ctx context.Context, sessionID string) error
	IDFactory       func(string) string
	OnError         func(err error, action AutomaticQueueAction)
}

// AutomaticQueueCoordinator 监听事件流并按会话通道串行调度自动插队/续发。
type AutomaticQueueCoordinator struct {
	store           *PublishingStore
	dispatchCommand func(ctx context.Context, sessionID string, input map[string]any) (map[string]any, error)
	waitForIdle     func(ctx context.Context, sessionID string) error
	idFactory       func(string) string
	onError         func(err error, action AutomaticQueueAction)
	strategy        AutomaticQueueBoundaryStrategy

	closed atomic.Bool
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup

	laneMu sync.Mutex
	lanes  map[string]*autoQueueLane
}

type autoQueueLane struct {
	mu      sync.Mutex
	queue   []AutomaticQueueAction
	running bool
}

// NewAutomaticQueueCoordinator 构造自动队列协调器。
func NewAutomaticQueueCoordinator(opts AutomaticQueueCoordinatorOptions) *AutomaticQueueCoordinator {
	idFactory := opts.IDFactory
	if idFactory == nil {
		idFactory = DefaultIDFactory
	}
	waitFn := opts.WaitForIdle
	if waitFn == nil {
		waitFn = func(context.Context, string) error { return nil }
	}
	onErr := opts.OnError
	if onErr == nil {
		onErr = func(error, AutomaticQueueAction) {}
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &AutomaticQueueCoordinator{
		store:           opts.Store,
		dispatchCommand: opts.DispatchCommand,
		waitForIdle:     waitFn,
		idFactory:       idFactory,
		onError:         onErr,
		ctx:             ctx,
		cancel:          cancel,
		lanes:           make(map[string]*autoQueueLane),
	}
}

// Observe 根据刚广播的持久化事件决定是否排队自动触发动作。
func (c *AutomaticQueueCoordinator) Observe(ev EventEnvelope) bool {
	if c == nil || c.closed.Load() || c.store == nil {
		return false
	}
	sess, err := c.store.GetSession(c.ctx, ev.SessionID)
	if err != nil || sess == nil {
		return false
	}
	action := c.strategy.Resolve(ev, sess)
	if action == nil {
		return false
	}
	c.enqueue(*action)
	return true
}

// Close 停止接受新的自动调度并等待进行中的任务退出。
func (c *AutomaticQueueCoordinator) Close() {
	if c == nil {
		return
	}
	if c.closed.CompareAndSwap(false, true) {
		c.cancel()
		c.wg.Wait()
	}
}

func (c *AutomaticQueueCoordinator) enqueue(action AutomaticQueueAction) {
	if c.closed.Load() {
		return
	}
	c.laneMu.Lock()
	lane := c.lanes[action.SessionID]
	if lane == nil {
		lane = &autoQueueLane{}
		c.lanes[action.SessionID] = lane
	}
	lane.mu.Lock()
	lane.queue = append(lane.queue, action)
	startWorker := !lane.running
	if startWorker {
		lane.running = true
		c.wg.Add(1)
	}
	lane.mu.Unlock()
	c.laneMu.Unlock()

	if startWorker {
		go c.drainLane(action.SessionID, lane)
	}
}

func (c *AutomaticQueueCoordinator) drainLane(sessionID string, lane *autoQueueLane) {
	defer c.wg.Done()
	for {
		lane.mu.Lock()
		if len(lane.queue) == 0 || c.closed.Load() {
			lane.queue = nil
			lane.running = false
			lane.mu.Unlock()
			c.laneMu.Lock()
			lane.mu.Lock()
			if !lane.running && len(lane.queue) == 0 && c.lanes[sessionID] == lane {
				delete(c.lanes, sessionID)
			}
			lane.mu.Unlock()
			c.laneMu.Unlock()
			return
		}
		action := lane.queue[0]
		lane.queue = lane.queue[1:]
		lane.mu.Unlock()

		if err := c.execute(c.ctx, action); err != nil && !c.closed.Load() {
			c.safeReport(err, action)
		}
	}
}

func (c *AutomaticQueueCoordinator) execute(ctx context.Context, action AutomaticQueueAction) error {
	if action.Type == "tool_boundary" {
		return c.interveneAtToolBoundary(ctx, action)
	}
	return c.dispatchAfterTurn(ctx, action)
}

func (c *AutomaticQueueCoordinator) interveneAtToolBoundary(ctx context.Context, action AutomaticQueueAction) error {
	sess, err := c.store.GetSession(ctx, action.SessionID)
	if err != nil || sess == nil || sess.ActiveTurn == nil || sess.ActiveTurn.RunID != action.RunID {
		return err
	}
	if sess.State != "running" && sess.State != "waiting_input" {
		return nil
	}
	item, err := c.store.LeaseNextQueueItem(ctx, action.SessionID, LeaseQueueInput{
		LeaseID:        c.idFactory("lease"),
		Policy:         action.Policy,
		BoundaryItemID: action.BoundaryItemID,
	})
	if err != nil || item == nil {
		return err
	}
	if _, err := c.store.MarkQueueRunning(ctx, item.QueueID, item.LeaseID); err != nil {
		return err
	}
	cmd := map[string]any{
		"commandId": automaticCommandID(action, item.QueueID),
		"type":      "turn.intervene",
		"payload": map[string]any{
			"mode":          "steer_current",
			"content":       item.Payload["content"],
			"expectedRunId": action.RunID,
		},
	}
	if c.dispatchCommand == nil {
		return NewError("chat_runtime_dispatcher_unavailable", 503, nil)
	}
	resp, dispErr := c.dispatchCommand(ctx, action.SessionID, cmd)
	if dispErr != nil {
		_, settleErr := c.store.SettleQueueItem(ctx, item.QueueID, item.LeaseID, "failed", map[string]any{
			"commandId": cmd["commandId"],
			"error":     serializeCommandError(dispErr),
		})
		if settleErr != nil {
			return settleErr
		}
		return dispErr
	}
	_, err = c.store.SettleQueueItem(ctx, item.QueueID, item.LeaseID, "completed", map[string]any{
		"commandId": cmd["commandId"],
		"result":    resp["result"],
	})
	return err
}

func (c *AutomaticQueueCoordinator) dispatchAfterTurn(ctx context.Context, action AutomaticQueueAction) error {
	if err := c.waitForIdle(ctx, action.SessionID); err != nil {
		return err
	}
	if c.closed.Load() {
		return nil
	}
	sess, err := c.store.GetSession(ctx, action.SessionID)
	if err != nil || sess == nil || sess.State != "idle" || queueControlPaused(sess) || queueControlLastRunID(sess) != action.RunID {
		return err
	}
	if !c.hasQueuedPolicy(ctx, action.SessionID, action.Policy) {
		return nil
	}
	if c.dispatchCommand == nil {
		return NewError("chat_runtime_dispatcher_unavailable", 503, nil)
	}
	_, err = c.dispatchCommand(ctx, action.SessionID, map[string]any{
		"commandId": automaticCommandID(action, ""),
		"type":      "queue.dispatch",
		"payload": map[string]any{
			"policy":     action.Policy,
			"afterRunId": action.RunID,
		},
	})
	return err
}

func (c *AutomaticQueueCoordinator) hasQueuedPolicy(ctx context.Context, sessionID, policy string) bool {
	items, err := c.store.ListQueue(ctx, sessionID, true)
	if err != nil {
		return false
	}
	for _, item := range items {
		if item.Status == "queued" && item.Policy == policy {
			return true
		}
	}
	return false
}

func (c *AutomaticQueueCoordinator) safeReport(err error, action AutomaticQueueAction) {
	defer func() { _ = recover() }()
	c.onError(err, action)
}

func automaticCommandID(action AutomaticQueueAction, queueID string) string {
	parts := []string{"aih-auto", action.Type, action.SessionID, action.Identity}
	if queueID != "" {
		parts = append(parts, queueID)
	}
	encoded := make([]string, len(parts))
	for i, part := range parts {
		encoded[i] = strings.ReplaceAll(url.PathEscape(part), ":", "%3A")
	}
	return strings.Join(encoded, ":")
}
