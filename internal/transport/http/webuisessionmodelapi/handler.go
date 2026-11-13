// Package webuisessionmodelapi 提供「查询会话最近一次实际使用模型」的只读管理接口。
//
//	GET /v1/management/webui/sessions/{provider}/{sessionId}/model
//
// 契约来源：Node lib/server/web-ui-router.js 的
// GET /v0/webui/sessions/:provider/:sessionId/model 分支：
//   - opencode 优先读取 opencode.db 的 session.model 列；
//   - 其余情况读取 app-state.db model_usage_records 最近记录；
//   - 无记录时仍返回 200 { ok: true, provider, sessionId, model: "" }。
package webuisessionmodelapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/internal/sessionscan/sessionread"
)

// Path 是会话最近使用模型的管理契约路径。
const Path = "/v1/management/webui/sessions/{provider}/{sessionId}/model"

const prefixPath = "/v1/management/webui/sessions/"

// ErrInvalidDependencies 表示 Handler 缺少鉴权或目录上下文。
var ErrInvalidDependencies = errors.New("会话模型查询接口依赖无效")

// Authorizer 是管理面请求的鉴权策略。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总会话模型查询接口的依赖。
type Dependencies struct {
	Authorizer     Authorizer
	HostHomeDir    string
	AIHomeDir      string
	AppStateDBPath string
}

// Handler 是会话模型查询接口的 HTTP 入站适配器。
type Handler struct {
	authorizer     Authorizer
	hostHomeDir    string
	aiHomeDir      string
	appStateDBPath string
}

type responseView struct {
	OK        bool   `json:"ok"`
	Provider  string `json:"provider"`
	SessionID string `json:"sessionId"`
	Model     string `json:"model"`
}

// NewHandler 校验依赖并构造 Handler。
func NewHandler(dependencies Dependencies) (http.Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	hostHome := strings.TrimSpace(dependencies.HostHomeDir)
	aiHome := strings.TrimSpace(dependencies.AIHomeDir)
	dbPath := strings.TrimSpace(dependencies.AppStateDBPath)
	if hostHome == "" && aiHome == "" && dbPath == "" {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer:     dependencies.Authorizer,
		hostHomeDir:    hostHome,
		aiHomeDir:      aiHome,
		appStateDBPath: dbPath,
	}, nil
}

// ServeHTTP 只接受带管理密钥的 GET 请求。
func (handler *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if handler == nil || handler.authorizer == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "session_model_unavailable"})
		return
	}
	if !handler.authorizer.Authorized(r) {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
		return
	}

	provider, sessionID, ok := parseRouteParams(r)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "not_found"})
		return
	}
	if !sessionread.IsSafePathSegment(provider) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_provider"})
		return
	}
	if !sessionread.IsSafePathSegment(sessionID) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_session_id"})
		return
	}

	model := sessionread.ReadSessionModel(r.Context(), sessionread.Options{
		HostHomeDir:    handler.hostHomeDir,
		AIHomeDir:      handler.aiHomeDir,
		AppStateDBPath: handler.appStateDBPath,
	}, provider, sessionID)

	writeJSON(w, http.StatusOK, responseView{
		OK:        true,
		Provider:  provider,
		SessionID: sessionID,
		Model:     model,
	})
}

func parseRouteParams(r *http.Request) (string, string, bool) {
	provider := strings.TrimSpace(r.PathValue("provider"))
	sessionID := strings.TrimSpace(r.PathValue("sessionId"))
	if provider != "" && sessionID != "" {
		return provider, sessionID, true
	}
	trimmed := strings.TrimPrefix(r.URL.Path, prefixPath)
	if trimmed == r.URL.Path {
		return "", "", false
	}
	parts := strings.Split(strings.Trim(trimmed, "/"), "/")
	if len(parts) != 3 || parts[2] != "model" {
		return "", "", false
	}
	p := strings.TrimSpace(parts[0])
	s := strings.TrimSpace(parts[1])
	if p == "" || s == "" {
		return "", "", false
	}
	return p, s, true
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
