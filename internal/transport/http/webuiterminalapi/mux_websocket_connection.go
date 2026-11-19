package webuiterminalapi

import (
	"bufio"
	"net"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// Preserve access to the actual upgraded socket: websocket.CloseNow cannot
// interrupt an already-running Close handshake in the pinned library version.
// Closing the hijacked transport after a short grace period prevents a stalled
// peer from pinning goroutines on auth rejection, overflow, or shutdown.
type muxUpgradeWriter struct {
	http.ResponseWriter
	connection net.Conn
}

func (writer *muxUpgradeWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, buffered, err := http.NewResponseController(writer.ResponseWriter).Hijack()
	if err == nil {
		writer.connection = conn
	}
	return conn, buffered, err
}

func (writer *muxUpgradeWriter) Unwrap() http.ResponseWriter {
	return writer.ResponseWriter
}

func closeMuxWSConnection(conn *websocket.Conn, transport net.Conn, code websocket.StatusCode, reason string) {
	if transport != nil {
		timer := time.AfterFunc(250*time.Millisecond, func() { _ = transport.Close() })
		defer timer.Stop()
	}
	_ = conn.Close(code, reason)
}
