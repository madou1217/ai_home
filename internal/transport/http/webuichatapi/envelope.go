// Package webuichatapi 提供 WebUI Chat 的 Go HTTP 入站切片。
//
// 与 Node 的关系：Node 侧一次 WebUI 对话被拆成两条独立连接——
//
//	POST /v0/webui/chat/sessions/{id}/commands  → chat-runtime-service（返回 202）
//	GET  /v0/webui/chat/sessions/{id}/events    → aih.chat.event.v1 SSE
//
// 本包把其中「一次 turn.submit 从入站、账号征召、上游增量到 SSE 回写」这一段竖切到
// Go：Node 的轮次执行调用 ManagementCollectionPath，本包直接以 SSE 交付本轮事件，
// 由 Node 翻译成既有 canonical 事件后再进会话事件表。浏览器路由因此不需要改指 Go，
// 202 + 独立 SSE 的语义保持不变。
package webuichatapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

const (
	// EventSchema 是 WebUI Chat 事件信封的唯一 schema，与 Node contract-values 同名同值。
	EventSchema = "aih.chat.event.v1"
	// runtimeID 是产生本切片事件的运行时标识。
	//
	// Node 侧写的是会话绑定出来的 `codex:<scope>`；本切片的运行时是 Go 的
	// chat_completions 通道，因此用同一「家族:范围」形状，让前端不把它误认成 codex。
	runtimeID = "go:chat-completions"

	// heartbeatFrame 与 Node webui-chat-runtime-sse 的心跳帧逐字节一致。
	heartbeatFrame = ": heartbeat\n\n"

	eventTypeTurnQueued            = "turn.queued"
	eventTypeTurnStarted           = "turn.started"
	eventTypeTurnCompleted         = "turn.completed"
	eventTypeTurnFailed            = "turn.failed"
	eventTypeTimelineItemStarted   = "timeline.item.started"
	eventTypeTimelineItemDelta     = "timeline.item.delta"
	eventTypeTimelineItemCompleted = "timeline.item.completed"
	timelineKindMessage            = "message"
	timelineStatusRunning          = "running"
	timelineStatusCompleted        = "completed"
	timelineStatusFailed           = "failed"
	sessionStateStarting           = "starting"
	sessionStateRunning            = "running"
	sessionStateIdle               = "idle"
)

// errStreamClosed 表示 SSE 已经不可写（客户端断开或写出错）。
var errStreamClosed = errors.New("SSE 已经不可写")

// eventSource 是事件来源；两个字段在 Node 侧都是必填。
type eventSource struct {
	Provider  string `json:"provider"`
	RuntimeID string `json:"runtimeId"`
}

// eventEnvelope 是 aih.chat.event.v1 的传输信封。
//
// 字段顺序与 Node normalizeEvent 的构造顺序一致：seq 为 0 时不写 id 行（Node 只在
// seq > 0 时写）。turnId / runId / itemId 是可选文本，缺席时整键不出现。
type eventEnvelope struct {
	Schema    string      `json:"schema"`
	EventID   string      `json:"eventId"`
	SessionID string      `json:"sessionId"`
	Seq       int64       `json:"seq"`
	Type      string      `json:"type"`
	At        int64       `json:"at"`
	TurnID    string      `json:"turnId,omitempty"`
	RunID     string      `json:"runId,omitempty"`
	ItemID    string      `json:"itemId,omitempty"`
	Source    eventSource `json:"source"`
	Payload   any         `json:"payload"`
}

// encodeEvent 生成与 Node encodeSseEvent 相同的帧：
//
//	[id: <seq>\n]event: <type>\ndata: <json>\n\n
func encodeEvent(event eventEnvelope) ([]byte, error) {
	data, err := json.Marshal(event)
	if err != nil {
		return nil, err
	}
	var frame bytes.Buffer
	if event.Seq > 0 {
		fmt.Fprintf(&frame, "id: %d\n", event.Seq)
	}
	fmt.Fprintf(&frame, "event: %s\ndata: %s\n\n", event.Type, data)
	return frame.Bytes(), nil
}

// eventStream 把事件按顺序写成 SSE 帧，并在空闲时发送心跳。
//
// 为什么需要锁与心跳：Node 的 BoundedSseWriter 背后是异步 res.write + drain 事件，
// 心跳定时器与事件发布可以并发；Go 的 ResponseWriter 不支持并发写，所以这里用一把
// 互斥锁串行化「事件写」与「心跳写」，语义等价（心跳不会插进一帧中间）。
type eventStream struct {
	response  http.ResponseWriter
	flusher   http.Flusher
	deadline  *inferenceapi.StreamDeadline
	sessionID string
	source    eventSource
	now       func() time.Time
	newID     func(string) string

	mutex   sync.Mutex
	seq     int64
	failed  bool
	closed  bool
	stop    chan struct{}
	watcher sync.WaitGroup
}

// newEventStream 要求 ResponseWriter 支持即时刷新，否则无法交付 SSE。
func newEventStream(
	response http.ResponseWriter,
	sessionID string,
	source eventSource,
	now func() time.Time,
	newID func(string) string,
) (*eventStream, error) {
	flusher, ok := response.(http.Flusher)
	if response == nil || !ok || now == nil || newID == nil {
		return nil, inferenceapi.ErrStreamingUnsupported
	}
	return &eventStream{
		response:  response,
		flusher:   flusher,
		deadline:  inferenceapi.NewStreamDeadline(response),
		sessionID: sessionID,
		source:    source,
		now:       now,
		newID:     newID,
		stop:      make(chan struct{}),
	}, nil
}

// open 交付 SSE 响应头。头集合与 Node openSseHeaders 逐项一致。
func (stream *eventStream) open() error {
	header := stream.response.Header()
	header.Set("Content-Type", "text/event-stream; charset=utf-8")
	header.Set("Cache-Control", "no-cache, no-transform")
	header.Set("Connection", "keep-alive")
	header.Set("X-Accel-Buffering", "no")
	stream.response.WriteHeader(http.StatusOK)
	stream.flusher.Flush()
	stream.deadline.Refresh()
	return nil
}

// startHeartbeat 在固定间隔写注释帧，避免代理把「还在等上游」的连接当成空闲连接。
func (stream *eventStream) startHeartbeat(interval time.Duration) {
	if interval <= 0 {
		return
	}
	stream.watcher.Add(1)
	go func() {
		defer stream.watcher.Done()
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stream.stop:
				return
			case <-ticker.C:
				if err := stream.write([]byte(heartbeatFrame)); err != nil {
					return
				}
			}
		}
	}()
}

// close 停止心跳并拒绝后续写入。
func (stream *eventStream) close() {
	stream.mutex.Lock()
	if !stream.closed {
		stream.closed = true
	}
	stream.mutex.Unlock()
	select {
	case <-stream.stop:
	default:
		close(stream.stop)
	}
	stream.watcher.Wait()
}

// Failed 表示客户端连接已经写不进去。
func (stream *eventStream) Failed() bool {
	stream.mutex.Lock()
	defer stream.mutex.Unlock()
	return stream.failed || stream.closed
}

// emit 组装一个信封并写出；返回错误表示连接已断，调用方应停止读取上游。
func (stream *eventStream) emit(
	eventType string,
	turnID string,
	runID string,
	itemID string,
	payload any,
) error {
	stream.mutex.Lock()
	seq := stream.seq + 1
	stream.seq = seq
	stream.mutex.Unlock()
	event := eventEnvelope{
		Schema:    EventSchema,
		EventID:   stream.newID("event"),
		SessionID: stream.sessionID,
		Seq:       seq,
		Type:      eventType,
		At:        stream.now().UnixMilli(),
		TurnID:    turnID,
		RunID:     runID,
		ItemID:    itemID,
		Source:    stream.source,
		Payload:   payload,
	}
	frame, err := encodeEvent(event)
	if err != nil {
		return err
	}
	return stream.write(frame)
}

// write 串行写出一帧并在写完立即刷新。
//
// 刷新是必须的：net/http 默认按 4KB 缓冲，不刷新的话增量会攒成整段，
// 「流式」就只剩语义没有体验。
func (stream *eventStream) write(frame []byte) error {
	stream.mutex.Lock()
	defer stream.mutex.Unlock()
	if stream.closed || stream.failed {
		return errStreamClosed
	}
	if _, err := stream.response.Write(frame); err != nil {
		stream.failed = true
		return err
	}
	stream.flusher.Flush()
	stream.deadline.Refresh()
	return nil
}

// activeTurn 是事件里的轮次快照，字段与 Node TurnLifecycle.activeTurn 的必填部分一致。
type activeTurn struct {
	TurnID              string `json:"turnId"`
	RunID               string `json:"runId"`
	ClientUserMessageID string `json:"clientUserMessageId"`
	StartedAt           int64  `json:"startedAt,omitempty"`
	State               string `json:"state"`
}

// turnPayload 是 turn.queued / turn.started 的载荷。
type turnPayload struct {
	State               string     `json:"state"`
	SubmissionCommandID string     `json:"submissionCommandId,omitempty"`
	ActiveTurn          activeTurn `json:"activeTurn"`
}

// turnCompletedPayload 是 turn.completed 的载荷。
type turnCompletedPayload struct {
	State string `json:"state"`
}

// failureDetail 是 sanitizeCanonicalDiagnostic 的输出里本切片用到的两个字段。
type failureDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// turnFailedPayload 是 turn.failed 的载荷（Node terminalResult 的失败分支）。
type turnFailedPayload struct {
	State     string        `json:"state"`
	Retryable bool          `json:"retryable"`
	Error     failureDetail `json:"error"`
}

// messageMetrics 是消息条目里的用量汇总，字段集合受 Node normalizeMessageMetrics 约束。
type messageMetrics struct {
	DurationMS   int64    `json:"durationMs"`
	TTFTMS       *int64   `json:"ttftMs,omitempty"`
	InputTokens  *uint64  `json:"inputTokens,omitempty"`
	OutputTokens *uint64  `json:"outputTokens,omitempty"`
	TokensPerSec *float64 `json:"tokensPerSec,omitempty"`
}

// messageDetail 是 message 条目 detail 的最小集合：role 必填，model/metrics 可选。
type messageDetail struct {
	Role    string          `json:"role"`
	Model   string          `json:"model,omitempty"`
	Metrics *messageMetrics `json:"metrics,omitempty"`
}

// timelineItem 对齐 Node normalizeTimelineItem 的字段集合。
type timelineItem struct {
	ID        string        `json:"id"`
	Kind      string        `json:"kind"`
	CreatedAt int64         `json:"createdAt"`
	UpdatedAt int64         `json:"updatedAt"`
	Status    string        `json:"status"`
	Content   string        `json:"content"`
	Detail    messageDetail `json:"detail"`
	TurnID    string        `json:"turnId,omitempty"`
}

// timelinePayload 是 timeline.item.started / completed 的载荷。
type timelinePayload struct {
	Item timelineItem `json:"item"`
}

// deltaPayload 是 timeline.item.delta 的载荷；channel 只在前端需要区分通道时出现。
type deltaPayload struct {
	ItemID string `json:"itemId"`
	Chunk  string `json:"chunk"`
}
