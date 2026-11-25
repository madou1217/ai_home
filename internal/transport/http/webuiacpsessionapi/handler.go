package webuiacpsessionapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/remoteconnector"
	"github.com/madou1217/ai_home/internal/runtime/acpsession"
	"github.com/madou1217/ai_home/internal/runtime/workspaceconnector"
)

const (
	BasePath     = remoteconnector.ManagementPath + "/{workspaceId}/acp-sessions"
	DetailPath   = BasePath + "/{sessionId}"
	EventsPath   = DetailPath + "/events"
	PromptPath   = DetailPath + "/prompt"
	ApprovalPath = DetailPath + "/approvals/{approvalId}"
	maxBodyBytes = 1 << 20
)

type Authorizer interface {
	Authorized(*http.Request) bool
}

type WorkspaceReader interface {
	Find(context.Context, string) (workspaceconnector.Workspace, bool, error)
}

type Dependencies struct {
	Authorizer Authorizer
	Manager    *acpsession.Manager
	Workspaces WorkspaceReader
	Online     func(string) bool
}

type Handler struct {
	authorizer Authorizer
	manager    *acpsession.Manager
	workspaces WorkspaceReader
	online     func(string) bool
}

func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Manager == nil || dependencies.Workspaces == nil {
		return nil, fmt.Errorf("acp session handler dependencies are invalid")
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		manager:    dependencies.Manager,
		workspaces: dependencies.Workspaces,
		online:     dependencies.Online,
	}, nil
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if !handler.authorizer.Authorized(request) {
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	workspaceID := strings.TrimSpace(request.PathValue("workspaceId"))
	sessionID := strings.TrimSpace(request.PathValue("sessionId"))
	approvalID := strings.TrimSpace(request.PathValue("approvalId"))
	switch {
	case request.Method == http.MethodPost && sessionID == "":
		handler.start(response, request, workspaceID)
	case request.Method == http.MethodGet && sessionID != "" && approvalID == "" && !strings.HasSuffix(request.URL.Path, "/events"):
		handler.view(response, sessionID)
	case request.Method == http.MethodDelete && sessionID != "":
		handler.close(response, sessionID)
	case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/events"):
		handler.events(response, request, sessionID)
	case request.Method == http.MethodPost && strings.HasSuffix(request.URL.Path, "/prompt"):
		handler.prompt(response, request, sessionID)
	case request.Method == http.MethodPost && approvalID != "":
		handler.decideApproval(response, request, sessionID, approvalID)
	default:
		writeError(response, http.StatusNotFound, "route_not_found", "route not found")
	}
}

func (handler *Handler) start(response http.ResponseWriter, request *http.Request, workspaceID string) {
	if workspaceID == "" {
		writeError(response, http.StatusBadRequest, "workspace_not_found", "workspace id is required")
		return
	}
	workspace, found, err := handler.workspaces.Find(request.Context(), workspaceID)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "workspace_read_failed", err.Error())
		return
	}
	if !found {
		writeError(response, http.StatusNotFound, "workspace_not_found", "workspace not found")
		return
	}
	if workspace.Revoked() {
		writeError(response, http.StatusConflict, "workspace_revoked", "workspace revoked")
		return
	}
	if handler.online != nil && !handler.online(workspaceID) {
		writeError(response, http.StatusConflict, "workspace_offline", "workspace connector is offline")
		return
	}
	view, err := handler.manager.Start(request.Context(), acpsession.StartRequest{WorkspaceID: workspaceID})
	if err != nil {
		writeError(response, http.StatusUnprocessableEntity, "acp_start_failed", err.Error())
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "session": view})
}

func (handler *Handler) view(response http.ResponseWriter, sessionID string) {
	session, ok := handler.manager.Get(sessionID)
	if !ok {
		writeError(response, http.StatusNotFound, "session_not_found", "session not found")
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "session": session.View()})
}

func (handler *Handler) close(response http.ResponseWriter, sessionID string) {
	if err := handler.manager.Close(sessionID); err != nil {
		writeError(response, http.StatusNotFound, "session_not_found", err.Error())
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true})
}

func (handler *Handler) prompt(response http.ResponseWriter, request *http.Request, sessionID string) {
	session, ok := handler.manager.Get(sessionID)
	if !ok {
		writeError(response, http.StatusNotFound, "session_not_found", "session not found")
		return
	}
	var body struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxBodyBytes)).Decode(&body); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_json", "invalid request")
		return
	}
	if strings.TrimSpace(body.Content) == "" {
		writeError(response, http.StatusBadRequest, "invalid_prompt", "prompt is required")
		return
	}
	// Prompt can take minutes; the stream carries progress and errors.
	go func() { _, _ = session.Prompt(context.Background(), body.Content) }()
	writeJSON(response, http.StatusAccepted, map[string]any{"ok": true})
}

func (handler *Handler) decideApproval(response http.ResponseWriter, request *http.Request, sessionID, approvalID string) {
	session, ok := handler.manager.Get(sessionID)
	if !ok {
		writeError(response, http.StatusNotFound, "session_not_found", "session not found")
		return
	}
	var body struct {
		Approve bool `json:"approve"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxBodyBytes)).Decode(&body); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_json", "invalid request")
		return
	}
	if err := session.Decide(approvalID, body.Approve); err != nil {
		writeError(response, http.StatusConflict, "approval_unavailable", err.Error())
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true})
}

func (handler *Handler) events(response http.ResponseWriter, request *http.Request, sessionID string) {
	session, ok := handler.manager.Get(sessionID)
	if !ok {
		writeError(response, http.StatusNotFound, "session_not_found", "session not found")
		return
	}
	after, _ := strconv.ParseInt(strings.TrimSpace(request.URL.Query().Get("after")), 10, 64)
	snapshot, channel, cancel := session.Subscribe(after)
	defer cancel()

	flusher, ok := response.(http.Flusher)
	if !ok {
		writeError(response, http.StatusInternalServerError, "stream_unavailable", "streaming is unavailable")
		return
	}
	response.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	response.Header().Set("Cache-Control", "no-cache")
	response.Header().Set("Connection", "keep-alive")
	response.Header().Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)
	writeEvent := func(event acpsession.Event) bool {
		raw, err := json.Marshal(event)
		if err != nil {
			return false
		}
		if _, err := fmt.Fprintf(response, "id: %d\nevent: acp\ndata: %s\n\n", event.Seq, raw); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	for _, event := range snapshot {
		if !writeEvent(event) {
			return
		}
	}
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()
	for {
		select {
		case event := <-channel:
			if !writeEvent(event) {
				return
			}
		case <-heartbeat.C:
			if _, err := fmt.Fprint(response, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-request.Context().Done():
			return
		}
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, map[string]any{"ok": false, "error": code, "message": message})
}
