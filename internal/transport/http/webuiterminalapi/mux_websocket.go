package webuiterminalapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	maxMuxWSFrameBytes    = 64 * 1024
	maxMuxWSIDBytes       = 256
	muxWSAuthTimeout      = 5 * time.Second
	muxWSWriteTimeout     = 5 * time.Second
	muxWSDefaultHeartbeat = 15 * time.Second

	muxWSStatusBadRequest   websocket.StatusCode = 4400
	muxWSStatusUnauthorized websocket.StatusCode = 4401
	muxWSStatusForbidden    websocket.StatusCode = 4403
)

type muxWSAuthMessage struct {
	Authorization string `json:"authorization"`
	MuxID         string `json:"muxId"`
	ServerID      string `json:"serverId,omitempty"`
}

type muxWSControlMessage struct {
	Type string `json:"type"`
}

type muxWSConnectedFrame struct {
	Type  string `json:"type"`
	MuxID string `json:"muxId"`
}

type muxWSHeartbeatFrame struct {
	Type string `json:"type"`
}

type muxWSFirstFrameResult struct {
	msgType websocket.MessageType
	raw     []byte
	err     error
}

// isSameOriginMuxWSRequest enforces exact same-origin WebSocket handshakes
// (actual request TLS scheme + hostname + effective port) for browser clients
// while permitting non-browser clients without an Origin header (which remain
// strictly gated by first-frame Bearer authorization). Never trusts arbitrary
// Forwarded / X-Forwarded-Proto headers.
func isSameOriginMuxWSRequest(request *http.Request) bool {
	if request == nil {
		return false
	}
	origin := strings.TrimSpace(request.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return false
	}
	expectedScheme := "http"
	if request.TLS != nil {
		expectedScheme = "https"
	}
	if !strings.EqualFold(parsed.Scheme, expectedScheme) {
		return false
	}
	originHost, originPort, ok := splitNormalizedHostPort(parsed.Host, expectedScheme)
	if !ok {
		return false
	}
	reqHost, reqPort, ok := splitNormalizedHostPort(request.Host, expectedScheme)
	if !ok {
		return false
	}
	return originHost == reqHost && originPort == reqPort
}

func splitNormalizedHostPort(rawHost, scheme string) (string, string, bool) {
	trimmed := strings.TrimSpace(rawHost)
	if trimmed == "" || strings.HasSuffix(trimmed, ":") {
		return "", "", false
	}
	parsed, err := url.Parse(scheme + "://" + trimmed)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", "", false
	}
	hostname := strings.ToLower(parsed.Hostname())
	if hostname == "" {
		return "", "", false
	}
	port := parsed.Port()
	if port == "" {
		if scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return hostname, port, true
}

func isValidMuxWSID(muxID string) bool {
	if muxID == "" || len(muxID) > maxMuxWSIDBytes {
		return false
	}
	for i := 0; i < len(muxID); i++ {
		if muxID[i] < 0x20 || muxID[i] == 0x7f {
			return false
		}
	}
	return true
}

func decodeStrictJSONObject(raw []byte, target any) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return false
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return false
	}
	var trailing any
	return decoder.Decode(&trailing) == io.EOF
}

// extractMuxWSJSONPayload unwraps the SSE framing ("data: <json>\n\n") emitted
// by encodeMuxFrame so WebSocket watchers share muxStream without modifying sse.go.
func extractMuxWSJSONPayload(sseFrame []byte) ([]byte, bool) {
	trimmed := bytes.TrimSpace(sseFrame)
	if len(trimmed) == 0 || !bytes.HasPrefix(trimmed, []byte("data:")) {
		return nil, false
	}
	payload := bytes.TrimSpace(trimmed[len("data:"):])
	if len(payload) == 0 || !json.Valid(payload) {
		return nil, false
	}
	return payload, true
}

func parseMuxWSControlFrame(raw []byte) (paused bool, valid bool) {
	var msg muxWSControlMessage
	if !decodeStrictJSONObject(raw, &msg) {
		return false, false
	}
	switch msg.Type {
	case "pause":
		return true, true
	case "resume":
		return false, true
	default:
		return false, false
	}
}

func (handler *Handler) muxWSHeartbeatInterval() time.Duration {
	if handler == nil || handler.heartbeat <= 0 {
		return 0
	}
	if handler.heartbeat < muxWSDefaultHeartbeat {
		return handler.heartbeat
	}
	return muxWSDefaultHeartbeat
}

// handleMuxWebSocket upgrades GET /mux/ws so local WebUI terminal panels do not
// consume one of the browser's 6 HTTP/1.1 connections per origin.
func (handler *Handler) handleMuxWebSocket(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}
	if handler.isClosed() {
		writeError(response, http.StatusServiceUnavailable, "terminal_unavailable", "终端服务不可用")
		return
	}
	if strings.TrimSpace(request.Header.Get("X-Aih-Server-Id")) != "" {
		writeError(response, http.StatusForbidden, "forbidden", "本地终端 WebSocket 不支持远端目标")
		return
	}
	if !isSameOriginMuxWSRequest(request) {
		writeError(response, http.StatusForbidden, "forbidden", "跨源 WebSocket 握手被拒绝")
		return
	}

	upgrade := &muxUpgradeWriter{ResponseWriter: response}
	conn, err := websocket.Accept(upgrade, request, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	closeConnection := func(code websocket.StatusCode, reason string) {
		closeMuxWSConnection(conn, upgrade.connection, code, reason)
	}
	conn.SetReadLimit(maxMuxWSFrameBytes)
	defer func() {
		_ = conn.CloseNow()
	}()

	muxID, ok := handler.authenticateFirstMuxWSFrame(request, conn, closeConnection)
	if !ok {
		return
	}

	// Only after first-frame auth succeeds do we reap/register/replay mux state.
	handler.sessions.Reap()
	watcher := newMuxWatcher()
	stream := handler.acquireMux(muxID, watcher)
	if stream == nil {
		closeConnection(websocket.StatusInternalError, "terminal_mux_unavailable")
		return
	}
	defer handler.releaseMux(stream, watcher)

	connCtx, cancelConn := context.WithCancel(request.Context())
	var bgWG sync.WaitGroup
	if closedCh := handler.closedSignal(); closedCh != nil {
		bgWG.Add(1)
		go func() {
			defer bgWG.Done()
			select {
			case <-connCtx.Done():
			case <-closedCh:
				cancelConn()
			}
		}()
	}
	defer func() {
		cancelConn()
		_ = conn.CloseNow()
		bgWG.Wait()
	}()

	if !writeMuxWSJSON(connCtx, conn, muxWSConnectedFrame{Type: "connected", MuxID: muxID}) {
		return
	}

	snapshots := handler.sessions.List()
	handler.forgetStaleMeta(snapshots)
	for _, snapshot := range snapshots {
		if handler.boundToMux(snapshot.ID, muxID) {
			stream.subscribe(handler.sessions, snapshot.ID)
		}
	}

	pauseCh := make(chan bool, 1)
	badControlCh := make(chan struct{}, 1)
	pushPauseState := func(paused bool) {
		for {
			select {
			case pauseCh <- paused:
				return
			default:
				select {
				case <-pauseCh:
				default:
				}
			}
		}
	}

	// Concurrent reader goroutine consumes only WebSocket control/pause/resume
	// frames. Terminal input and commands are rejected and close the socket.
	bgWG.Add(1)
	go func() {
		defer bgWG.Done()
		for {
			msgType, raw, readErr := conn.Read(connCtx)
			if readErr != nil {
				cancelConn()
				return
			}
			if msgType != websocket.MessageText {
				select {
				case badControlCh <- struct{}{}:
				default:
				}
				return
			}
			paused, valid := parseMuxWSControlFrame(raw)
			if !valid {
				select {
				case badControlCh <- struct{}{}:
				default:
				}
				return
			}
			pushPauseState(paused)
		}
	}()

	var heartbeat <-chan time.Time
	if interval := handler.muxWSHeartbeatInterval(); interval > 0 {
		ticker := time.NewTicker(interval)
		heartbeat = ticker.C
		defer ticker.Stop()
	}

	paused := false
	for {
		select {
		case <-watcher.done:
			if handler.isClosed() {
				closeConnection(websocket.StatusGoingAway, "server_shutdown")
			} else {
				closeConnection(websocket.StatusGoingAway, "mux_overflow")
			}
			return
		default:
		}

		// When paused, stop draining watcher.frames so incoming frames stay
		// bounded by muxWatcher's finite channel capacity (512). If the client
		// stays paused past capacity, muxStream.forward stops watcher.done and
		// closes the socket so the client reconnects/replays without silent drops.
		var framesCh <-chan []byte
		if !paused {
			framesCh = watcher.frames
		}

		select {
		case <-connCtx.Done():
			if handler.isClosed() {
				closeConnection(websocket.StatusGoingAway, "server_shutdown")
			}
			return
		case <-badControlCh:
			closeConnection(muxWSStatusBadRequest, "invalid_control_frame")
			return
		case nextPaused := <-pauseCh:
			paused = nextPaused
		case <-watcher.done:
			if handler.isClosed() {
				closeConnection(websocket.StatusGoingAway, "server_shutdown")
			} else {
				closeConnection(websocket.StatusGoingAway, "mux_overflow")
			}
			return
		case rawFrame, ok := <-framesCh:
			if !ok {
				return
			}
			payload, valid := extractMuxWSJSONPayload(rawFrame)
			if !valid {
				continue
			}
			if !writeMuxWSText(connCtx, conn, payload) {
				return
			}
		case <-heartbeat:
			pingCtx, cancelPing := context.WithTimeout(connCtx, muxWSWriteTimeout)
			pingErr := conn.Ping(pingCtx)
			cancelPing()
			if pingErr != nil {
				return
			}
			if !writeMuxWSJSON(connCtx, conn, muxWSHeartbeatFrame{Type: "heartbeat"}) {
				return
			}
		}
	}
}

func (handler *Handler) authenticateFirstMuxWSFrame(
	request *http.Request,
	conn *websocket.Conn,
	closeConnection func(websocket.StatusCode, string),
) (string, bool) {
	readCtx, cancelRead := context.WithCancel(request.Context())
	readCh := make(chan muxWSFirstFrameResult, 1)
	go func() {
		msgType, raw, err := conn.Read(readCtx)
		readCh <- muxWSFirstFrameResult{msgType: msgType, raw: raw, err: err}
	}()

	authTimer := time.NewTimer(muxWSAuthTimeout)
	defer authTimer.Stop()

	var first muxWSFirstFrameResult
	select {
	case first = <-readCh:
		cancelRead()
	case <-authTimer.C:
		closeConnection(websocket.StatusPolicyViolation, "auth_timeout")
		cancelRead()
		_ = conn.CloseNow()
		<-readCh
		return "", false
	case <-handler.closedSignal():
		closeConnection(websocket.StatusGoingAway, "server_shutdown")
		cancelRead()
		_ = conn.CloseNow()
		<-readCh
		return "", false
	case <-request.Context().Done():
		cancelRead()
		_ = conn.CloseNow()
		<-readCh
		return "", false
	}

	if first.err != nil {
		return "", false
	}
	if first.msgType != websocket.MessageText {
		closeConnection(muxWSStatusBadRequest, "invalid_json")
		return "", false
	}

	var authMsg muxWSAuthMessage
	if !decodeStrictJSONObject(first.raw, &authMsg) {
		closeConnection(muxWSStatusBadRequest, "invalid_json")
		return "", false
	}

	authReq := request.Clone(request.Context())
	if authReq.URL != nil {
		urlCopy := *authReq.URL
		urlCopy.RawQuery = ""
		authReq.URL = &urlCopy
	}
	if cred := strings.TrimSpace(authMsg.Authorization); cred != "" {
		authReq.Header.Set("Authorization", cred)
	} else {
		authReq.Header.Del("Authorization")
	}
	if !handler.authorizer.Authorized(authReq) {
		closeConnection(muxWSStatusUnauthorized, "unauthorized")
		return "", false
	}
	if strings.TrimSpace(authMsg.ServerID) != "" {
		closeConnection(muxWSStatusForbidden, "remote_server_unsupported")
		return "", false
	}

	muxID := strings.TrimSpace(authMsg.MuxID)
	if !isValidMuxWSID(muxID) {
		closeConnection(muxWSStatusBadRequest, "mux_id_required")
		return "", false
	}
	return muxID, true
}

func writeMuxWSText(parentCtx context.Context, conn *websocket.Conn, payload []byte) bool {
	if len(payload) == 0 {
		return true
	}
	writeCtx, cancel := context.WithTimeout(parentCtx, muxWSWriteTimeout)
	defer cancel()
	return conn.Write(writeCtx, websocket.MessageText, payload) == nil
}

func writeMuxWSJSON(parentCtx context.Context, conn *websocket.Conn, body any) bool {
	encoded, err := json.Marshal(body)
	if err != nil {
		return false
	}
	return writeMuxWSText(parentCtx, conn, encoded)
}
