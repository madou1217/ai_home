package webuiwatchws

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/madou1217/ai_home/internal/transport/http/websameorigin"
)

const (
	// Path is the management WebSocket contract path for multiplexed WebUI watches.
	Path = "/v1/management/webui/watch/ws"
	// PublicPath is the browser WebSocket contract path for multiplexed WebUI watches.
	PublicPath = "/v0/webui/watch/ws"

	maxWatchSubIDBytes = 128

	wsStatusBadRequest   websocket.StatusCode = 4400
	wsStatusUnauthorized websocket.StatusCode = 4401
	wsStatusForbidden    websocket.StatusCode = 4403
)

// allowedWatchPaths enumerates the exact canonical WebUI SSE watch paths that
// may be multiplexed over /v0/webui/watch/ws. No query strings, fragments,
// path traversal, or recursive /watch/ws paths are permitted.
var allowedWatchPaths = map[string]struct{}{
	"/v0/webui/accounts/watch":                                     {},
	"/v0/webui/tasks/watch":                                        {},
	"/v0/webui/projects/watch":                                     {},
	"/v0/webui/management/watch":                                   {},
	"/v0/webui/peer/messages/watch":                                {},
	"/v0/webui/egress-upstreams/watch":                             {},
	"/v0/webui/ssh-connections/tunnels/watch":                      {},
	"/v0/webui/openai-models/watch":                                {},
	"/v0/webui/management/usage/dashboard/query/watch":             {},
	"/v0/webui/management/usage/scan/watch":                        {},
	"/v0/webui/toolkit/subscription-aggregator/sources/sync/watch": {},
}

// watchUpgradeWriter captures the underlying net.Conn during WebSocket upgrade
// so closeWatchWSConnection can enforce a 250ms forced-close fallback if a
// peer never ACKs the WebSocket Close control frame.
type watchUpgradeWriter struct {
	http.ResponseWriter
	connection net.Conn
}

func (writer *watchUpgradeWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, buffered, err := http.NewResponseController(writer.ResponseWriter).Hijack()
	if err == nil {
		writer.connection = conn
	}
	return conn, buffered, err
}

func (writer *watchUpgradeWriter) Unwrap() http.ResponseWriter {
	return writer.ResponseWriter
}

func closeWatchWSConnection(conn *websocket.Conn, transport net.Conn, code websocket.StatusCode, reason string) {
	if conn == nil {
		return
	}
	var timer *time.Timer
	if transport != nil {
		timer = time.AfterFunc(250*time.Millisecond, func() {
			_ = transport.Close()
		})
		defer timer.Stop()
	}
	_ = conn.Close(code, reason)
}

// isSameOriginWatchWSRequest 判定浏览器 WS 握手是否同源。
//
// scheme 由共享判定从「TLS 状态或可信本地反代的 X-Forwarded-Proto」推导，
// 避免 Cloudflare 终止 TLS 时把 https origin 误判成跨源。
func isSameOriginWatchWSRequest(request *http.Request) bool {
	return websameorigin.Matches(request, true)
}

func hasRemoteServerTarget(request *http.Request) bool {
	if request == nil {
		return false
	}
	if strings.TrimSpace(request.Header.Get("X-Aih-Server-Id")) != "" {
		return true
	}
	if request.URL == nil || request.URL.RawQuery == "" {
		return false
	}
	query, err := url.ParseQuery(request.URL.RawQuery)
	if err != nil {
		return true
	}
	for key, values := range query {
		if strings.EqualFold(key, "x-aih-server-id") && len(values) > 0 && strings.TrimSpace(values[0]) != "" {
			return true
		}
	}
	return false
}

func isValidWatchSubID(id string) bool {
	if id == "" || len(id) > maxWatchSubIDBytes {
		return false
	}
	for i := 0; i < len(id); i++ {
		if id[i] < 0x21 || id[i] > 0x7e {
			return false
		}
	}
	return true
}

func normalizeAllowedWatchPath(rawPath string) (string, bool) {
	if rawPath == "" || strings.ContainsAny(rawPath, "?#\\ \t\r\n") || strings.Contains(rawPath, "..") {
		return "", false
	}
	if _, ok := allowedWatchPaths[rawPath]; !ok {
		return "", false
	}
	return rawPath, true
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

func writeJSONError(response http.ResponseWriter, status int, code, message string) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	encoder := json.NewEncoder(response)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(map[string]any{
		"ok":      false,
		"error":   code,
		"message": message,
	})
}

// activeConn tracks an admitted WebSocket request across pre-accept, pre-auth,
// and established session phases so Handler.Close can deterministically cancel
// and force-close every in-flight transport without leaking handshakes.
type activeConn struct {
	mu        sync.Mutex
	aborted   bool
	cancel    context.CancelFunc
	conn      *websocket.Conn
	transport net.Conn
	onAbort   func()
}

func (entry *activeConn) attachTransport(conn *websocket.Conn, transport net.Conn) bool {
	entry.mu.Lock()
	entry.conn = conn
	entry.transport = transport
	aborted := entry.aborted
	entry.mu.Unlock()
	if aborted {
		if conn != nil {
			_ = conn.CloseNow()
		}
		if transport != nil {
			_ = transport.Close()
		}
		return false
	}
	return true
}

func (entry *activeConn) attachSessionAbort(onAbort func()) bool {
	entry.mu.Lock()
	entry.onAbort = onAbort
	aborted := entry.aborted
	entry.mu.Unlock()
	if aborted && onAbort != nil {
		onAbort()
		return false
	}
	return !aborted
}

func (entry *activeConn) abort() {
	entry.mu.Lock()
	if entry.aborted {
		entry.mu.Unlock()
		return
	}
	entry.aborted = true
	cancel := entry.cancel
	conn := entry.conn
	transport := entry.transport
	onAbort := entry.onAbort
	entry.mu.Unlock()

	if onAbort != nil {
		// Session owns sending the bounded 1001 Close frame before canceling connCtx.
		onAbort()
		return
	}
	if cancel != nil {
		cancel()
	}
	if conn != nil {
		_ = conn.CloseNow()
	}
	if transport != nil {
		_ = transport.Close()
	}
}
