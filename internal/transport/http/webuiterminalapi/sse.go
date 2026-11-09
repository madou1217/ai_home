package webuiterminalapi

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/terminalsession"
)

// 帧结构与 Node 的 mux 流逐字段一致：
//
//	连接确认： {"type":"connected","muxId":"..."}
//	输出：     {"type":"output","termId":"...","data":"<base64>"}
//	退出：     {"type":"exit","termId":"...","exitCode":0,"signal":null}
//
// 心跳是 SSE 注释行（": heartbeat"），不用 JSON 帧。
type muxOutputFrame struct {
	Type   string `json:"type"`
	TermID string `json:"termId"`
	Data   string `json:"data"`
}

type muxExitFrame struct {
	Type     string `json:"type"`
	TermID   string `json:"termId"`
	ExitCode int    `json:"exitCode"`
	Signal   any    `json:"signal"`
}

type streamOutputFrame struct {
	Type string `json:"type"`
	Data string `json:"data"`
}

type streamExitFrame struct {
	Type     string `json:"type"`
	ExitCode int    `json:"exitCode"`
}

type streamExitReasonFrame struct {
	Type   string `json:"type"`
	Reason string `json:"reason"`
}

// muxWatcher 是一条 SSE 连接。frames 满时由分发方摘除并关闭连接——
// 慢消费者不能反压 PTY 读取（与 Node「写失败即摘除 watcher」一致）。
type muxWatcher struct {
	frames chan []byte
	done   chan struct{}
	once   sync.Once
}

func newMuxWatcher() *muxWatcher {
	return &muxWatcher{
		frames: make(chan []byte, 512),
		done:   make(chan struct{}),
	}
}

func (watcher *muxWatcher) stop() {
	watcher.once.Do(func() { close(watcher.done) })
}

// muxStream 是一个面板的聚合流：一条 SSE 承载该 mux 下所有 tab 的输出。
//
// 多 tab 各开一条 EventSource 会撞浏览器每域 ~6 连接上限（第 6+ 个永远卡在
// 「连接中」），所以同一 mux 的所有会话只在这条流上按 termId 分发。
type muxStream struct {
	id string

	mu       sync.Mutex
	closed   bool
	watchers map[*muxWatcher]struct{}
	subs     map[string]*terminalsession.Subscription
}

func newMuxStream(id string) *muxStream {
	return &muxStream{
		id:       id,
		watchers: make(map[*muxWatcher]struct{}),
		subs:     make(map[string]*terminalsession.Subscription),
	}
}

func (stream *muxStream) addWatcher(watcher *muxWatcher) bool {
	stream.mu.Lock()
	defer stream.mu.Unlock()
	if stream.closed {
		return false
	}
	stream.watchers[watcher] = struct{}{}
	return true
}

func (stream *muxStream) removeWatcher(watcher *muxWatcher) int {
	stream.mu.Lock()
	delete(stream.watchers, watcher)
	remaining := len(stream.watchers)
	stream.mu.Unlock()
	watcher.stop()
	return remaining
}

// subscribe 为该 mux 订阅一个会话：先回放挂载前缓冲，再持续接收实时输出。
// 同一 termId 重复绑定只保留一个订阅（对应 Node mux.replayedTermIds 的幂等语义）。
func (stream *muxStream) subscribe(sessions SessionService, termID string) {
	if termID == "" {
		return
	}
	stream.mu.Lock()
	if stream.closed || stream.subs[termID] != nil {
		stream.mu.Unlock()
		return
	}
	subscription, err := sessions.Subscribe(termID, subscriptionQueueSize)
	if err != nil {
		stream.mu.Unlock()
		return
	}
	stream.subs[termID] = subscription
	stream.mu.Unlock()
	go stream.forward(termID, subscription)
}

func (stream *muxStream) unsubscribe(termID string) {
	stream.mu.Lock()
	subscription := stream.subs[termID]
	delete(stream.subs, termID)
	stream.mu.Unlock()
	if subscription != nil {
		subscription.Close()
	}
}

func (stream *muxStream) forward(termID string, subscription *terminalsession.Subscription) {
	for frame := range subscription.C {
		payload := encodeMuxFrame(termID, frame)
		stream.mu.Lock()
		for watcher := range stream.watchers {
			select {
			case watcher.frames <- payload:
			default:
				delete(stream.watchers, watcher)
				watcher.stop()
			}
		}
		closed := stream.closed
		stream.mu.Unlock()
		if closed {
			return
		}
	}
	stream.mu.Lock()
	if stream.subs[termID] == subscription {
		delete(stream.subs, termID)
	}
	stream.mu.Unlock()
}

func (stream *muxStream) shutdown() {
	stream.mu.Lock()
	if stream.closed {
		stream.mu.Unlock()
		return
	}
	stream.closed = true
	subscriptions := make([]*terminalsession.Subscription, 0, len(stream.subs))
	for termID, subscription := range stream.subs {
		subscriptions = append(subscriptions, subscription)
		delete(stream.subs, termID)
	}
	watchers := make([]*muxWatcher, 0, len(stream.watchers))
	for watcher := range stream.watchers {
		watchers = append(watchers, watcher)
	}
	stream.watchers = make(map[*muxWatcher]struct{})
	stream.mu.Unlock()

	for _, subscription := range subscriptions {
		subscription.Close()
	}
	for _, watcher := range watchers {
		watcher.stop()
	}
}

func encodeMuxFrame(termID string, frame terminalsession.Frame) []byte {
	switch frame.Type {
	case terminalsession.FrameOutput:
		return encodeSSEJSON(muxOutputFrame{
			Type:   "output",
			TermID: termID,
			Data:   base64.StdEncoding.EncodeToString(frame.Data),
		})
	case terminalsession.FrameExit:
		return encodeSSEJSON(muxExitFrame{
			Type:     "exit",
			TermID:   termID,
			ExitCode: frame.ExitCode,
			Signal:   nil,
		})
	default:
		return nil
	}
}

func encodeSSEJSON(payload any) []byte {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil
	}
	return []byte("data: " + string(body) + "\n\n")
}

func openSSEStream(response http.ResponseWriter) (http.Flusher, bool) {
	flusher, ok := response.(http.Flusher)
	if !ok {
		writeError(response, http.StatusInternalServerError, "terminal_sse_unavailable", "当前传输不支持 SSE")
		return nil, false
	}
	headers := response.Header()
	headers.Set("Content-Type", "text/event-stream")
	headers.Set("Cache-Control", "no-cache")
	headers.Set("Connection", "keep-alive")
	headers.Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)
	flusher.Flush()
	return flusher, true
}

func writeSSEBytes(response http.ResponseWriter, flusher http.Flusher, payload []byte) error {
	if len(payload) == 0 {
		return nil
	}
	if _, err := response.Write(payload); err != nil {
		return err
	}
	flusher.Flush()
	return nil
}

func writeSSEJSON(response http.ResponseWriter, flusher http.Flusher, payload any) error {
	return writeSSEBytes(response, flusher, encodeSSEJSON(payload))
}

func writeSSEComment(response http.ResponseWriter, flusher http.Flusher, text string) error {
	return writeSSEBytes(response, flusher, []byte(": "+strings.TrimSpace(text)+"\n\n"))
}

func (handler *Handler) acquireMux(muxID string, watcher *muxWatcher) *muxStream {
	handler.mu.Lock()
	defer handler.mu.Unlock()
	stream := handler.muxes[muxID]
	if stream == nil {
		stream = newMuxStream(muxID)
		handler.muxes[muxID] = stream
	}
	if !stream.addWatcher(watcher) {
		return nil
	}
	return stream
}

func (handler *Handler) releaseMux(stream *muxStream, watcher *muxWatcher) {
	if stream == nil {
		return
	}
	handler.mu.Lock()
	remaining := stream.removeWatcher(watcher)
	if remaining == 0 && handler.muxes[stream.id] == stream {
		delete(handler.muxes, stream.id)
		handler.mu.Unlock()
		stream.shutdown()
		return
	}
	handler.mu.Unlock()
}

// handleMux 是面板级 SSE：一条流承载该 mux 下全部 tab 的输出。
func (handler *Handler) handleMux(response http.ResponseWriter, request *http.Request) {
	muxID := strings.TrimSpace(request.URL.Query().Get("muxId"))
	if muxID == "" {
		writeError(response, http.StatusBadRequest, "mux_id_required", "缺少 muxId")
		return
	}
	handler.sessions.Reap()

	// 先注册 mux 再取快照：快照之后新建的会话会在 bind 时看到这个 mux 并直接订阅，
	// 不会掉进「注册前已绑定、注册后不在快照里」的窗口。
	watcher := newMuxWatcher()
	stream := handler.acquireMux(muxID, watcher)
	if stream == nil {
		writeError(response, http.StatusServiceUnavailable, "terminal_mux_unavailable", "终端面板流不可用")
		return
	}
	defer handler.releaseMux(stream, watcher)

	flusher, ok := openSSEStream(response)
	if !ok {
		return
	}
	if err := writeSSEJSON(response, flusher, struct {
		Type  string `json:"type"`
		MuxID string `json:"muxId"`
	}{Type: "connected", MuxID: muxID}); err != nil {
		return
	}

	snapshots := handler.sessions.List()
	handler.forgetStaleMeta(snapshots)
	// 回放该 mux 下已有会话的挂载前缓冲（例如各 tab 的首个 prompt）。
	// 订阅本身先送回放帧，再送实时帧；这里按快照顺序逐个挂上。
	for _, snapshot := range snapshots {
		if handler.muxIDFor(snapshot.ID) == muxID {
			stream.subscribe(handler.sessions, snapshot.ID)
		}
	}

	var heartbeat <-chan time.Time
	var ticker *time.Ticker
	if handler.heartbeat > 0 {
		ticker = time.NewTicker(handler.heartbeat)
		heartbeat = ticker.C
		defer ticker.Stop()
	}

	for {
		select {
		case payload, ok := <-watcher.frames:
			if !ok {
				return
			}
			if err := writeSSEBytes(response, flusher, payload); err != nil {
				return
			}
		case <-watcher.done:
			return
		case <-request.Context().Done():
			return
		case <-heartbeat:
			if err := writeSSEComment(response, flusher, "heartbeat"); err != nil {
				return
			}
		}
	}
}

// handleStream 是单会话 SSE（历史端点，前端已改用 mux）。
// 帧形状保持 Node 旧实现：输出帧不带 termId。
func (handler *Handler) handleStream(response http.ResponseWriter, request *http.Request) {
	termID := strings.TrimSpace(request.URL.Query().Get("termId"))
	if termID == "" {
		writeTerminalError(response, http.StatusNotFound, errTerminalNotFound)
		return
	}
	subscription, err := handler.sessions.Subscribe(termID, subscriptionQueueSize)
	if err != nil {
		writeTerminalError(response, http.StatusNotFound, errTerminalNotFound)
		return
	}
	defer subscription.Close()

	flusher, ok := openSSEStream(response)
	if !ok {
		return
	}
	if err := writeSSEJSON(response, flusher, struct {
		Type   string `json:"type"`
		TermID string `json:"termId"`
	}{Type: "connected", TermID: termID}); err != nil {
		return
	}

	var heartbeat <-chan time.Time
	var ticker *time.Ticker
	if handler.heartbeat > 0 {
		ticker = time.NewTicker(handler.heartbeat)
		heartbeat = ticker.C
		defer ticker.Stop()
	}

	for {
		select {
		case frame, ok := <-subscription.C:
			if !ok {
				return
			}
			switch frame.Type {
			case terminalsession.FrameOutput:
				err = writeSSEJSON(response, flusher, streamOutputFrame{
					Type: "output",
					Data: base64.StdEncoding.EncodeToString(frame.Data),
				})
			case terminalsession.FrameExit:
				if frame.Reason != "" && frame.Reason != "exit" {
					err = writeSSEJSON(response, flusher, streamExitReasonFrame{Type: "exit", Reason: frame.Reason})
				} else {
					err = writeSSEJSON(response, flusher, streamExitFrame{Type: "exit", ExitCode: frame.ExitCode})
				}
			}
			if err != nil {
				return
			}
		case <-request.Context().Done():
			return
		case <-heartbeat:
			if err := writeSSEComment(response, flusher, "heartbeat"); err != nil {
				return
			}
		}
	}
}
