package webuisessionwatchapi

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net"
	"net/http"
	"strings"
)

// Legacy Node-first deployments can use a separate internal Go management key.
// The transport adapter passes a digest of its current external key on an authenticated
// loopback handshake. No client-provided header or query can mint this authority.
const watchBridgeKeyHeader = "X-Aih-Watch-Credential-SHA256"

func (handler *Handler) authorizeWatchFrame(handshake, frame *http.Request) bool {
	encoded := handshake.Header.Get(watchBridgeKeyHeader)
	if encoded == "" {
		return handler.authorizer.Authorized(frame)
	}
	host, _, err := net.SplitHostPort(handshake.RemoteAddr)
	if err != nil || !net.ParseIP(strings.Trim(host, "[]")).IsLoopback() || !handler.authorizer.Authorized(handshake) {
		return false
	}
	if len(encoded) != sha256.Size*2 {
		return false
	}
	expected, err := hex.DecodeString(encoded)
	if err != nil || len(expected) != sha256.Size {
		return false
	}
	parts := strings.Fields(frame.Header.Get("Authorization"))
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return false
	}
	actual := sha256.Sum256([]byte(parts[1]))
	return subtle.ConstantTimeCompare(actual[:], expected) == 1
}
