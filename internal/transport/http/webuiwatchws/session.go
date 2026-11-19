package webuiwatchws

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type subEntry struct {
	cancel context.CancelFunc
	gen    uint64
}

type watchSession struct {
	handler         *Handler
	connCtx         context.Context
	cancelConn      context.CancelFunc
	subsCtx         context.Context
	cancelSubs      context.CancelFunc
	conn            *websocket.Conn
	closeConnection func(websocket.StatusCode, string)
	outbound        *outboundQueue
	frameBudget     *frameBudget

	closeMu  sync.Mutex
	hasClose bool

	subsMu      sync.Mutex
	subs        map[string]*subEntry
	subRunning  map[string]int
	nextSubGen  uint64
	runningSubs int

	closeWG sync.WaitGroup
	bgWG    sync.WaitGroup
	subsWG  sync.WaitGroup
}

func newWatchSession(
	handler *Handler,
	connCtx context.Context,
	cancelConn context.CancelFunc,
	conn *websocket.Conn,
	closeConnection func(websocket.StatusCode, string),
) *watchSession {
	subsCtx, cancelSubs := context.WithCancel(connCtx)
	session := &watchSession{
		handler:         handler,
		connCtx:         connCtx,
		cancelConn:      cancelConn,
		subsCtx:         subsCtx,
		cancelSubs:      cancelSubs,
		conn:            conn,
		closeConnection: closeConnection,
		frameBudget:     newFrameBudget(handler.maxAggregateFrameBytes),
		subs:            make(map[string]*subEntry),
		subRunning:      make(map[string]int),
	}
	session.outbound = newOutboundQueue(
		handler.maxOutboundBytes,
		defaultMaxOutboundFrames,
		defaultMaxPerSubFrames,
		handler.writeTimeout,
		func() {
			session.fail(websocket.StatusGoingAway, "slow_consumer_overflow")
		},
	)
	return session
}

func (session *watchSession) fail(code websocket.StatusCode, reason string) {
	session.closeMu.Lock()
	if session.hasClose {
		session.closeMu.Unlock()
		return
	}
	session.hasClose = true
	session.closeWG.Add(1)
	session.closeMu.Unlock()

	session.outbound.Close()
	session.cancelSubs()

	go func() {
		defer session.closeWG.Done()
		session.closeConnection(code, reason)
		session.cancelConn()
	}()
}

func (session *watchSession) isEntryCurrent(subID string, entry *subEntry) bool {
	session.subsMu.Lock()
	current := session.subs[subID] == entry
	session.subsMu.Unlock()
	return current
}

func (session *watchSession) startBackgroundLoops() {
	session.bgWG.Add(1)
	go func() {
		defer session.bgWG.Done()
		select {
		case <-session.connCtx.Done():
		case <-session.handler.closedCh:
			session.fail(websocket.StatusGoingAway, "server_shutdown")
		case <-session.handler.shutdownDone:
			session.fail(websocket.StatusGoingAway, "server_shutdown")
		}
	}()

	session.bgWG.Add(1)
	go session.runWriterLoop()
}

func (session *watchSession) runWriterLoop() {
	defer session.bgWG.Done()
	ticker := time.NewTicker(session.handler.heartbeatInterval)
	defer ticker.Stop()

	for {
		if session.outbound.IsClosed() {
			return
		}
		if frame, ok := session.outbound.TryDequeue(); ok {
			if !writeWatchWSText(session.connCtx, session.conn, frame.payload, session.handler.writeTimeout) {
				session.fail(websocket.StatusGoingAway, "write_timeout")
				return
			}
			continue
		}
		select {
		case <-session.connCtx.Done():
			return
		case <-session.outbound.NotifyPush():
		case <-ticker.C:
			if session.outbound.IsClosed() {
				return
			}
			pingCtx, cancelPing := context.WithTimeout(session.connCtx, session.handler.writeTimeout)
			pingErr := session.conn.Ping(pingCtx)
			cancelPing()
			if pingErr != nil {
				session.fail(websocket.StatusGoingAway, "ping_timeout")
				return
			}
			if !writeWatchWSJSON(session.connCtx, session.conn, wsHeartbeatFrame{Type: "heartbeat"}, session.handler.writeTimeout) {
				session.fail(websocket.StatusGoingAway, "heartbeat_timeout")
				return
			}
		}
	}
}

func (session *watchSession) runReadLoop(handshake *http.Request, validatedAuth string) {
	for {
		msgType, raw, readErr := session.conn.Read(session.connCtx)
		if readErr != nil {
			return
		}
		if msgType != websocket.MessageText {
			session.fail(wsStatusBadRequest, "invalid_control_frame")
			return
		}
		var msg wsControlMessage
		if !decodeStrictJSONObject(raw, &msg) {
			session.fail(wsStatusBadRequest, "invalid_control_frame")
			return
		}
		switch msg.Type {
		case "subscribe":
			if !isValidWatchSubID(msg.ID) {
				session.fail(wsStatusBadRequest, "invalid_subscription_id")
				return
			}
			session.subscribe(handshake, validatedAuth, msg.ID, msg.Path)
		case "unsubscribe":
			if !isValidWatchSubID(msg.ID) {
				session.fail(wsStatusBadRequest, "invalid_subscription_id")
				return
			}
			session.unsubscribe(msg.ID)
		default:
			session.fail(wsStatusBadRequest, "invalid_control_frame")
			return
		}
	}
}

func (session *watchSession) subscribe(handshake *http.Request, validatedAuth, subID, rawPath string) {
	canonicalPath, ok := normalizeAllowedWatchPath(rawPath)
	if !ok {
		session.emitSubError(subID, 0, "unsupported_watch_path", 0)
		return
	}

	subCtx, cancelSub := context.WithCancel(session.subsCtx)

	session.subsMu.Lock()
	if session.subsCtx.Err() != nil {
		session.subsMu.Unlock()
		cancelSub()
		return
	}
	if session.runningSubs >= session.handler.maxSubscriptions {
		session.subsMu.Unlock()
		cancelSub()
		session.emitSubError(subID, 0, "too_many_subscriptions", 0)
		return
	}
	// Advance generation and purge any queued frames from prior generations of
	// this subscription ID before exposing the replacement entry.
	session.nextSubGen++
	gen := session.nextSubGen
	entry := &subEntry{cancel: cancelSub, gen: gen}
	if previous, exists := session.subs[subID]; exists {
		previous.cancel()
	}
	session.outbound.SetMinGenAndPurge(subID, gen)
	session.subs[subID] = entry
	session.subRunning[subID]++
	session.runningSubs++
	session.subsWG.Add(1)
	session.subsMu.Unlock()

	go session.runSubscription(subCtx, entry, handshake, validatedAuth, subID, canonicalPath)
}

func (session *watchSession) unsubscribe(subID string) {
	session.subsMu.Lock()
	entry, exists := session.subs[subID]
	if exists {
		delete(session.subs, subID)
		entry.cancel()
		revokedMinGen := entry.gen + 1
		session.outbound.SetMinGenAndPurge(subID, revokedMinGen)
		if session.subRunning[subID] == 0 {
			session.outbound.ClearMinGen(subID)
		}
	} else if session.subRunning[subID] > 0 {
		// Entry already removed (e.g. natural EOF winding down) while its
		// goroutine is still exiting: advance generation and purge queued frames;
		// the exiting goroutine's defer clears minGen when subRunning hits 0.
		session.nextSubGen++
		session.outbound.SetMinGenAndPurge(subID, session.nextSubGen)
	} else {
		// Explicit unsubscribe after natural EOF when no goroutine remains:
		// purge any queued tail frames for subID without leaving a tombstone.
		session.outbound.PurgeAllForSub(subID)
	}
	session.subsMu.Unlock()
}

func (session *watchSession) runSubscription(
	subCtx context.Context,
	entry *subEntry,
	handshake *http.Request,
	validatedAuth string,
	subID string,
	canonicalPath string,
) {
	defer func() {
		entry.cancel()
		session.subsMu.Lock()
		if session.subs[subID] == entry {
			delete(session.subs, subID)
		}
		if next := session.subRunning[subID] - 1; next <= 0 {
			delete(session.subRunning, subID)
			if session.subs[subID] == nil {
				session.outbound.ClearMinGen(subID)
			}
		} else {
			session.subRunning[subID] = next
		}
		session.runningSubs--
		session.subsMu.Unlock()
		session.subsWG.Done()
	}()

	var errorOnce sync.Once
	emitSubErrorOnce := func(code string, status int) {
		errorOnce.Do(func() {
			if session.subsCtx.Err() != nil || !session.isEntryCurrent(subID, entry) {
				return
			}
			session.emitSubError(subID, entry.gen, code, status)
		})
	}

	panicked := false
	pipe := newSSEPipeWriter(
		subCtx,
		session.handler.maxSSEFrameBytes,
		session.frameBudget,
		func(readDeadline func() (time.Time, <-chan struct{})) error {
			return session.outbound.EnqueueJSON(subCtx, subID, entry.gen, wsSubOpenFrame{
				Type: "open",
				ID:   subID,
			}, readDeadline)
		},
		func(data string, readDeadline func() (time.Time, <-chan struct{})) error {
			return session.outbound.EnqueueJSON(subCtx, subID, entry.gen, wsSubEventFrame{
				Type: "event",
				ID:   subID,
				Data: data,
			}, readDeadline)
		},
		func(code string) {
			// Emit exact error immediately using parent subsCtx (before canceling
			// subCtx) so handlers that ignore initial snapshot Write errors cannot
			// leak incremental events without a baseline or delay error delivery.
			emitSubErrorOnce(code, 0)
			entry.cancel()
		},
	)
	defer pipe.ReleaseBuffers()

	func() {
		defer func() {
			if recover() != nil {
				panicked = true
			}
		}()
		subReq, err := http.NewRequestWithContext(subCtx, http.MethodGet, canonicalPath, nil)
		if err != nil {
			pipe.WriteHeader(http.StatusBadRequest)
			return
		}
		if handshake != nil {
			subReq.Host = handshake.Host
			subReq.RemoteAddr = handshake.RemoteAddr
			subReq.TLS = handshake.TLS
		}
		subReq.Header.Set("Accept", "text/event-stream")
		if validatedAuth != "" {
			subReq.Header.Set("Authorization", validatedAuth)
		}
		session.handler.dispatch.ServeHTTP(pipe, subReq)
	}()

	// Validate entry currency atomically under subsMu before deciding global
	// connection failure (401) or emitting any terminal error, so a superseded
	// or unsubscribed subscription can never race and close a live WebSocket.
	status := pipe.StatusCode()
	session.subsMu.Lock()
	stillCurrent := session.subsCtx.Err() == nil && subCtx.Err() == nil && session.subs[subID] == entry
	failAuth := stillCurrent && !panicked && status == http.StatusUnauthorized
	if failAuth {
		delete(session.subs, subID)
	}
	session.subsMu.Unlock()

	if !stillCurrent {
		return
	}
	if failAuth {
		session.fail(wsStatusUnauthorized, "unauthorized")
		return
	}
	if panicked {
		emitSubErrorOnce("watch_handler_panic", 0)
		return
	}
	if pipe.FrameTooLarge() {
		emitSubErrorOnce("frame_too_large", 0)
		return
	}
	if status != http.StatusOK {
		emitSubErrorOnce("watch_http_error", status)
		return
	}
	if !pipe.IsEventStream() {
		emitSubErrorOnce("non_event_stream", status)
		return
	}
	emitSubErrorOnce("stream_closed", 0)
}

func (session *watchSession) emitSubError(subID string, subGen uint64, code string, status int) {
	if session.subsCtx.Err() != nil {
		return
	}
	_ = session.outbound.EnqueueJSON(session.subsCtx, subID, subGen, wsSubErrorFrame{
		Type:   "error",
		ID:     subID,
		Code:   code,
		Status: status,
	}, nil)
}

func (session *watchSession) shutdownAndJoin() {
	session.closeMu.Lock()
	shouldSendShutdown := !session.hasClose && session.handler.isShuttingDown()
	session.hasClose = true
	session.closeMu.Unlock()

	session.outbound.Close()
	session.cancelSubs()
	if shouldSendShutdown {
		session.closeConnection(websocket.StatusGoingAway, "server_shutdown")
	}
	session.closeWG.Wait()
	session.cancelConn()
	_ = session.conn.CloseNow()
	session.bgWG.Wait()
	session.subsWG.Wait()
}

func writeWatchWSText(parentCtx context.Context, conn *websocket.Conn, payload []byte, timeout time.Duration) bool {
	if len(payload) == 0 {
		return true
	}
	writeCtx, cancel := context.WithTimeout(parentCtx, timeout)
	defer cancel()
	return conn.Write(writeCtx, websocket.MessageText, payload) == nil
}

func writeWatchWSJSON(parentCtx context.Context, conn *websocket.Conn, body any, timeout time.Duration) bool {
	encoded, err := json.Marshal(body)
	if err != nil {
		return false
	}
	return writeWatchWSText(parentCtx, conn, encoded, timeout)
}
