// Package webuiagysessionapi 暴露常驻 AGY 会话的管理接口。
//
// 语义与 `aih peer` 一致：一个会话对应一条需求，后续消息通过 messages
// 或 peer 的 agy-session 通道投递；events 用游标增量读取，不重放。
package webuiagysessionapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/agysession"
)

const (
	Path       = "/v1/management/agy-sessions"
	DetailPath = Path + "/{id}"
	MessagePath = Path + "/{id}/messages"
	EventPath   = Path + "/{id}/events"
	ClosePath   = Path + "/{id}/close"
	ResumePath  = Path + "/{id}/resume"
)

// Authorizer 与其它管理接口一致：只认 Management Key。
type Authorizer interface {
	Authorized(*http.Request) bool
}

// Dependencies 是处理器需要的运行时端口。
type Dependencies struct {
	Authorizer Authorizer
	Manager    *agysession.Manager
}

// Handler 实现 /v1/management/agy-sessions 的 REST 语义。
type Handler struct {
	authorizer Authorizer
	manager    *agysession.Manager
}

// NewHandler 构造处理器。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Manager == nil {
		return nil, errors.New("agy session handler dependencies are invalid")
	}
	return &Handler{authorizer: dependencies.Authorizer, manager: dependencies.Manager}, nil
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if !handler.authorizer.Authorized(request) {
		writeJSON(response, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
		return
	}
	suffix := strings.TrimPrefix(request.URL.Path, Path)
	suffix = strings.Trim(suffix, "/")
	switch {
	case suffix == "" && request.Method == http.MethodGet:
		handler.list(response)
	case suffix == "" && request.Method == http.MethodPost:
		handler.create(response, request)
	case request.Method == http.MethodGet && !strings.Contains(suffix, "/"):
		handler.get(response, suffix)
	case request.Method == http.MethodDelete && !strings.Contains(suffix, "/"):
		handler.close(response, suffix)
	case strings.HasSuffix(suffix, "/messages") && request.Method == http.MethodPost:
		handler.submit(response, request, strings.TrimSuffix(suffix, "/messages"))
	case strings.HasSuffix(suffix, "/events") && request.Method == http.MethodGet:
		handler.events(response, request, strings.TrimSuffix(suffix, "/events"))
	case strings.HasSuffix(suffix, "/close") && request.Method == http.MethodPost:
		handler.close(response, strings.TrimSuffix(suffix, "/close"))
	case strings.HasSuffix(suffix, "/resume") && request.Method == http.MethodPost:
		handler.resume(response, request, strings.TrimSuffix(suffix, "/resume"))
	default:
		writeJSON(response, http.StatusNotFound, map[string]any{"ok": false, "error": "route_not_found"})
	}
}

func (handler *Handler) list(response http.ResponseWriter) {
	views, err := handler.manager.List()
	if err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "sessions": views})
}

func (handler *Handler) create(response http.ResponseWriter, request *http.Request) {
	var input agysession.CreateInput
	if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_json"})
		return
	}
	view, err := handler.manager.Create(request.Context(), input)
	if err != nil {
		writeJSON(response, http.StatusUnprocessableEntity, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "session": view})
}

func (handler *Handler) get(response http.ResponseWriter, id string) {
	view, err := handler.manager.Get(id)
	if err != nil {
		writeManagerError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "session": view})
}

func (handler *Handler) close(response http.ResponseWriter, id string) {
	view, err := handler.manager.Close(id)
	if err != nil {
		writeManagerError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "session": view})
}

func (handler *Handler) resume(response http.ResponseWriter, request *http.Request, id string) {
	view, err := handler.manager.Resume(request.Context(), id)
	if err != nil {
		writeManagerError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "session": view})
}

func (handler *Handler) submit(response http.ResponseWriter, request *http.Request, id string) {
	var body struct {
		Content       string `json:"content"`
		PeerMessageID string `json:"peerMessageId"`
	}
	if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_json"})
		return
	}
	turnID, err := handler.manager.Submit(request.Context(), id, body.Content, body.PeerMessageID)
	if err != nil {
		status := http.StatusUnprocessableEntity
		if errors.Is(err, agysession.ErrNotFound) {
			status = http.StatusNotFound
		}
		if strings.Contains(err.Error(), "queue_full") {
			status = http.StatusConflict
		}
		writeJSON(response, status, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "turnId": turnID})
}

func (handler *Handler) events(response http.ResponseWriter, request *http.Request, id string) {
	after, _ := strconv.ParseInt(strings.TrimSpace(request.URL.Query().Get("after")), 10, 64)
	events, cursor, err := handler.manager.Events(id, after)
	if err != nil {
		writeManagerError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "events": events, "cursor": cursor})
}

func writeManagerError(response http.ResponseWriter, err error) {
	status := http.StatusUnprocessableEntity
	if errors.Is(err, agysession.ErrNotFound) {
		status = http.StatusNotFound
	}
	writeJSON(response, status, map[string]any{"ok": false, "error": err.Error()})
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}