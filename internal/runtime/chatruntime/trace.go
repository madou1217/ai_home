package chatruntime

import (
	"maps"
	"strings"
	"sync"
	"time"
)

// TraceStages 定义一轮推理指令的标准可观测阶段顺序。
var TraceStages = []string{
	"requestAccepted",
	"commandPersisted",
	"actorDequeued",
	"runtimeAcquired",
	"authReady",
	"sessionBound",
	"turnSubmitted",
	"firstProviderEvent",
	"firstVisibleItem",
	"firstTextDelta",
	"completed",
}

var validTraceStages = func() map[string]int {
	m := make(map[string]int, len(TraceStages))
	for i, s := range TraceStages {
		m[s] = i
	}
	return m
}()

var safeTraceAttributeKeys = map[string]struct{}{
	"provider":          {},
	"sessionId":         {},
	"commandId":         {},
	"runId":             {},
	"runtimeId":         {},
	"runtimeGeneration": {},
	"transport":         {},
	"warm":              {},
	"status":            {},
	"errorCode":         {},
}

// TraceDurations 记录各关键链路耗时（毫秒）。
type TraceDurations struct {
	CommandAckMs         *int64 `json:"commandAckMs"`
	RuntimeAcquireMs     *int64 `json:"runtimeAcquireMs"`
	ProviderFirstEventMs *int64 `json:"providerFirstEventMs"`
	ProviderToVisibleMs  *int64 `json:"providerToVisibleMs"`
	FirstVisibleItemMs   *int64 `json:"firstVisibleItemMs"`
	FirstTextDeltaMs     *int64 `json:"firstTextDeltaMs"`
	TotalMs              *int64 `json:"totalMs"`
}

// TraceSnapshot 表示某条指令追踪结束时生成的不可变快照。
type TraceSnapshot struct {
	TraceID    string           `json:"traceId"`
	Attributes map[string]any   `json:"attributes,omitempty"`
	Stages     []map[string]any `json:"stages"`
	Durations  TraceDurations   `json:"durations"`
	RunID      string           `json:"runId,omitempty"`
}

// SanitizeTraceAttributes 过滤并截断允许暴露的 trace 属性。
func SanitizeTraceAttributes(src map[string]any) map[string]any {
	if len(src) == 0 {
		return map[string]any{}
	}
	out := make(map[string]any)
	for k := range safeTraceAttributeKeys {
		v, ok := src[k]
		if !ok || v == nil {
			continue
		}
		switch val := v.(type) {
		case bool:
			out[k] = val
		case int:
			out[k] = val
		case int64:
			out[k] = val
		case float64:
			out[k] = val
		case string:
			if val != "" {
				if len(val) > 160 {
					val = val[:160]
				}
				out[k] = val
			}
		}
	}
	return out
}

// ChatRuntimeTrace 收集单个指令各执行阶段时间戳。
type ChatRuntimeTrace struct {
	mu         sync.Mutex
	now        func() int64
	traceID    string
	attributes map[string]any
	marks      map[string]map[string]any
}

// NewChatRuntimeTrace 创建一个带初始 requestAccepted 标记的 Trace。
func NewChatRuntimeTrace(attributes map[string]any, clock func() int64, idFactory func(string) string) *ChatRuntimeTrace {
	if clock == nil {
		clock = func() int64 { return time.Now().UnixMilli() }
	}
	if idFactory == nil {
		idFactory = DefaultIDFactory
	}
	t := &ChatRuntimeTrace{
		now:        clock,
		traceID:    strings.TrimPrefix(idFactory("trace"), "trace-"),
		attributes: SanitizeTraceAttributes(attributes),
		marks:      make(map[string]map[string]any),
	}
	var startedAt map[string]any
	if attributes != nil {
		if raw, ok := attributes["startedAt"]; ok {
			startedAt = map[string]any{"at": raw}
		}
	}
	_, _ = t.Mark("requestAccepted", startedAt)
	return t
}

// Mark 幂等记录某一阶段的时间戳与安全属性。
func (t *ChatRuntimeTrace) Mark(stage string, details map[string]any) (map[string]any, error) {
	if _, ok := validTraceStages[stage]; !ok {
		return nil, NewError("invalid_chat_runtime_trace_stage", 422, nil)
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if existing, ok := t.marks[stage]; ok {
		return maps.Clone(existing), nil
	}
	at := t.now()
	if details != nil {
		if rawAt, has := details["at"]; has {
			if n, ok := coerceInt64(rawAt); ok && n >= 0 {
				at = n
			}
		}
	}
	item := SanitizeTraceAttributes(details)
	item["stage"] = stage
	item["at"] = at
	t.marks[stage] = item
	return maps.Clone(item), nil
}

// Snapshot 导出阶段序列及端到端耗时摘要。
func (t *ChatRuntimeTrace) Snapshot() TraceSnapshot {
	t.mu.Lock()
	defer t.mu.Unlock()
	stages := make([]map[string]any, 0, len(TraceStages))
	for _, s := range TraceStages {
		if m, ok := t.marks[s]; ok {
			stages = append(stages, maps.Clone(m))
		}
	}
	return TraceSnapshot{
		TraceID:    t.traceID,
		Attributes: maps.Clone(t.attributes),
		Stages:     stages,
		Durations: TraceDurations{
			CommandAckMs:         durationBetweenMarks(t.marks, "requestAccepted", "commandPersisted"),
			RuntimeAcquireMs:     durationBetweenMarks(t.marks, "actorDequeued", "runtimeAcquired"),
			ProviderFirstEventMs: durationBetweenMarks(t.marks, "turnSubmitted", "firstProviderEvent"),
			ProviderToVisibleMs:  durationBetweenMarks(t.marks, "firstProviderEvent", "firstVisibleItem"),
			FirstVisibleItemMs:   durationBetweenMarks(t.marks, "requestAccepted", "firstVisibleItem"),
			FirstTextDeltaMs:     durationBetweenMarks(t.marks, "requestAccepted", "firstTextDelta"),
			TotalMs:              durationBetweenMarks(t.marks, "requestAccepted", "completed"),
		},
	}
}

func durationBetweenMarks(marks map[string]map[string]any, from, to string) *int64 {
	start, ok1 := marks[from]
	end, ok2 := marks[to]
	if !ok1 || !ok2 {
		return nil
	}
	sAt, okA := coerceInt64(start["at"])
	eAt, okB := coerceInt64(end["at"])
	if !okA || !okB {
		return nil
	}
	d := eAt - sAt
	if d < 0 {
		d = 0
	}
	return &d
}

var (
	traceTerminalEvents = map[string]struct{}{
		"turn.completed":   {},
		"turn.failed":      {},
		"turn.interrupted": {},
	}
	traceVisibleEvents = map[string]struct{}{
		"timeline.item.started":   {},
		"timeline.item.updated":   {},
		"timeline.item.completed": {},
		"interaction.requested":   {},
	}
	traceMessageEvents = map[string]struct{}{
		"timeline.item.updated":   {},
		"timeline.item.completed": {},
	}
)

// TraceLifecycle 管理活跃命令与运行轮次的追踪生命周期并在完成时写入 sink。
type TraceLifecycle struct {
	mu           sync.Mutex
	traceFactory func(map[string]any) *ChatRuntimeTrace
	traceSink    func(TraceSnapshot)
	byCommand    map[string]*TraceRecord
	byRun        map[string]*TraceRecord
	records      map[*TraceRecord]struct{}
}

// NewTraceLifecycle 创建 TraceLifecycle 实例。
func NewTraceLifecycle(factory func(map[string]any) *ChatRuntimeTrace, sink func(TraceSnapshot)) *TraceLifecycle {
	if factory == nil {
		factory = func(attrs map[string]any) *ChatRuntimeTrace {
			return NewChatRuntimeTrace(attrs, nil, nil)
		}
	}
	if sink == nil {
		sink = func(TraceSnapshot) {}
	}
	return &TraceLifecycle{
		traceFactory: factory,
		traceSink:    sink,
		byCommand:    make(map[string]*TraceRecord),
		byRun:        make(map[string]*TraceRecord),
		records:      make(map[*TraceRecord]struct{}),
	}
}

// Start 为一条新命令创建并登记 TraceRecord。
func (l *TraceLifecycle) Start(attributes map[string]any) *TraceRecord {
	cmdID, _ := attributes["commandId"].(string)
	cmdID = strings.TrimSpace(cmdID)
	rec := &TraceRecord{
		lifecycle: l,
		trace:     l.traceFactory(attributes),
		commandID: cmdID,
	}
	l.mu.Lock()
	l.records[rec] = struct{}{}
	if cmdID != "" && l.byCommand[cmdID] == nil {
		l.byCommand[cmdID] = rec
	}
	l.mu.Unlock()
	return rec
}

// MarkCommandPersisted 记录 commandPersisted 阶段。
func (l *TraceLifecycle) MarkCommandPersisted(commandID string, rec *TraceRecord) {
	target := rec
	if target == nil {
		l.mu.Lock()
		target = l.byCommand[strings.TrimSpace(commandID)]
		l.mu.Unlock()
	}
	if target != nil {
		target.Mark("commandPersisted", nil)
	}
}

// ObservePublishedEvent 将已发布事件关联到所属 run 的 TraceRecord。
func (l *TraceLifecycle) ObservePublishedEvent(ev EventEnvelope) {
	runID := strings.TrimSpace(ev.RunID)
	if runID == "" {
		return
	}
	l.mu.Lock()
	rec := l.byRun[runID]
	l.mu.Unlock()
	if rec != nil {
		rec.ObservePublishedEvent(ev)
	}
}

func (l *TraceLifecycle) bindRun(rec *TraceRecord, runID string) {
	id := strings.TrimSpace(runID)
	if id == "" || rec == nil {
		return
	}
	l.mu.Lock()
	if rec.finished {
		l.mu.Unlock()
		return
	}
	if rec.runID != "" {
		delete(l.byRun, rec.runID)
	}
	rec.runID = id
	l.byRun[id] = rec
	l.mu.Unlock()
}

func (l *TraceLifecycle) finish(rec *TraceRecord) {
	l.mu.Lock()
	delete(l.records, rec)
	if rec.commandID != "" && l.byCommand[rec.commandID] == rec {
		delete(l.byCommand, rec.commandID)
	}
	if rec.runID != "" && l.byRun[rec.runID] == rec {
		delete(l.byRun, rec.runID)
	}
	runID := rec.runID
	l.mu.Unlock()

	snap := rec.trace.Snapshot()
	if runID != "" {
		snap.RunID = runID
	}
	func() {
		defer func() { _ = recover() }()
		l.traceSink(snap)
	}()
}

// Close 结束所有尚未完成的活跃 trace 记录。
func (l *TraceLifecycle) Close() {
	l.mu.Lock()
	snapshot := make([]*TraceRecord, 0, len(l.records))
	for r := range l.records {
		snapshot = append(snapshot, r)
	}
	l.mu.Unlock()
	for _, r := range snapshot {
		r.Finish(map[string]any{"status": "closed", "errorCode": "chat_runtime_closed"})
	}
}

// TraceRecord 追踪单个指令/轮次的生命周期状态。
type TraceRecord struct {
	mu        sync.Mutex
	lifecycle *TraceLifecycle
	trace     *ChatRuntimeTrace
	commandID string
	runID     string
	finished  bool
}

// Mark 若尚未结束则写入阶段标记。
func (r *TraceRecord) Mark(stage string, details map[string]any) {
	if r == nil {
		return
	}
	r.mu.Lock()
	finished := r.finished
	r.mu.Unlock()
	if !finished {
		_, _ = r.trace.Mark(stage, details)
	}
}

// BindRun 将当前 TraceRecord 绑定到活跃 runId。
func (r *TraceRecord) BindRun(runID string) {
	if r == nil || r.lifecycle == nil {
		return
	}
	r.lifecycle.bindRun(r, runID)
}

// IsRunBound 返回是否已绑定 runId。
func (r *TraceRecord) IsRunBound() bool {
	if r == nil {
		return false
	}
	r.lifecycle.mu.Lock()
	defer r.lifecycle.mu.Unlock()
	return r.runID != ""
}

// ObserveProviderEvent 标记收到首个底层 provider 事件。
func (r *TraceRecord) ObserveProviderEvent(source EventSource) {
	if r == nil {
		return
	}
	var details map[string]any
	if source.RuntimeID != "" {
		details = map[string]any{"runtimeId": source.RuntimeID}
	}
	r.Mark("firstProviderEvent", details)
}

// ObservePublishedEvent 更新可见项/首字延迟标记，并在轮次终态时结束追踪。
func (r *TraceRecord) ObservePublishedEvent(ev EventEnvelope) {
	if r == nil {
		return
	}
	if _, ok := traceVisibleEvents[ev.Type]; ok {
		r.Mark("firstVisibleItem", nil)
	}
	if traceHasAssistantText(ev) {
		r.Mark("firstTextDelta", nil)
	}
	if _, ok := traceTerminalEvents[ev.Type]; ok {
		details := map[string]any{
			"status": strings.TrimPrefix(ev.Type, "turn."),
		}
		if errObj, ok := ev.Payload["error"].(map[string]any); ok {
			if code, ok := errObj["code"].(string); ok && code != "" {
				details["errorCode"] = code
			}
		}
		r.Finish(details)
	}
}

// Finish 幂等完成当前 trace 并提交给 sink。
func (r *TraceRecord) Finish(details map[string]any) {
	if r == nil {
		return
	}
	r.mu.Lock()
	if r.finished {
		r.mu.Unlock()
		return
	}
	_, _ = r.trace.Mark("completed", details)
	r.finished = true
	r.mu.Unlock()
	if r.lifecycle != nil {
		r.lifecycle.finish(r)
	}
}

func traceHasAssistantText(ev EventEnvelope) bool {
	if ev.Type == "timeline.item.delta" {
		if detail, ok := ev.Payload["detail"].(map[string]any); ok {
			if ch, _ := detail["channel"].(string); ch != "" {
				return false
			}
		}
		chunk, _ := ev.Payload["chunk"].(string)
		return chunk != ""
	}
	if _, ok := traceMessageEvents[ev.Type]; !ok {
		return false
	}
	item, ok := ev.Payload["item"].(map[string]any)
	if !ok {
		return false
	}
	kind, _ := item["kind"].(string)
	if kind != "message" {
		return false
	}
	detail, ok := item["detail"].(map[string]any)
	if !ok || detail["role"] != "assistant" {
		return false
	}
	content, _ := item["content"].(string)
	return content != ""
}
