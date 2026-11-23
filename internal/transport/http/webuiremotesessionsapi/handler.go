// Package webuiremotesessionsapi exposes the canonical remote execution list
// and stop action to the WebUI.
package webuiremotesessionsapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/remotesessions"
)

const (
	Path       = "/v1/management/webui/remote-execution/sessions"
	DetailPath = Path + "/{sessionId}"
	StopPath   = Path + "/{sessionId}/stop"
)

type Authorizer interface {
	Authorized(*http.Request) bool
}

type Dependencies struct {
	Authorizer Authorizer
	Store      *remotesessions.Store
	// TerminalStatus returns running/exited for a terminal id, or "" when the
	// terminal service no longer knows it.
	TerminalStatus func(termID string) string
	StopTerminal   func(termID string) error
}

type Handler struct {
	authorizer     Authorizer
	store          *remotesessions.Store
	terminalStatus func(termID string) string
	stopTerminal   func(termID string) error
}

func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil {
		return nil, remotesessions.ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer, store: dependencies.Store,
		terminalStatus: dependencies.TerminalStatus, stopTerminal: dependencies.StopTerminal,
	}, nil
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if !handler.authorizer.Authorized(request) {
		writeJSON(response, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
		return
	}
	switch {
	case request.Method == http.MethodGet && request.URL.Path == Path:
		handler.list(response, request)
	case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/") == false && strings.HasPrefix(request.URL.Path, Path+"/"):
		handler.detail(response, request)
	case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/stop"):
		handler.stop(response, request)
	default:
		writeJSON(response, http.StatusNotFound, map[string]any{"ok": false, "error": "not_found"})
	}
}

func (handler *Handler) list(response http.ResponseWriter, request *http.Request) {
	records, err := handler.store.List(request.Context())
	if err != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "session_store_unavailable"})
		return
	}
	views := make([]remotesessions.Session, 0, len(records))
	for _, record := range records {
		if record.Status == remotesessions.StatusRunning && record.TermID != "" && handler.terminalStatus != nil {
			switch handler.terminalStatus(record.TermID) {
			case "running":
			case "exited":
				record.Status = remotesessions.StatusExited
				_ = handler.store.MarkExited(request.Context(), record.ID)
			default:
				record.Status = remotesessions.StatusUnknown
			}
		}
		views = append(views, record)
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "count": len(views), "sessions": views})
}

func (handler *Handler) detail(response http.ResponseWriter, request *http.Request) {
	sessionID := strings.TrimSpace(request.PathValue("sessionId"))
	if sessionID == "" {
		writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "session_id_required"})
		return
	}
	record, found, err := handler.store.Find(request.Context(), sessionID)
	if err != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "session_store_unavailable"})
		return
	}
	if !found {
		writeJSON(response, http.StatusNotFound, map[string]any{"ok": false, "error": "session_not_found"})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "session": record})
}

func (handler *Handler) stop(response http.ResponseWriter, request *http.Request) {
	sessionID := strings.TrimSpace(request.PathValue("sessionId"))
	if sessionID == "" {
		writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "session_id_required"})
		return
	}
	record, found, err := handler.store.Find(request.Context(), sessionID)
	if err != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "session_store_unavailable"})
		return
	}
	if !found {
		writeJSON(response, http.StatusNotFound, map[string]any{"ok": false, "error": "session_not_found"})
		return
	}
	if record.TermID != "" && handler.stopTerminal != nil {
		if err := handler.stopTerminal(record.TermID); err != nil {
			writeJSON(response, http.StatusConflict, map[string]any{"ok": false, "error": "terminal_stop_failed"})
			return
		}
	}
	updated, err := handler.store.Close(request.Context(), sessionID)
	if err != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "session_store_unavailable"})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "session": updated})
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}
