package webuisessionmessagesapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/sessionscan/sessionread"
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
	aiHome     string
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
	return &Handler{
		authorizer: deps.Authorizer,
		hostHome:   deps.HostHomeDir,
		aiHome:     aiHome,
		chatDir:    filepath.Join(aiHome, "chat-sessions"),
	}, nil
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
	provider := sessionread.NormalizeProvider(r.PathValue("provider"))
	if !sessionread.IsKnownProvider(provider) {
		writeJSON(w, http.StatusNotImplemented, map[string]any{"ok": false, "error": "unsupported_provider"})
		return
	}

	query := r.URL.Query()
	projectDirName := strings.TrimSpace(query.Get("projectDirName"))
	accountRef := strings.TrimSpace(query.Get("accountRef"))
	if err := sessionread.ValidateSessionRef(provider, sessionID, projectDirName); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_session_ref"})
		return
	}

	opts := sessionread.Options{
		HostHomeDir: handler.hostHome,
		AIHomeDir:   handler.aiHome,
		AccountRef:  accountRef,
	}

	// 优先检查 WebUI 自建 chat-sessions；provider == "chat" 时缺失直接 404。
	raw, chatErr := os.ReadFile(filepath.Join(handler.chatDir, sessionID+".json"))
	if chatErr == nil {
		var session struct {
			Messages []json.RawMessage `json:"messages"`
		}
		if err := json.Unmarshal(raw, &session); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": "chat_session_invalid"})
			return
		}
		decorated := sessionread.ApplyCanonicalAgyTurnModels(
			r.Context(),
			opts,
			provider,
			sessionID,
			sessionread.DecorateMessagesWithTurnModels(session.Messages),
		)
		canonical := sessionread.CanonicalizeMessages(decorated, provider, handler.aiHome, handler.hostHome)
		page := buildPage(canonical, query)
		writeJSON(w, http.StatusOK, response{
			OK:       true,
			Messages: nonNilMessages(page.messages),
			Start:    page.start,
			Total:    page.total,
			HasMore:  page.start > 0,
			Cursor:   nil,
		})
		return
	}
	if !errors.Is(chatErr, os.ErrNotExist) {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": "chat_session_invalid"})
		return
	}
	if provider == "chat" {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "chat_session_not_found"})
		return
	}

	// Claude 显式带 projectDirName 时走原有快速路径（保持逐字节兼容）。
	if provider == "claude" && projectDirName != "" {
		messages, err := readClaudeMessages(handler.hostHome, projectDirName, sessionID)
		if err == nil {
			canonical := sessionread.CanonicalizeMessages(messages, provider, handler.aiHome, handler.hostHome)
			page := buildPage(canonical, query)
			writeJSON(w, http.StatusOK, response{
				OK:       true,
				Messages: nonNilMessages(page.messages),
				Start:    page.start,
				Total:    page.total,
				HasMore:  page.start > 0,
				Cursor:   claudeSessionCursor(handler.hostHome, projectDirName, sessionID),
			})
			return
		}
	}

	snapshot, err := sessionread.ReadMessagesSnapshot(r.Context(), opts, provider, sessionID, projectDirName)
	if err != nil {
		switch {
		case errors.Is(err, sessionread.ErrUnsupportedProvider):
			writeJSON(w, http.StatusNotImplemented, map[string]any{"ok": false, "error": "unsupported_provider"})
		case errors.Is(err, sessionread.ErrInvalidSessionRef):
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_session_ref"})
		case errors.Is(err, sessionread.ErrSessionNotFound):
			writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "session_not_found"})
		default:
			writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "error": "get_messages_failed"})
		}
		return
	}

	page := buildPage(snapshot.Messages, query)
	writeJSON(w, http.StatusOK, response{
		OK:       true,
		Messages: nonNilMessages(page.messages),
		Start:    page.start,
		Total:    page.total,
		HasMore:  page.start > 0,
		Cursor:   snapshot.Cursor,
	})
}

func nonNilMessages(items []json.RawMessage) []json.RawMessage {
	if items == nil {
		return []json.RawMessage{}
	}
	return items
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
