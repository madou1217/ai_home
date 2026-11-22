package webuisessionwatchapi

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/madou1217/ai_home/internal/runtime/sessionevents"
	"github.com/madou1217/ai_home/internal/transport/http/websameorigin"
)

const (
	maxWSAuthFrameBytes = 16 * 1024

	wsStatusBadRequest   websocket.StatusCode = 4400
	wsStatusUnauthorized websocket.StatusCode = 4401
)

type wsAuthMessage struct {
	Authorization  string `json:"authorization"`
	Provider       string `json:"provider"`
	SessionID      string `json:"sessionId"`
	ProjectDirName string `json:"projectDirName"`
}

func isWebSocketWatchRequest(request *http.Request) bool {
	if request == nil {
		return false
	}
	if request.URL != nil && strings.HasSuffix(strings.TrimSpace(request.URL.Path), "/ws") {
		return true
	}
	return strings.EqualFold(strings.TrimSpace(request.Header.Get("Upgrade")), "websocket")
}

func isSameOriginWSRequest(request *http.Request) bool {
	// 与 watch WS / 终端 mux 共用同一套同源判定，避免三处 scheme 规则漂移。
	return websameorigin.Matches(request, true)
}

func (handler *Handler) serveWebSocket(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]any{
			"ok":      false,
			"error":   "method_not_allowed",
			"message": "仅支持 GET",
		})
		return
	}
	if !isSameOriginWSRequest(request) {
		writeJSON(response, http.StatusForbidden, map[string]any{
			"ok":      false,
			"error":   "forbidden",
			"message": "跨源 WebSocket 握手被拒绝",
		})
		return
	}

	upgrade := &watchUpgradeWriter{ResponseWriter: response}
	conn, err := websocket.Accept(upgrade, request, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	closeConnection := func(code websocket.StatusCode, reason string) {
		closeWatchConnection(conn, upgrade.connection, code, reason)
	}
	conn.SetReadLimit(maxWSAuthFrameBytes)
	defer func() {
		_ = conn.CloseNow()
	}()

	target, ok := handler.authenticateFirstWSFrame(request, conn, closeConnection)
	if !ok {
		return
	}

	eventsCh, doneCh, unsubscribe := handler.bus.Subscribe(target, true)
	defer unsubscribe()

	select {
	case <-doneCh:
		closeConnection(websocket.StatusInternalError, "upstream_closed")
		return
	default:
	}

	connCtx, cancelConn := context.WithCancel(request.Context())
	// 总线生命周期结束必须显式以 1011 关闭：只 cancel 会让主循环走 connCtx.Done 分支
	// 静默返回，客户端只能看到 EOF，拿不到上游关闭语义。
	stopOnBusClose := context.AfterFunc(handler.bus.Context(), func() {
		closeConnection(websocket.StatusInternalError, "upstream_closed")
		cancelConn()
	})
	defer stopOnBusClose()
	defer cancelConn()

	if !handler.writeWSJSON(connCtx, conn, map[string]string{"type": "connected"}) {
		return
	}

	// 独立读取协程消费客户端控制帧（Pong / Close），并在客户端断开时立即唤醒主循环退出。
	var readerWG sync.WaitGroup
	readerWG.Add(1)
	go func() {
		defer readerWG.Done()
		defer cancelConn()
		for {
			_, reader, readErr := conn.Reader(connCtx)
			if readErr != nil {
				return
			}
			// The established channel is server-to-client. Consume legacy extra
			// messages without allocating a whole payload for each discarded frame.
			if _, readErr = io.Copy(io.Discard, reader); readErr != nil {
				return
			}
		}
	}()
	defer func() {
		cancelConn()
		_ = conn.CloseNow()
		readerWG.Wait()
	}()

	pingTicker := time.NewTicker(handler.wsHeartbeatInterval)
	defer pingTicker.Stop()

	for {
		select {
		case <-connCtx.Done():
			return
		case <-doneCh:
			closeConnection(websocket.StatusInternalError, "upstream_closed")
			return
		case <-pingTicker.C:
			pingCtx, cancelPing := context.WithTimeout(connCtx, handler.wsWriteTimeout)
			pingErr := conn.Ping(pingCtx)
			cancelPing()
			if pingErr != nil {
				return
			}
		case event := <-eventsCh:
			for _, item := range drainCoalescedWatchBatch(event, eventsCh) {
				payload := handler.buildPayload(target, item)
				if !handler.writeWSJSON(connCtx, conn, payload) {
					return
				}
			}
		}
	}
}

type wsFirstFrameResult struct {
	msgType websocket.MessageType
	raw     []byte
	err     error
}

func (handler *Handler) authenticateFirstWSFrame(
	request *http.Request,
	conn *websocket.Conn,
	closeConnection func(websocket.StatusCode, string),
) (sessionevents.Session, bool) {
	readCtx, cancelRead := context.WithCancel(request.Context())
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
		// 先发送标准 1008 Close 控制帧，再以短宽限期兜底防恶意半开 TCP 挂死。
		closeConnection(websocket.StatusPolicyViolation, "auth_timeout")
		cancelRead()
		<-readCh
		return sessionevents.Session{}, false
	case <-handler.bus.Done():
		cancelRead()
		<-readCh
		return sessionevents.Session{}, false
	case <-request.Context().Done():
		cancelRead()
		<-readCh
		return sessionevents.Session{}, false
	}

	if first.err != nil {
		return sessionevents.Session{}, false
	}
	msgType, raw := first.msgType, first.raw
	if msgType != websocket.MessageText {
		closeConnection(wsStatusBadRequest, "invalid_json")
		return sessionevents.Session{}, false
	}

	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		closeConnection(wsStatusBadRequest, "invalid_json")
		return sessionevents.Session{}, false
	}
	var authMsg wsAuthMessage
	if err := json.Unmarshal(trimmed, &authMsg); err != nil {
		closeConnection(wsStatusBadRequest, "invalid_json")
		return sessionevents.Session{}, false
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
	if !handler.authorizeWatchFrame(request, authReq) {
		closeConnection(wsStatusUnauthorized, "webui_unauthorized")
		return sessionevents.Session{}, false
	}

	target, valid := parseWatchSessionTarget(authMsg.Provider, authMsg.SessionID, authMsg.ProjectDirName)
	if !valid {
		closeConnection(wsStatusBadRequest, "missing_params")
		return sessionevents.Session{}, false
	}
	return target, true
}

func (handler *Handler) writeWSJSON(parentCtx context.Context, conn *websocket.Conn, body any) bool {
	encoded, err := json.Marshal(body)
	if err != nil {
		return false
	}
	writeCtx, cancel := context.WithTimeout(parentCtx, handler.wsWriteTimeout)
	defer cancel()
	if err := conn.Write(writeCtx, websocket.MessageText, encoded); err != nil {
		return false
	}
	return true
}
