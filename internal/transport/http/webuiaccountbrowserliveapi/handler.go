// Package webuiaccountbrowserliveapi exposes the loopback-only HTTP capability
// probe and first-frame authenticated WebSocket transport for the interactive
// account browser surface. It owns transport security and wire framing only;
// browser lifecycle, runtime selection, and UI integration live elsewhere.
package webuiaccountbrowserliveapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"net/netip"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/accountbrowserview"
)

// BasePath is the canonical management route prefix for the live account
// browser transport.
const BasePath = "/v1/management/webui/account-browser/live"

const (
	capabilitiesPath    = BasePath + "/capabilities"
	maxAuthTokenBytes   = 4096
	maxCommandTypeBytes = 32
	maxCommandURLBytes  = 8192
	maxCommandTextBytes = 2048
	maxCommandKeyBytes  = 64
	maxPointerButton    = 16
)

// ErrInvalidDependencies indicates that required Handler dependencies are nil.
var ErrInvalidDependencies = errors.New("webui account browser live api dependencies invalid")

var (
	errInvalidCommand = errors.New("invalid browser command")
	errEventTooLarge  = errors.New("browser event exceeds size limit")
)

// Authorizer validates WebUI management credentials on an HTTP request.
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Runtime is the transport-facing port implemented by the browser view runtime.
type Runtime interface {
	Supported() bool
	Serve(ctx context.Context, transport accountbrowserview.Transport) error
}

// Dependencies configures a live account browser HTTP/WebSocket Handler.
type Dependencies struct {
	Authorizer Authorizer
	Runtime    Runtime
}

// Handler serves capability discovery and the authenticated loopback WebSocket
// channel for a single task-scoped interactive browser surface.
type Handler struct {
	authorizer Authorizer
	runtime    Runtime
}

type capabilitiesResponse struct {
	OK                      bool   `json:"ok"`
	Supported               bool   `json:"supported"`
	Electron                bool   `json:"electron"`
	Scope                   string `json:"scope"`
	RequiresUserStart       bool   `json:"requiresUserStart"`
	MayActivateNativeWindow bool   `json:"mayActivateNativeWindow"`
}

// NewHandler validates dependencies and returns a fail-closed Handler.
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Runtime == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		runtime:    dependencies.Runtime,
	}, nil
}

// ServeHTTP enforces loopback-only peer addressing, GET-only method checks,
// and exact path routing for capabilities and WebSocket upgrade.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.authorizer == nil || h.runtime == nil {
		writeError(w, http.StatusServiceUnavailable, "browser_surface_unavailable")
		return
	}
	if !isLoopbackRemoteAddr(r.RemoteAddr) {
		writeError(w, http.StatusForbidden, "loopback_required")
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	switch r.URL.Path {
	case capabilitiesPath:
		h.serveCapabilities(w, r)
	case BasePath:
		h.serveWebSocket(w, r)
	default:
		writeError(w, http.StatusNotFound, "not_found")
	}
}

func (h *Handler) serveCapabilities(w http.ResponseWriter, r *http.Request) {
	if !h.authorizer.Authorized(r) {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	writeJSON(w, http.StatusOK, capabilitiesResponse{
		OK:                      true,
		Supported:               h.runtime.Supported(),
		Electron:                false,
		Scope:                   "single-task-window",
		RequiresUserStart:       true,
		MayActivateNativeWindow: true,
	})
}

func isLoopbackRemoteAddr(remoteAddr string) bool {
	raw := strings.TrimSpace(remoteAddr)
	if raw == "" {
		return false
	}
	if ap, err := netip.ParseAddrPort(raw); err == nil {
		return isStrictLoopback(ap.Addr())
	}
	if host, _, err := net.SplitHostPort(raw); err == nil {
		addr, parseErr := netip.ParseAddr(host)
		return parseErr == nil && isStrictLoopback(addr)
	}
	addr, err := netip.ParseAddr(raw)
	return err == nil && isStrictLoopback(addr)
}

func isStrictLoopback(addr netip.Addr) bool {
	if !addr.IsValid() || addr.Zone() != "" {
		return false
	}
	unmapped := addr.Unmap()
	return unmapped == netip.AddrFrom4([4]byte{127, 0, 0, 1}) || unmapped == netip.IPv6Loopback()
}

func decodeStrictSingleJSON(raw []byte, dst any) error {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return errInvalidCommand
	}
	dec := json.NewDecoder(bytes.NewReader(trimmed))
	dec.DisallowUnknownFields()
	if err := dec.Decode(dst); err != nil {
		return errInvalidCommand
	}
	var trailing any
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errInvalidCommand
	}
	return nil
}

func isValidBearerToken(token string) bool {
	if len(token) == 0 || len(token) > maxAuthTokenBytes || strings.TrimSpace(token) == "" {
		return false
	}
	return !strings.ContainsAny(token, "\r\n\x00")
}

func validateCommand(cmd accountbrowserview.Command) bool {
	if len(cmd.Type) == 0 || len(cmd.Type) > maxCommandTypeBytes {
		return false
	}
	switch cmd.Type {
	case "start", "navigate", "key", "text", "pointer", "scroll", "close":
	default:
		return false
	}
	if len(cmd.URL) > maxCommandURLBytes || strings.ContainsAny(cmd.URL, "\r\n\x00") {
		return false
	}
	if len(cmd.Text) > maxCommandTextBytes || strings.ContainsRune(cmd.Text, 0) {
		return false
	}
	if len(cmd.Key) > maxCommandKeyBytes || strings.ContainsAny(cmd.Key, "\r\n\x00") {
		return false
	}
	if cmd.Button < 0 || cmd.Button > maxPointerButton {
		return false
	}
	return isFinite(cmd.X) && isFinite(cmd.Y) && isFinite(cmd.DeltaX) && isFinite(cmd.DeltaY)
}

func isFinite(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]any{"ok": false, "error": code})
}
