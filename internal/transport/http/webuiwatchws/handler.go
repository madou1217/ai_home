// Package webuiwatchws multiplexes the canonical allowlisted WebUI SSE watch
// streams over a single local WebSocket connection per browser tab/scope so
// background watchers do not exhaust the browser's 6-connection HTTP/1.1 pool.
package webuiwatchws

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	// DefaultAuthTimeout bounds how long a newly upgraded socket may wait before
	// sending its first-frame Bearer authentication message.
	DefaultAuthTimeout = 5 * time.Second
	// DefaultHeartbeatInterval controls both RFC6455 Ping and JSON heartbeat frames.
	DefaultHeartbeatInterval = 15 * time.Second
	// DefaultWriteTimeout bounds every WebSocket write/ping and slow-consumer wait.
	DefaultWriteTimeout = 5 * time.Second
	// DefaultCloseTimeout bounds how long Close waits for active connections and
	// inner SSE handlers to join before returning ErrCloseTimeout.
	DefaultCloseTimeout = 5 * time.Second
	// DefaultMaxSubscriptions caps active subscriptions per WebSocket connection.
	DefaultMaxSubscriptions = 32
	// DefaultMaxSSEFrameBytes caps a single buffered SSE data payload (8 MiB).
	DefaultMaxSSEFrameBytes = 8 * 1024 * 1024
	// DefaultMaxAggregateFrameBytes caps aggregate partial SSE parser buffers
	// across all concurrent subscriptions on a single WebSocket (16 MiB).
	DefaultMaxAggregateFrameBytes = 16 * 1024 * 1024
	// DefaultMaxOutboundBytes caps total queued outbound bytes per WebSocket (16 MiB).
	DefaultMaxOutboundBytes = 16 * 1024 * 1024

	defaultMaxOutboundFrames = 512
	defaultMaxPerSubFrames   = 64
	maxWSClientFrameBytes    = 16 * 1024
)

var (
	// ErrInvalidDependencies indicates missing Authorizer or Dispatch handler.
	ErrInvalidDependencies = errors.New("webui watch websocket dependencies invalid")
	// ErrCloseTimeout indicates active connections or inner SSE handlers did not
	// finish joining within CloseTimeout, so downstream stores must not be closed.
	ErrCloseTimeout = errors.New("webui watch websocket close timed out waiting for handlers to join")
)

// Authorizer validates WebUI management credentials.
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies configures the multiplexed WebUI watch WebSocket handler.
type Dependencies struct {
	Authorizer             Authorizer
	Dispatch               http.Handler
	ShutdownDone           <-chan struct{}
	AuthTimeout            time.Duration
	HeartbeatInterval      time.Duration
	WriteTimeout           time.Duration
	CloseTimeout           time.Duration
	MaxSubscriptions       int
	MaxSSEFrameBytes       int
	MaxAggregateFrameBytes int
	MaxOutboundBytes       int
}

// Handler upgrades GET /v1/management/webui/watch/ws and /v0/webui/watch/ws
// into a multiplexed local-only watch channel backed in-process by Dispatch.
type Handler struct {
	authorizer             Authorizer
	dispatch               http.Handler
	shutdownDone           <-chan struct{}
	authTimeout            time.Duration
	heartbeatInterval      time.Duration
	writeTimeout           time.Duration
	closeTimeout           time.Duration
	maxSubscriptions       int
	maxSSEFrameBytes       int
	maxAggregateFrameBytes int
	maxOutboundBytes       int

	lifeMu    sync.Mutex
	closed    bool
	closedCh  chan struct{}
	drainedCh chan struct{}
	active    map[*activeConn]struct{}
	activeWG  sync.WaitGroup
}

type wsAuthMessage struct {
	Type          string `json:"type"`
	Authorization string `json:"authorization"`
	ServerID      string `json:"serverId,omitempty"`
}

type wsControlMessage struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Path string `json:"path,omitempty"`
}

type wsAuthenticatedFrame struct {
	Type string `json:"type"`
}

type wsHeartbeatFrame struct {
	Type string `json:"type"`
}

type wsSubOpenFrame struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type wsSubEventFrame struct {
	Type string `json:"type"`
	ID   string `json:"id"`
	Data string `json:"data"`
}

type wsSubErrorFrame struct {
	Type   string `json:"type"`
	ID     string `json:"id"`
	Code   string `json:"code"`
	Status int    `json:"status,omitempty"`
}

type wsFirstFrameResult struct {
	msgType websocket.MessageType
	raw     []byte
	err     error
}

// NewHandler validates dependencies and builds a Handler with safe defaults.
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Dispatch == nil {
		return nil, ErrInvalidDependencies
	}
	authTimeout := dependencies.AuthTimeout
	if authTimeout <= 0 {
		authTimeout = DefaultAuthTimeout
	}
	heartbeat := dependencies.HeartbeatInterval
	if heartbeat <= 0 {
		heartbeat = DefaultHeartbeatInterval
	}
	writeTimeout := dependencies.WriteTimeout
	if writeTimeout <= 0 {
		writeTimeout = DefaultWriteTimeout
	}
	closeTimeout := dependencies.CloseTimeout
	if closeTimeout <= 0 {
		closeTimeout = DefaultCloseTimeout
	}
	maxSubs := dependencies.MaxSubscriptions
	if maxSubs <= 0 {
		maxSubs = DefaultMaxSubscriptions
	}
	maxFrameBytes := dependencies.MaxSSEFrameBytes
	if maxFrameBytes <= 0 {
		maxFrameBytes = DefaultMaxSSEFrameBytes
	}
	maxAggregateFrameBytes := dependencies.MaxAggregateFrameBytes
	if maxAggregateFrameBytes <= 0 {
		maxAggregateFrameBytes = DefaultMaxAggregateFrameBytes
	}
	if maxAggregateFrameBytes < maxFrameBytes {
		maxAggregateFrameBytes = maxFrameBytes
	}
	maxOutboundBytes := dependencies.MaxOutboundBytes
	if maxOutboundBytes <= 0 {
		maxOutboundBytes = DefaultMaxOutboundBytes
	}
	return &Handler{
		authorizer:             dependencies.Authorizer,
		dispatch:               dependencies.Dispatch,
		shutdownDone:           dependencies.ShutdownDone,
		authTimeout:            authTimeout,
		heartbeatInterval:      heartbeat,
		writeTimeout:           writeTimeout,
		closeTimeout:           closeTimeout,
		maxSubscriptions:       maxSubs,
		maxSSEFrameBytes:       maxFrameBytes,
		maxAggregateFrameBytes: maxAggregateFrameBytes,
		maxOutboundBytes:       maxOutboundBytes,
		closedCh:               make(chan struct{}),
		drainedCh:              make(chan struct{}),
		active:                 make(map[*activeConn]struct{}),
	}, nil
}

// Close rejects any new WebSocket handshakes, cancels and closes all active
// pre-auth handshakes and post-auth sessions, and waits up to CloseTimeout for
// every serve and inner SSE handler goroutine to join. Returns ErrCloseTimeout
// if draining is uncertain so Server.Close preserves downstream stores.
func (handler *Handler) Close() error {
	if handler == nil {
		return nil
	}
	handler.lifeMu.Lock()
	firstClose := !handler.closed
	var toAbort []*activeConn
	if firstClose {
		handler.closed = true
		close(handler.closedCh)
		toAbort = make([]*activeConn, 0, len(handler.active))
		for entry := range handler.active {
			toAbort = append(toAbort, entry)
		}
		go func() {
			handler.activeWG.Wait()
			close(handler.drainedCh)
		}()
	}
	handler.lifeMu.Unlock()

	for _, entry := range toAbort {
		entry.abort()
	}

	select {
	case <-handler.drainedCh:
		return nil
	default:
	}

	timer := time.NewTimer(handler.closeTimeout)
	defer timer.Stop()
	select {
	case <-handler.drainedCh:
		return nil
	case <-timer.C:
		return ErrCloseTimeout
	}
}

func (handler *Handler) register(cancel context.CancelFunc) (*activeConn, bool) {
	handler.lifeMu.Lock()
	if handler.closed {
		handler.lifeMu.Unlock()
		return nil, false
	}
	entry := &activeConn{cancel: cancel}
	handler.active[entry] = struct{}{}
	handler.activeWG.Add(1)
	handler.lifeMu.Unlock()
	return entry, true
}

func (handler *Handler) unregister(entry *activeConn) {
	if entry == nil {
		return
	}
	handler.lifeMu.Lock()
	delete(handler.active, entry)
	handler.lifeMu.Unlock()
	handler.activeWG.Done()
}

func (handler *Handler) isShuttingDown() bool {
	if handler == nil {
		return true
	}
	select {
	case <-handler.closedCh:
		return true
	default:
	}
	if handler.shutdownDone != nil {
		select {
		case <-handler.shutdownDone:
			return true
		default:
		}
	}
	return false
}

// ServeHTTP validates handshake constraints, authenticates the first frame, and
// runs the multiplexed watch session until close or server shutdown.
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.dispatch == nil || handler.isShuttingDown() {
		writeJSONError(response, http.StatusServiceUnavailable, "watch_ws_unavailable", "实时 watch 服务不可用")
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeJSONError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}
	if hasRemoteServerTarget(request) {
		writeJSONError(response, http.StatusForbidden, "forbidden", "本地 watch WebSocket 不支持远端目标")
		return
	}
	if request.URL != nil && request.URL.RawQuery != "" {
		writeJSONError(response, http.StatusBadRequest, "invalid_query", "watch WebSocket 不允许 URL 查询参数")
		return
	}
	if !isSameOriginWatchWSRequest(request) {
		writeJSONError(response, http.StatusForbidden, "forbidden", "跨源 WebSocket 握手被拒绝")
		return
	}

	baseCtx, cancelBase := context.WithCancel(request.Context())
	defer cancelBase()

	entry, admitted := handler.register(cancelBase)
	if !admitted {
		writeJSONError(response, http.StatusServiceUnavailable, "watch_ws_unavailable", "实时 watch 服务不可用")
		return
	}
	defer handler.unregister(entry)

	upgrade := &watchUpgradeWriter{ResponseWriter: response}
	conn, err := websocket.Accept(upgrade, request, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	closeConnection := func(code websocket.StatusCode, reason string) {
		closeWatchWSConnection(conn, upgrade.connection, code, reason)
	}
	conn.SetReadLimit(maxWSClientFrameBytes)
	defer func() {
		_ = conn.CloseNow()
		if upgrade.connection != nil {
			_ = upgrade.connection.Close()
		}
	}()

	if !entry.attachTransport(conn, upgrade.connection) {
		closeConnection(websocket.StatusGoingAway, "server_shutdown")
		return
	}

	validatedAuth, ok := handler.authenticateFirstFrame(baseCtx, request, conn, closeConnection)
	if !ok {
		return
	}

	connCtx, cancelConn := context.WithCancel(baseCtx)
	if !writeWatchWSJSON(connCtx, conn, wsAuthenticatedFrame{Type: "authenticated"}, handler.writeTimeout) {
		cancelConn()
		return
	}

	session := newWatchSession(handler, connCtx, cancelConn, conn, closeConnection)
	defer session.shutdownAndJoin()

	if !entry.attachSessionAbort(func() {
		session.fail(websocket.StatusGoingAway, "server_shutdown")
	}) {
		return
	}

	session.startBackgroundLoops()
	session.runReadLoop(request, validatedAuth)
}

func (handler *Handler) authenticateFirstFrame(
	baseCtx context.Context,
	request *http.Request,
	conn *websocket.Conn,
	closeConnection func(websocket.StatusCode, string),
) (string, bool) {
	readCtx, cancelRead := context.WithCancel(baseCtx)
	readCh := make(chan wsFirstFrameResult, 1)
	go func() {
		msgType, raw, err := conn.Read(readCtx)
		readCh <- wsFirstFrameResult{msgType: msgType, raw: raw, err: err}
	}()

	authTimer := time.NewTimer(handler.authTimeout)
	defer authTimer.Stop()

	var first wsFirstFrameResult
	select {
	case first = <-readCh:
		cancelRead()
	case <-authTimer.C:
		closeConnection(websocket.StatusPolicyViolation, "auth_timeout")
		cancelRead()
		_ = conn.CloseNow()
		<-readCh
		return "", false
	case <-handler.closedCh:
		closeConnection(websocket.StatusGoingAway, "server_shutdown")
		cancelRead()
		_ = conn.CloseNow()
		<-readCh
		return "", false
	case <-handler.shutdownDone:
		closeConnection(websocket.StatusGoingAway, "server_shutdown")
		cancelRead()
		_ = conn.CloseNow()
		<-readCh
		return "", false
	case <-baseCtx.Done():
		cancelRead()
		_ = conn.CloseNow()
		<-readCh
		return "", false
	}

	if first.err != nil {
		return "", false
	}
	if first.msgType != websocket.MessageText {
		closeConnection(wsStatusBadRequest, "invalid_json")
		return "", false
	}

	var authMsg wsAuthMessage
	if !decodeStrictJSONObject(first.raw, &authMsg) {
		closeConnection(wsStatusBadRequest, "invalid_json")
		return "", false
	}
	if authMsg.Type != "auth" {
		closeConnection(wsStatusBadRequest, "invalid_auth_frame")
		return "", false
	}

	cred := strings.TrimSpace(authMsg.Authorization)
	authReq := request.Clone(baseCtx)
	if authReq.URL != nil {
		urlCopy := *authReq.URL
		urlCopy.RawQuery = ""
		authReq.URL = &urlCopy
	}
	if cred != "" {
		authReq.Header.Set("Authorization", cred)
	} else {
		authReq.Header.Del("Authorization")
	}
	if !handler.authorizer.Authorized(authReq) {
		closeConnection(wsStatusUnauthorized, "unauthorized")
		return "", false
	}
	if strings.TrimSpace(authMsg.ServerID) != "" {
		closeConnection(wsStatusForbidden, "remote_server_unsupported")
		return "", false
	}
	return cred, true
}
