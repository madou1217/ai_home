package webuiaccountbrowserliveapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/madou1217/ai_home/internal/runtime/accountbrowserview"
)

const (
	authTimeout           = 5 * time.Second
	writeTimeout          = 3 * time.Second
	maxClientMessageBytes = 8 * 1024
	maxServerEventBytes   = 2 * 1024 * 1024
)

type wsAuthMessage struct {
	Type  string `json:"type"`
	Token string `json:"token"`
}

type firstFrameResult struct {
	msgType websocket.MessageType
	raw     []byte
	err     error
}

func (h *Handler) serveWebSocket(w http.ResponseWriter, r *http.Request) {
	// Rely on coder/websocket default Origin verification (same-origin when
	// Origin is present; no InsecureSkipVerify or wildcard OriginPatterns).
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	defer func() { _ = conn.CloseNow() }()

	conn.SetReadLimit(maxClientMessageBytes)
	if !h.authenticateFirstFrame(r, conn) {
		return
	}
	conn.SetReadLimit(maxClientMessageBytes)

	sessionCtx, cancelSession := context.WithCancel(r.Context())
	defer cancelSession()

	transport := &wsTransport{ctx: sessionCtx, cancel: cancelSession, conn: conn}
	if err := transport.Send(sessionCtx, accountbrowserview.Event{Type: "authorized"}); err != nil {
		return
	}

	serveErr := h.runtime.Serve(sessionCtx, transport)
	cancelSession()
	if serveErr == nil || isNormalCloseOrCancel(serveErr, r.Context()) {
		_ = conn.Close(websocket.StatusNormalClosure, "closed")
		return
	}

	errCtx, cancelErr := context.WithTimeout(context.Background(), writeTimeout)
	defer cancelErr()
	_ = transport.writeEvent(errCtx, accountbrowserview.Event{
		Type:  "error",
		Error: accountbrowserview.PublicErrorCode(serveErr),
	})
	closeCode := websocket.StatusInternalError
	if errors.Is(serveErr, errInvalidCommand) {
		closeCode = websocket.StatusPolicyViolation
	}
	_ = conn.Close(closeCode, "browser_surface_unavailable")
}

func (h *Handler) authenticateFirstFrame(r *http.Request, conn *websocket.Conn) bool {
	readCtx, cancelRead := context.WithCancel(r.Context())
	readCh := make(chan firstFrameResult, 1)
	go func() {
		msgType, raw, err := conn.Read(readCtx)
		readCh <- firstFrameResult{msgType: msgType, raw: raw, err: err}
	}()

	timer := time.NewTimer(authTimeout)
	defer timer.Stop()

	var first firstFrameResult
	select {
	case first = <-readCh:
		cancelRead()
	case <-timer.C:
		_ = conn.Close(websocket.StatusPolicyViolation, "auth_timeout")
		cancelRead()
		<-readCh
		return false
	case <-r.Context().Done():
		cancelRead()
		<-readCh
		return false
	}

	defer clear(first.raw)
	if first.err != nil {
		return false
	}
	var msg wsAuthMessage
	if first.msgType != websocket.MessageText || len(first.raw) == 0 || len(first.raw) > maxClientMessageBytes ||
		decodeStrictSingleJSON(first.raw, &msg) != nil {
		_ = conn.Close(websocket.StatusPolicyViolation, "unauthorized")
		return false
	}
	token := msg.Token
	msg.Token = ""
	if msg.Type != "auth" || !isValidBearerToken(token) || !h.authorizeBearerToken(r, token) {
		token = ""
		_ = conn.Close(websocket.StatusPolicyViolation, "unauthorized")
		return false
	}
	token = ""
	return true
}

func (h *Handler) authorizeBearerToken(r *http.Request, token string) bool {
	cloned := r.Clone(r.Context())
	if cloned.URL != nil {
		u := *cloned.URL
		u.RawQuery, u.Fragment = "", ""
		cloned.URL = &u
	}
	for _, hdr := range []string{"Authorization", "Cookie", "X-Management-Key", "X-Api-Key"} {
		cloned.Header.Del(hdr)
	}
	cloned.Header.Set("Authorization", "Bearer "+token)
	authorized := h.authorizer.Authorized(cloned)
	cloned.Header.Del("Authorization")
	return authorized
}

type wsTransport struct {
	ctx    context.Context
	cancel context.CancelFunc
	conn   *websocket.Conn
	sendMu sync.Mutex
}

func (t *wsTransport) Receive(ctx context.Context) (accountbrowserview.Command, error) {
	if ctx == nil {
		ctx = t.ctx
	}
	if err := t.ctx.Err(); err != nil {
		return accountbrowserview.Command{}, err
	}
	msgType, raw, err := t.conn.Read(ctx)
	if err != nil {
		t.cancel()
		return accountbrowserview.Command{}, err
	}
	if msgType != websocket.MessageText || len(raw) == 0 || len(raw) > maxClientMessageBytes {
		t.cancel()
		return accountbrowserview.Command{}, errInvalidCommand
	}
	var cmd accountbrowserview.Command
	if err := decodeStrictSingleJSON(raw, &cmd); err != nil || !validateCommand(cmd) {
		t.cancel()
		return accountbrowserview.Command{}, errInvalidCommand
	}
	return cmd, nil
}

func (t *wsTransport) Send(ctx context.Context, event accountbrowserview.Event) error {
	if ctx == nil {
		ctx = t.ctx
	}
	if err := t.ctx.Err(); err != nil {
		return err
	}
	writeCtx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	stopCancel := context.AfterFunc(t.ctx, cancel)
	defer stopCancel()

	if err := t.writeEvent(writeCtx, event); err != nil {
		t.cancel()
		return err
	}
	return nil
}

func (t *wsTransport) writeEvent(ctx context.Context, event accountbrowserview.Event) error {
	payload, err := json.Marshal(event)
	if err != nil {
		return err
	}
	if len(payload) > maxServerEventBytes {
		return errEventTooLarge
	}
	t.sendMu.Lock()
	defer t.sendMu.Unlock()
	return t.conn.Write(ctx, websocket.MessageText, payload)
}

func isNormalCloseOrCancel(err error, reqCtx context.Context) bool {
	if reqCtx != nil && reqCtx.Err() != nil {
		return true
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, io.EOF) {
		return true
	}
	code := websocket.CloseStatus(err)
	return code == websocket.StatusNormalClosure || code == websocket.StatusGoingAway
}
