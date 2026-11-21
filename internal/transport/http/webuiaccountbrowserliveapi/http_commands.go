package webuiaccountbrowserliveapi

import (
	"context"
	"crypto/subtle"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/accountbrowserview"
)

func (h *Handler) authorizeHTTP(w http.ResponseWriter, r *http.Request) bool {
	if !h.authorizer.Authorized(r) {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return false
	}
	return true
}

func readCommandBody(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	r.Body = http.MaxBytesReader(w, r.Body, maxClientMessageBytes)
	defer r.Body.Close()
	return io.ReadAll(r.Body)
}

func (h *Handler) serveHTTPCommand(w http.ResponseWriter, r *http.Request) {
	if !h.authorizeHTTP(w, r) {
		return
	}
	token := r.Header.Get(controllerHeader)
	if len(token) != 64 || strings.ContainsAny(token, "\r\n\x00") {
		writeError(w, http.StatusForbidden, "browser_control_lease_invalid")
		return
	}
	h.streamMu.Lock()
	session := h.stream
	h.streamMu.Unlock()
	if session == nil || subtle.ConstantTimeCompare([]byte(token), []byte(session.token)) != 1 || session.ctx.Err() != nil {
		writeError(w, http.StatusGone, "browser_control_lease_expired")
		return
	}
	raw, err := readCommandBody(w, r)
	var command accountbrowserview.Command
	if err != nil || decodeStrictSingleJSON(raw, &command) != nil || !validateCommand(command) {
		writeError(w, http.StatusBadRequest, "invalid_browser_command")
		return
	}
	status, code := session.enqueue(command)
	if code != "" {
		writeError(w, status, code)
		return
	}
	writeJSON(w, status, map[string]bool{"ok": true})
}

// Only state/queue work holds the session lock. A slow HTTP acknowledgement
// must never prevent cancellation, runtime completion or another controller.
func (session *httpSession) enqueue(command accountbrowserview.Command) (int, string) {
	session.commandMu.Lock()
	defer session.commandMu.Unlock()
	if session.ctx.Err() != nil || session.ended {
		return http.StatusGone, "browser_control_lease_expired"
	}
	if command.Type == "close" {
		session.cancel()
		return http.StatusAccepted, ""
	}
	if !session.started && command.Type != "start" {
		return http.StatusConflict, "browser_start_required"
	}
	if session.started && command.Type == "start" {
		return http.StatusConflict, "browser_already_started"
	}
	select {
	case <-session.ctx.Done():
		return http.StatusGone, "browser_control_lease_expired"
	case session.commands <- command:
		if command.Type == "start" {
			session.started = true
			session.startTimer.Stop()
		}
		return http.StatusAccepted, ""
	default:
		session.cancel()
		return http.StatusTooManyRequests, "browser_control_backpressure"
	}
}

func resolveScope(ctx context.Context, resolver ScopeResolver, request ScopeRequest) (Scope, error) {
	request.Scope = strings.TrimSpace(request.Scope)
	request.Provider = strings.TrimSpace(request.Provider)
	request.AccountRef = strings.TrimSpace(request.AccountRef)
	if request.Scope == "" {
		request.Scope = ScopeTask
	}
	switch request.Scope {
	case ScopeTask:
		if request.Provider != "" || request.AccountRef != "" {
			return Scope{}, ErrInvalidScope
		}
		return Scope{Kind: ScopeTask}, nil
	case ScopeAccount:
		if request.Provider == "" || request.AccountRef == "" || resolver == nil {
			return Scope{}, ErrAccountScopeRequired
		}
		resolved, err := resolver.Resolve(ctx, request)
		if err != nil {
			return Scope{}, err
		}
		if resolved.Kind != ScopeAccount || strings.TrimSpace(resolved.DataDir) == "" {
			return Scope{}, ErrScopeUnavailable
		}
		return resolved, nil
	default:
		return Scope{}, ErrInvalidScope
	}
}

func writeScopeError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrInvalidScope):
		writeError(w, http.StatusBadRequest, "invalid_browser_scope")
	case errors.Is(err, ErrAccountScopeRequired):
		writeError(w, http.StatusBadRequest, "browser_account_scope_required")
	case errors.Is(err, ErrScopeUnavailable):
		writeError(w, http.StatusServiceUnavailable, "browser_account_scope_unavailable")
	default:
		writeError(w, http.StatusNotFound, "browser_account_not_found")
	}
}
