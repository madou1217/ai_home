package chatruntime

import (
	"context"
	"maps"
	"net/http"
	"strings"
	"sync"
	"time"
)

const (
	// GoChatMaxHistoryMessages 限制单次网关 chat 请求携带的历史消息数（与 go-chat-driver.js 一致）。
	GoChatMaxHistoryMessages = 60
	// GoChatMaxHistoryChars 限制单次网关 chat 请求携带的历史字符总数（与 go-chat-driver.js 一致）。
	GoChatMaxHistoryChars = 80000
)

// ChatTurnStreamEvent 表示 Go 网关流式引擎向 GoChatDriver 吐出的一条增量事件。
type ChatTurnStreamEvent struct {
	Type         string
	ItemID       string
	Chunk        string
	Content      string
	Role         string
	Metrics      map[string]any
	ErrorCode    string
	ErrorMessage string
	CreatedAt    int64
	UpdatedAt    int64
}

// ChatTurnStreamRequest 描述提交给 Go 网关内联流式执行器的参数。
type ChatTurnStreamRequest struct {
	SessionID       string
	CommandID       string
	AccountRef      string
	Model           string
	ReasoningEffort string
	Messages        []map[string]any
}

// ChatTurnStreamer 定义 GoChatDriver 对 Go 网关流式执行的最小端口依赖。
type ChatTurnStreamer interface {
	StreamTurn(ctx context.Context, req ChatTurnStreamRequest, emit func(ChatTurnStreamEvent) error) error
}

// ChatTurnStreamerFunc 允许直接传入函数作为 ChatTurnStreamer。
type ChatTurnStreamerFunc func(ctx context.Context, req ChatTurnStreamRequest, emit func(ChatTurnStreamEvent) error) error

// StreamTurn 实现 ChatTurnStreamer 接口。
func (fn ChatTurnStreamerFunc) StreamTurn(
	ctx context.Context,
	req ChatTurnStreamRequest,
	emit func(ChatTurnStreamEvent) error,
) error {
	return fn(ctx, req, emit)
}

// GoChatDriverOptions 配置 Go 网关直连驱动的运行参数与端口依赖。
type GoChatDriverOptions struct {
	Session          *Session
	Store            *PublishingStore
	GetSessionPolicy func() map[string]any
	ReadChatHistory  func(ctx context.Context, sessionID string) ([]map[string]any, error)
	Streamer         ChatTurnStreamer
	IDFactory        func(prefix string) string
	Clock            func() int64
	Capabilities     map[string]any
	ComposerCatalog  func(ctx context.Context) (map[string]any, error)
}

type goChatActiveTurn struct {
	turnID          string
	runID           string
	commandID       string
	cancel          context.CancelFunc
	cancelRequested bool
	settled         bool
	done            chan ProviderRunResult
}

// GoChatDriver 将 canonical turn.submit 直接委托给 Go 网关流式执行器完成。
type GoChatDriver struct {
	session          *Session
	store            *PublishingStore
	getSessionPolicy func() map[string]any
	readChatHistory  func(ctx context.Context, sessionID string) ([]map[string]any, error)
	streamer         ChatTurnStreamer
	idFactory        func(string) string
	clock            func() int64

	mu       sync.Mutex
	disposed bool
	active   *goChatActiveTurn
}

// NewGoChatDriver 构造 GoChatDriver。
func NewGoChatDriver(opts GoChatDriverOptions) (*GoChatDriver, error) {
	if opts.Store == nil {
		return nil, NewError("chat_runtime_store_required", http.StatusInternalServerError, nil)
	}
	if opts.Streamer == nil {
		return nil, NewError("chat_runtime_streamer_required", http.StatusInternalServerError, nil)
	}
	idFactory := opts.IDFactory
	if idFactory == nil {
		idFactory = DefaultIDFactory
	}
	clock := opts.Clock
	if clock == nil {
		clock = func() int64 { return time.Now().UnixMilli() }
	}
	getPolicy := opts.GetSessionPolicy
	if getPolicy == nil {
		getPolicy = func() map[string]any {
			if opts.Session == nil {
				return map[string]any{}
			}
			return opts.Session.Policy
		}
	}
	readHistory := opts.ReadChatHistory
	if readHistory == nil {
		readHistory = defaultReadChatHistory(opts.Store)
	}
	return &GoChatDriver{
		session:          opts.Session,
		store:            opts.Store,
		getSessionPolicy: getPolicy,
		readChatHistory:  readHistory,
		streamer:         opts.Streamer,
		idFactory:        idFactory,
		clock:            clock,
	}, nil
}

// StartTurn 同步校验参数并启动单轮网关流式推理。
func (d *GoChatDriver) StartTurn(ctx context.Context, tc DriverTurnContext) (*ProviderRun, error) {
	d.mu.Lock()
	if d.disposed {
		d.mu.Unlock()
		return nil, NewError("chat_runtime_closed", http.StatusGone, nil)
	}
	if err := d.requireContext(tc); err != nil {
		d.mu.Unlock()
		return nil, err
	}
	if d.active != nil {
		d.mu.Unlock()
		return nil, NewError("chat_turn_already_active", http.StatusConflict, nil)
	}

	var payload map[string]any
	if tc.Command != nil && tc.Command.Payload != nil {
		payload = tc.Command.Payload
	}
	attachmentIDs, _ := NormalizeAttachmentIDs(payload["attachmentIds"], false)
	if len(attachmentIDs) > 0 || len(tc.ImagePaths) > 0 {
		d.mu.Unlock()
		return nil, NewError("chat_attachment_store_unavailable", http.StatusServiceUnavailable, nil)
	}
	content := strings.TrimSpace(asString(payload["content"]))
	if content == "" {
		d.mu.Unlock()
		return nil, NewError("chat_turn_content_required", http.StatusUnprocessableEntity, nil)
	}
	policy := d.currentPolicy()
	model := strings.TrimSpace(asString(payload["model"]))
	if model == "" {
		model = strings.TrimSpace(asString(policy["model"]))
	}
	if model == "" {
		d.mu.Unlock()
		return nil, NewError("chat_turn_model_required", http.StatusUnprocessableEntity, nil)
	}
	reasoningEffort := strings.TrimSpace(asString(payload["reasoningEffort"]))
	if reasoningEffort == "" {
		reasoningEffort = strings.TrimSpace(asString(policy["reasoningEffort"]))
	}

	runCtx, cancel := context.WithCancel(context.Background())
	commandID := ""
	if tc.Command != nil {
		commandID = tc.Command.CommandID
	}
	active := &goChatActiveTurn{
		turnID:    tc.TurnID,
		runID:     tc.RunID,
		commandID: commandID,
		cancel:    cancel,
		done:      make(chan ProviderRunResult, 1),
	}
	d.active = active
	d.mu.Unlock()

	go d.execute(runCtx, active, content, model, reasoningEffort, policy, tc.Trace)

	return &ProviderRun{
		Done: active.done,
		Abandon: func(_ string) string {
			_ = d.InterruptTurn(ctx, tc)
			return "interrupted"
		},
	}, nil
}

// InterruptTurn 取消进行中的网关 HTTP 上游流。
func (d *GoChatDriver) InterruptTurn(_ context.Context, _ DriverTurnContext) error {
	d.mu.Lock()
	active := d.active
	if active == nil {
		d.mu.Unlock()
		return NewError("chat_turn_not_active", http.StatusConflict, nil)
	}
	active.cancelRequested = true
	cancel := active.cancel
	d.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	return nil
}

// Dispose 销毁驱动并中止挂起轮次。
func (d *GoChatDriver) Dispose() bool {
	d.mu.Lock()
	if d.disposed {
		d.mu.Unlock()
		return false
	}
	d.disposed = true
	active := d.active
	if active != nil {
		active.cancelRequested = true
		if active.cancel != nil {
			active.cancel()
		}
	}
	d.mu.Unlock()
	if active != nil {
		d.finish(active, map[string]any{"status": "interrupted"}, nil)
	}
	return true
}

func (d *GoChatDriver) execute(
	runCtx context.Context,
	active *goChatActiveTurn,
	content, model, reasoningEffort string,
	policy map[string]any,
	trace *TraceRecord,
) {
	messages := d.buildMessages(runCtx, content, policy)
	if err := d.writeUserMessage(runCtx, active, content); err != nil {
		d.settleErrorOrInterrupt(active, err)
		return
	}
	if d.isCancelled(active) {
		d.finish(active, map[string]any{"status": "interrupted"}, nil)
		return
	}

	pinnedAccountRef := ""
	if d.session != nil && !IsGatewayRuntimeScope(d.session.ExecutionAccountRef) {
		pinnedAccountRef = strings.TrimSpace(d.session.ExecutionAccountRef)
	}
	req := ChatTurnStreamRequest{
		SessionID:       d.sessionID(),
		CommandID:       active.commandID,
		AccountRef:      pinnedAccountRef,
		Model:           model,
		ReasoningEffort: reasoningEffort,
		Messages:        messages,
	}

	var failure error
	terminal := false
	err := d.streamer.StreamTurn(runCtx, req, func(ev ChatTurnStreamEvent) error {
		if d.isCancelled(active) {
			return context.Canceled
		}
		if trace != nil {
			trace.ObserveProviderEvent(EventSource{Provider: "go-chat", RuntimeID: "gateway"})
		}
		switch ev.Type {
		case "timeline.item.started", "timeline.item.completed":
			item := d.buildAssistantItem(ev, model, reasoningEffort)
			if err := d.emitEvent(runCtx, active, ev.Type, item["id"].(string), map[string]any{"item": item}); err != nil {
				return err
			}
			if ev.Type == "timeline.item.completed" {
				if err := d.writeUsage(runCtx, active, ev.Metrics); err != nil {
					return err
				}
			}
		case "timeline.item.delta":
			if err := d.emitEvent(runCtx, active, "timeline.item.delta", ev.ItemID, map[string]any{
				"itemId": ev.ItemID,
				"chunk":  ev.Chunk,
			}); err != nil {
				return err
			}
		case "turn.completed":
			terminal = true
		case "turn.failed":
			terminal = true
			code := strings.TrimSpace(ev.ErrorCode)
			if code == "" {
				code = "chat_turn_failed"
			}
			msg := strings.TrimSpace(ev.ErrorMessage)
			if msg == "" {
				msg = code
			}
			failure = NewErrorWithMessage(code, http.StatusBadGateway, msg, nil)
		}
		return nil
	})
	if d.isCancelled(active) {
		d.finish(active, map[string]any{"status": "interrupted"}, nil)
		return
	}
	if err != nil {
		d.settleErrorOrInterrupt(active, err)
		return
	}
	if failure != nil {
		d.finish(active, nil, d.normalizeError(failure))
		return
	}
	if !terminal {
		d.finish(active, nil, NewError("chat_upstream_stream_failed", http.StatusBadGateway, nil))
		return
	}
	d.finish(active, map[string]any{"status": "completed"}, nil)
}

func (d *GoChatDriver) buildMessages(ctx context.Context, content string, policy map[string]any) []map[string]any {
	messages := []map[string]any{
		{"role": "system", "content": ChatInstructions},
	}
	if sysPrompt := strings.TrimSpace(asString(policy["systemPrompt"])); sysPrompt != "" {
		messages = append(messages, map[string]any{"role": "system", "content": sysPrompt})
	}
	for _, msg := range d.history(ctx) {
		messages = append(messages, msg)
	}
	messages = append(messages, map[string]any{"role": "user", "content": content})
	return messages
}

func (d *GoChatDriver) history(ctx context.Context) []map[string]any {
	entries, err := d.readChatHistory(ctx, d.sessionID())
	if err != nil || len(entries) == 0 {
		return nil
	}
	out := make([]map[string]any, 0, len(entries))
	chars := 0
	for _, entry := range entries {
		role := strings.TrimSpace(asString(entry["role"]))
		content, _ := entry["content"].(string)
		if (role != "user" && role != "assistant") || strings.TrimSpace(content) == "" {
			continue
		}
		if len(out) >= GoChatMaxHistoryMessages || chars+len(content) > GoChatMaxHistoryChars {
			break
		}
		out = append(out, map[string]any{"role": role, "content": content})
		chars += len(content)
	}
	return out
}

func (d *GoChatDriver) writeUserMessage(ctx context.Context, active *goChatActiveTurn, content string) error {
	now := d.clock()
	itemID := d.idFactory("item")
	item := map[string]any{
		"id":        itemID,
		"kind":      "message",
		"createdAt": now,
		"status":    "running",
		"content":   content,
		"detail":    map[string]any{"role": "user"},
		"turnId":    active.turnID,
	}
	if err := d.emitEvent(ctx, active, "timeline.item.started", itemID, map[string]any{"item": item}); err != nil {
		return err
	}
	doneItem := CloneMap(item)
	doneItem["status"] = "completed"
	doneItem["updatedAt"] = now
	return d.emitEvent(ctx, active, "timeline.item.completed", itemID, map[string]any{"item": doneItem})
}

func (d *GoChatDriver) buildAssistantItem(ev ChatTurnStreamEvent, model, effort string) map[string]any {
	itemID := strings.TrimSpace(ev.ItemID)
	if itemID == "" {
		itemID = d.idFactory("item")
	}
	createdAt := ev.CreatedAt
	if createdAt <= 0 {
		createdAt = d.clock()
	}
	role := strings.TrimSpace(ev.Role)
	if role == "" {
		role = "assistant"
	}
	detail := map[string]any{"role": role}
	if model != "" {
		detail["model"] = model
	}
	if effort != "" {
		detail["effort"] = effort
	}
	if len(ev.Metrics) > 0 {
		detail["metrics"] = CloneMap(ev.Metrics)
	}
	status := "running"
	if ev.Type == "timeline.item.completed" {
		status = "completed"
	}
	item := map[string]any{
		"id":        itemID,
		"kind":      "message",
		"createdAt": createdAt,
		"status":    status,
		"content":   ev.Content,
		"detail":    detail,
		"turnId":    "",
	}
	if ev.UpdatedAt > 0 {
		item["updatedAt"] = ev.UpdatedAt
	} else if ev.Type == "timeline.item.completed" {
		item["updatedAt"] = d.clock()
	}
	return item
}

func (d *GoChatDriver) writeUsage(ctx context.Context, active *goChatActiveTurn, metrics map[string]any) error {
	if len(metrics) == 0 {
		return nil
	}
	usage := map[string]any{}
	for _, field := range []string{"inputTokens", "outputTokens"} {
		if n, ok := coerceInt64(metrics[field]); ok && n >= 0 {
			usage[field] = n
		}
	}
	if len(usage) == 0 {
		return nil
	}
	// 只上报本轮增量 metrics，不传 totals，防止结算层把累计值当本轮增量重复累加。
	return d.emitEvent(ctx, active, "turn.metrics.updated", "", map[string]any{"metrics": usage})
}

func (d *GoChatDriver) emitEvent(ctx context.Context, active *goChatActiveTurn, evType, itemID string, payload map[string]any) error {
	d.mu.Lock()
	disposed := d.disposed
	d.mu.Unlock()
	if disposed {
		return nil
	}
	if item, ok := payload["item"].(map[string]any); ok {
		item["turnId"] = active.turnID
	}
	if itemID == "" {
		if item, ok := payload["item"].(map[string]any); ok {
			itemID = asString(item["id"])
		} else {
			itemID = asString(payload["itemId"])
		}
	}
	_, err := d.store.AppendEvent(ctx, d.sessionID(), EventDraft{
		Type:    evType,
		TurnID:  active.turnID,
		RunID:   active.runID,
		ItemID:  itemID,
		Source:  sessionEventSource(d.session),
		Payload: payload,
	})
	return err
}

func (d *GoChatDriver) settleErrorOrInterrupt(active *goChatActiveTurn, err error) {
	if d.isCancelled(active) {
		d.finish(active, map[string]any{"status": "interrupted"}, nil)
		return
	}
	d.finish(active, nil, d.normalizeError(err))
}

func (d *GoChatDriver) normalizeError(err error) error {
	if rtErr, ok := AsRuntimeError(err); ok && rtErr.Code != "" {
		return rtErr
	}
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	return NewErrorWithMessage("chat_runtime_unavailable", http.StatusServiceUnavailable, msg, nil)
}

func (d *GoChatDriver) finish(active *goChatActiveTurn, result map[string]any, err error) {
	d.mu.Lock()
	if active == nil || active.settled || d.active != active {
		d.mu.Unlock()
		return
	}
	active.settled = true
	d.active = nil
	cancel := active.cancel
	d.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	active.done <- ProviderRunResult{Result: result, Err: err}
	close(active.done)
}

func (d *GoChatDriver) isCancelled(active *goChatActiveTurn) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return active != nil && active.cancelRequested
}

func (d *GoChatDriver) sessionID() string {
	if d.session == nil {
		return ""
	}
	return d.session.SessionID
}

func (d *GoChatDriver) currentPolicy() map[string]any {
	if p := d.getSessionPolicy(); p != nil {
		return p
	}
	if d.session != nil && d.session.Policy != nil {
		return d.session.Policy
	}
	return map[string]any{}
}

func (d *GoChatDriver) requireContext(tc DriverTurnContext) error {
	if strings.TrimSpace(tc.SessionID) != strings.TrimSpace(d.sessionID()) {
		return NewError("chat_actor_session_mismatch", http.StatusConflict, nil)
	}
	if strings.TrimSpace(tc.TurnID) == "" || strings.TrimSpace(tc.RunID) == "" {
		return NewError("chat_turn_context_invalid", http.StatusInternalServerError, nil)
	}
	return nil
}

func defaultReadChatHistory(store *PublishingStore) func(ctx context.Context, sessionID string) ([]map[string]any, error) {
	return func(ctx context.Context, sessionID string) ([]map[string]any, error) {
		page, err := store.ReadTimeline(ctx, sessionID, "", 200)
		if err != nil || page == nil {
			return nil, err
		}
		out := make([]map[string]any, 0, len(page.Items))
		for _, item := range page.Items {
			if item.Kind != "message" || item.Content == nil || strings.TrimSpace(*item.Content) == "" {
				continue
			}
			role := strings.TrimSpace(asString(item.Detail["role"]))
			if role != "user" && role != "assistant" {
				continue
			}
			out = append(out, map[string]any{
				"role":    role,
				"content": *item.Content,
			})
		}
		return out, nil
	}
}

func capSupport(value, reason string) map[string]any {
	out := map[string]any{"support": value}
	if reason != "" {
		out["reason"] = reason
	}
	return out
}

// GoChatCapabilities 返回 go-chat 驱动如实声明的静态能力快照。
func GoChatCapabilities() map[string]any {
	return map[string]any{
		"revision": "go-chat-v1",
		"capabilities": map[string]any{
			"session.resume":                capSupport("unsupported", "go_chat_turn_is_stateless"),
			"timeline.reasoning":            capSupport("unsupported", "go_chat_completions_ignores_reasoning"),
			"timeline.tool":                 capSupport("unsupported", "go_chat_completions_has_no_tools"),
			"timeline.diff":                 capSupport("unsupported", "go_chat_completions_has_no_tools"),
			"mode.plan":                     capSupport("unsupported", "go_chat_has_no_plan_mode"),
			"interaction.question":          capSupport("unsupported", "go_chat_has_no_interactions"),
			"interaction.approval":          capSupport("unsupported", "go_chat_has_no_interactions"),
			"interaction.plan_confirmation": capSupport("unsupported", "go_chat_has_no_interactions"),
			"turn.interrupt":                capSupport("native", ""),
			"turn.steer.current":            capSupport("unsupported", "go_chat_turn_is_a_single_request"),
			"turn.steer.tool_boundary":      capSupport("unsupported", "go_chat_has_no_tool_boundary"),
			"turn.queue":                    capSupport("emulated", "aih_chat_runtime_queue"),
			"session.goal":                  capSupport("emulated", "aih_session_goal_projection"),
			"slash.execute":                 capSupport("native", ""),
			"terminal.stream":               capSupport("unsupported", "go_chat_has_no_terminal"),
			"run.adopt":                     capSupport("unsupported", "go_chat_turn_cannot_be_adopted"),
		},
		"slashCommands":      []string{"goal", "plan"},
		"slashPassthrough":   false,
		"turnInterveneModes": []string{},
	}
}

// CreateGoChatDriverEntry 装配与 ActorRegistry/CapabilityRoutedChatDriver 对齐的 go-chat DriverEntry。
func CreateGoChatDriverEntry(opts GoChatDriverOptions) (*DriverEntry, error) {
	driver, err := NewGoChatDriver(opts)
	if err != nil {
		return nil, err
	}
	caps := opts.Capabilities
	if caps == nil {
		caps = GoChatCapabilities()
	} else {
		caps = maps.Clone(caps)
	}
	return &DriverEntry{
		Driver:          driver,
		Capabilities:    caps,
		ComposerCatalog: opts.ComposerCatalog,
		Handlers:        map[string]CommandHandler{},
	}, nil
}
