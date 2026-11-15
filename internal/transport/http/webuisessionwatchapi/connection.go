package webuisessionwatchapi

import (
	"bufio"
	"net"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// Preserve access to the actual upgraded socket: websocket.CloseNow cannot
// interrupt an already-running Close handshake in the pinned library version.
// Closing this transport is the bounded fallback for a peer that never ACKs.
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

func (writer *watchUpgradeWriter) Unwrap() http.ResponseWriter { return writer.ResponseWriter }

func closeWatchConnection(conn *websocket.Conn, transport net.Conn, code websocket.StatusCode, reason string) {
	timer := time.AfterFunc(250*time.Millisecond, func() { _ = transport.Close() })
	defer timer.Stop()
	_ = conn.Close(code, reason)
}
