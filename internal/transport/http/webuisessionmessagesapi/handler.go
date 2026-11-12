package webuisessionmessagesapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	Path         = "/v1/management/webui/sessions/{provider}/{sessionId}/messages"
	DefaultLimit = 50
	MaxPageBytes = 4 * 1024 * 1024
)

type Authorizer interface{ Authorized(*http.Request) bool }

type Dependencies struct {
	Authorizer  Authorizer
	HostHomeDir string
	AIHomeDir   string
}

type Handler struct {
	authorizer Authorizer
	hostHome   string
	chatDir    string
}

func NewHandler(deps Dependencies) (*Handler, error) {
	if deps.Authorizer == nil || strings.TrimSpace(deps.HostHomeDir) == "" {
		return nil, errors.New("会话消息接口依赖无效")
	}
	aiHome := strings.TrimSpace(deps.AIHomeDir)
	if aiHome == "" {
		aiHome = filepath.Join(deps.HostHomeDir, ".ai_home")
	}
	return &Handler{authorizer: deps.Authorizer, hostHome: deps.HostHomeDir, chatDir: filepath.Join(aiHome, "chat-sessions")}, nil
}

type response struct {
	OK       bool              `json:"ok"`
	Messages []json.RawMessage `json:"messages"`
	Start    int               `json:"start"`
	Total    int               `json:"total"`
	HasMore  bool              `json:"hasMore"`
	Cursor   any               `json:"cursor"`
}

func (handler *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if handler == nil || handler.authorizer == nil || !handler.authorizer.Authorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
		return
	}
	if r.Method != http.MethodGet {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
		return
	}
	sessionID := strings.TrimSpace(r.PathValue("sessionId"))
	if sessionID == "" || strings.ContainsAny(sessionID, "/\\") || strings.Contains(sessionID, "..") {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_session_id"})
		return
	}
	provider := strings.ToLower(strings.TrimSpace(r.PathValue("provider")))
	if provider == "claude" && strings.TrimSpace(r.URL.Query().Get("projectDirName")) != "" {
		messages, err := readClaudeMessages(handler.hostHome, r.URL.Query().Get("projectDirName"), sessionID)
		if err == nil {
			page := buildPage(messages, r.URL.Query())
			writeJSON(w, http.StatusOK, response{OK: true, Messages: page.messages, Start: page.start, Total: page.total, HasMore: page.start > 0, Cursor: nil})
			return
		}
	}
	raw, err := os.ReadFile(filepath.Join(handler.chatDir, sessionID+".json"))
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "chat_session_not_found"})
		return
	}
	var session struct {
		Messages []json.RawMessage `json:"messages"`
	}
	if err := json.Unmarshal(raw, &session); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": "chat_session_invalid"})
		return
	}
	page := buildPage(session.Messages, r.URL.Query())
	writeJSON(w, http.StatusOK, response{OK: true, Messages: page.messages, Start: page.start, Total: page.total, HasMore: page.start > 0, Cursor: nil})
}

type pageResult struct {
	messages     []json.RawMessage
	start, total int
}

func buildPage(messages []json.RawMessage, query interface{ Get(string) string }) pageResult {
	total := len(messages)
	limit := DefaultLimit
	if n, err := strconv.Atoi(query.Get("limit")); err == nil && n > 0 {
		limit = n
		if limit > DefaultLimit {
			limit = DefaultLimit
		}
	}
	end := total
	if raw := query.Get("before"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil {
			if n < 0 {
				n = 0
			}
			if n > total {
				n = total
			}
			end = n
		}
	}
	start := end
	bytes := 2
	for start > 0 && end-start < limit {
		size := len(messages[start-1])
		sep := 0
		if start < end {
			sep = 1
		}
		if start < end && bytes+sep+size > MaxPageBytes {
			break
		}
		start--
		bytes += sep + size
	}
	return pageResult{messages: messages[start:end], start: start, total: total}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
