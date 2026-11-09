package webuisshapi

import (
	"encoding/json"
	"net/http"
)

const (
	// WorkspaceSessionsPath 是 SSH 工作区持久终端状态的只读管理契约。
	WorkspaceSessionsPath = "/v1/management/webui/ssh-workspaces/sessions"

	remoteSessionKeyPrefix = "remote-ws:"
)

// SessionProbe 返回持久终端的探测状态（alive/missing/unavailable）。
type SessionProbe func(sessionKey string) string

// SessionsHandler 处理 SSH 工作区终端状态读取。
type SessionsHandler struct {
	authorizer Authorizer
	store      WorkspaceStore
	probe      SessionProbe
}

// NewSessionsHandler 创建默认失败关闭的 Handler。
func NewSessionsHandler(dependencies Dependencies, store WorkspaceStore, probe SessionProbe) (*SessionsHandler, error) {
	if dependencies.Authorizer == nil || store == nil {
		return nil, ErrInvalidDependencies
	}
	return &SessionsHandler{authorizer: dependencies.Authorizer, store: store, probe: probe}, nil
}

type sessionView struct {
	WorkspaceID string `json:"workspaceId"`
	SessionKey  string `json:"sessionKey"`
	Alive       bool   `json:"alive"`
}

type sessionsResponseView struct {
	OK       bool          `json:"ok"`
	Sessions []sessionView `json:"sessions"`
}

// ServeHTTP 只接受 GET。
func (handler *SessionsHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil {
		writeError(response, http.StatusServiceUnavailable, "ssh_workspace_sessions_unavailable", "SSH 工作区终端状态服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}
	raw, found, err := handler.store.ReadWorkspaces(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "ssh_workspace_sessions_read_failed", "")
		return
	}
	sessions, err := handler.sessionsFromWorkspaces(raw, found)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "ssh_workspace_sessions_invalid", "ssh_workspaces 不是合法 JSON")
		return
	}
	writeJSON(response, http.StatusOK, sessionsResponseView{OK: true, Sessions: sessions})
}

// sessionsFromWorkspaces 复刻 Node：每个工作区用 remote-ws:<id> 作为持久终端 key，
// 探到 alive 才算运行中；探测不到按 false 处理（与 Node 的默认 unavailable 同义）。
func (handler *SessionsHandler) sessionsFromWorkspaces(raw string, found bool) ([]sessionView, error) {
	result := make([]sessionView, 0)
	if !found || raw == "" {
		return result, nil
	}
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return nil, err
	}
	list, ok := decoded.([]any)
	if !ok {
		return result, nil
	}
	for _, item := range list {
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		id, _ := object["id"].(string)
		if id == "" {
			continue
		}
		sessionKey := remoteSessionKeyPrefix + id
		state := ""
		if handler.probe != nil {
			state = handler.probe(sessionKey)
		}
		result = append(result, sessionView{
			WorkspaceID: id,
			SessionKey:  sessionKey,
			Alive:       state == "alive",
		})
	}
	return result, nil
}
