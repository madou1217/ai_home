package webuiaccountbrowserliveapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/accountbrowserview"
)

const controllerHeader = "X-AIH-Browser-Session"

// httpSession is a single, non-resumable control lease. It is not an account
// profile. The slot stays owned until Serve has finished native cleanup.
type httpSession struct {
	ctx        context.Context
	cancel     context.CancelFunc
	token      string
	scope      Scope
	commands   chan accountbrowserview.Command
	frames     chan accountbrowserview.Event
	events     chan accountbrowserview.Event
	commandMu  sync.Mutex
	started    bool
	ended      bool
	startTimer *time.Timer
}

func (s *httpSession) Receive(ctx context.Context) (accountbrowserview.Command, error) {
	if err := ctx.Err(); err != nil {
		return accountbrowserview.Command{}, err
	}
	if err := s.ctx.Err(); err != nil {
		return accountbrowserview.Command{}, err
	}
	select {
	case <-ctx.Done():
		return accountbrowserview.Command{}, ctx.Err()
	case <-s.ctx.Done():
		return accountbrowserview.Command{}, s.ctx.Err()
	case command := <-s.commands:
		if err := ctx.Err(); err != nil {
			return accountbrowserview.Command{}, err
		}
		if err := s.ctx.Err(); err != nil {
			return accountbrowserview.Command{}, err
		}
		return command, nil
	}
}

func (s *httpSession) Send(ctx context.Context, event accountbrowserview.Event) error {
	if s.ctx.Err() != nil {
		return s.ctx.Err()
	}
	raw, err := json.Marshal(event)
	if err != nil || len(raw) > maxServerEventBytes {
		return errEventTooLarge
	}
	if event.Type == "frame" {
		select {
		case s.frames <- event:
		default:
			select {
			case <-s.frames:
			default:
			}
			select {
			case s.frames <- event:
			default:
			}
		}
		return nil
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-s.ctx.Done():
		return s.ctx.Err()
	case s.events <- event:
		return nil
	}
}

func (h *Handler) serveHTTPStream(w http.ResponseWriter, r *http.Request) {
	if !h.authorizeHTTP(w, r) {
		return
	}
	var body ScopeRequest
	raw, err := readCommandBody(w, r)
	if err != nil || decodeStrictSingleJSON(raw, &body) != nil {
		writeError(w, http.StatusBadRequest, "invalid_browser_stream_request")
		return
	}
	scope, err := resolveScope(r.Context(), h.scopeResolver, body)
	if err != nil {
		writeScopeError(w, err)
		return
	}
	supported := h.runtime.Supported()
	if provider, ok := h.runtime.(interface {
		Capabilities(context.Context) accountbrowserview.Capabilities
	}); ok {
		supported = provider.Capabilities(r.Context()).Supported
	}
	if !supported {
		writeError(w, http.StatusNotImplemented, "browser_host_platform_unavailable")
		return
	}
	if _, ok := w.(http.Flusher); !ok {
		writeError(w, http.StatusInternalServerError, "browser_stream_unavailable")
		return
	}
	// Refuse wrappers/transports without enforceable write limits BEFORE a
	// control lease is published or a runtime can start. Never silently ignore
	// ErrNotSupported for a remotely accessible native-control stream.
	controller := http.NewResponseController(w)
	if err := controller.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
		writeError(w, http.StatusServiceUnavailable, "browser_stream_deadline_unavailable")
		return
	}
	if err := controller.SetWriteDeadline(time.Time{}); err != nil {
		writeError(w, http.StatusServiceUnavailable, "browser_stream_deadline_unavailable")
		return
	}
	tokenBytes := make([]byte, 32)
	if _, err = rand.Read(tokenBytes); err != nil {
		writeError(w, http.StatusServiceUnavailable, "browser_stream_unavailable")
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	session := &httpSession{ctx: ctx, cancel: cancel, token: hex.EncodeToString(tokenBytes), scope: scope, commands: make(chan accountbrowserview.Command, 8), frames: make(chan accountbrowserview.Event, 1), events: make(chan accountbrowserview.Event, 8)}
	h.streamMu.Lock()
	if h.stream != nil {
		h.streamMu.Unlock()
		cancel()
		writeError(w, http.StatusConflict, "browser_surface_already_controlled")
		return
	}
	session.startTimer = time.AfterFunc(15*time.Second, cancel)
	h.stream = session
	h.streamMu.Unlock()
	defer cancel()
	defer session.startTimer.Stop()
	done := make(chan error, 1)
	go func() {
		var serveErr error
		if scope.Kind == ScopeAccount {
			if scope.ProxyURL != "" || scope.ProxyRequired {
				proxyScoped, ok := h.runtime.(ProxyScopedRuntime)
				if !ok {
					serveErr = ErrScopeUnavailable
				} else {
					serveErr = proxyScoped.ServeScopedWithOptions(ctx, session, accountbrowserview.ScopedOptions{DataDir: scope.DataDir, ProxyURL: scope.ProxyURL})
				}
			} else if scoped, ok := h.runtime.(ScopedRuntime); !ok {
				serveErr = ErrScopeUnavailable
			} else {
				serveErr = scoped.ServeScoped(ctx, session, scope.DataDir)
			}
		} else {
			serveErr = h.runtime.Serve(ctx, session)
		}
		err := serveErr
		session.commandMu.Lock()
		session.ended = true
		session.commandMu.Unlock()
		h.streamMu.Lock()
		if h.stream == session {
			h.stream = nil
		}
		h.streamMu.Unlock()
		done <- err
	}()
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-store, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	write := func(event any) (result error) {
		raw, err := json.Marshal(event)
		if err != nil || len(raw) > maxServerEventBytes {
			return errEventTooLarge
		}
		if err = controller.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
			return err
		}
		// Deadlines apply to one publication, not the idle time between frames.
		defer func() {
			if clear := controller.SetWriteDeadline(time.Time{}); result == nil {
				result = clear
			}
		}()
		if _, err = w.Write(append(raw, '\n')); err != nil {
			return err
		}
		return controller.Flush()
	}
	if err = write(struct {
		Type  string `json:"type"`
		Token string `json:"controlToken"`
	}{"session", session.token}); err != nil {
		return
	}
	heartbeat := time.NewTicker(5 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case err := <-done:
			for len(session.events) > 0 {
				if write(<-session.events) != nil {
					return
				}
			}
			if err != nil && !errors.Is(err, context.Canceled) {
				code := accountbrowserview.PublicErrorCode(err)
				_ = write(accountbrowserview.Event{Type: "error", Error: code})
			}
			return
		case <-r.Context().Done():
			return
		case <-ctx.Done():
			// Serve may still be shutting down. Its goroutine retains the slot and
			// all commands already see cancellation; returning cannot transfer it.
			return
		case event := <-session.events:
			if write(event) != nil {
				return
			}
		case event := <-session.frames:
			if write(event) != nil {
				return
			}
		case <-heartbeat.C:
			if write(accountbrowserview.Event{Type: "heartbeat"}) != nil {
				return
			}
		}
	}
}
