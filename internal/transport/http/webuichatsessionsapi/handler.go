// Package webuichatsessionsapi 提供 WebUI 聊天会话列表、创建、单条读取与删除接口。
//
// 契约边界（对齐 Node /v0/webui/chat-sessions*）：
//   - GET /v1/management/webui/chat-sessions：合并 app-state.db 中非项目、未归档且有实质内容的
//     canonical 会话与 ~/.ai_home/chat-sessions/*.json legacy 会话（已迁移的 legacySessionId 去重），
//     按 updatedAt 降序输出。
//   - POST /v1/management/webui/chat-sessions：原子创建 legacy JSON 会话并返回 201。
//   - GET /v1/management/webui/chat-sessions/{sessionId}：读取单条 legacy JSON，缺失返回 404 chat_session_not_found。
//   - DELETE /v1/management/webui/chat-sessions/{sessionId}：对非项目 canonical 会话检查静止状态
//     (idle/closed，否则 409 chat_session_busy) 后开启外键级联物理删除，并 Best-effort 清理附件与
//     legacy 来源文件；若不在 canonical 库中则删除 legacy JSON。
package webuichatsessionsapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

const (
	// CollectionPath 是聊天会话集合路由（GET 列表 / POST 创建）。
	CollectionPath = "/v1/management/webui/chat-sessions"
	// ItemPath 是单条聊天会话路由（GET 读取 / DELETE 删除）。
	ItemPath = "/v1/management/webui/chat-sessions/{sessionId}"

	maxCreateBodyBytes = 1024 * 1024
)

// ErrInvalidDependencies 表示 Handler 缺少必要的鉴权器或 HOME 路径。
var ErrInvalidDependencies = errors.New("WebUI 聊天会话接口依赖无效")

// Authorizer 校验管理面请求鉴权。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总聊天会话接口依赖。
type Dependencies struct {
	Authorizer  Authorizer
	AIHomeDir   string
	HostHomeDir string
	Now         func() time.Time
}

// Handler 处理 /v1/management/webui/chat-sessions* 路由。
type Handler struct {
	authorizer  Authorizer
	aiHomeDir   string
	hostHomeDir string
	now         func() time.Time
}

type createSessionRequest struct {
	ID         string            `json:"id"`
	Title      string            `json:"title"`
	Provider   string            `json:"provider"`
	Model      string            `json:"model"`
	AccountRef string            `json:"accountRef"`
	CreatedAt  int64             `json:"createdAt"`
	Messages   []json.RawMessage `json:"messages"`
}

// NewHandler 校验依赖并构造 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	aiHome := strings.TrimSpace(dependencies.AIHomeDir)
	hostHome := strings.TrimSpace(dependencies.HostHomeDir)
	if hostHome == "" && aiHome != "" {
		hostHome = filepath.Dir(filepath.Clean(aiHome))
	}
	if aiHome == "" && hostHome != "" {
		aiHome = filepath.Join(hostHome, ".ai_home")
	}
	if dependencies.Authorizer == nil || (aiHome == "" && hostHome == "") {
		return nil, ErrInvalidDependencies
	}
	nowFn := dependencies.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		aiHomeDir:   aiHome,
		hostHomeDir: hostHome,
		now:         nowFn,
	}, nil
}

func (handler *Handler) nowMillis() int64 {
	return handler.now().UnixMilli()
}

// ServeHTTP 分发集合或单条聊天会话请求。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{
			"ok":    false,
			"error": "webui_chat_sessions_unavailable",
		})
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(response, http.StatusUnauthorized, map[string]any{
			"ok":    false,
			"error": "unauthorized",
		})
		return
	}

	sessionID := strings.TrimSpace(request.PathValue("sessionId"))
	if sessionID == "" {
		trimmed := strings.TrimSuffix(request.URL.Path, "/")
		if strings.HasPrefix(trimmed, CollectionPath+"/") {
			sessionID = strings.TrimPrefix(trimmed, CollectionPath+"/")
		}
	}

	if sessionID == "" && (request.URL.Path == CollectionPath || request.URL.Path == CollectionPath+"/") {
		switch request.Method {
		case http.MethodGet:
			handler.handleList(response, request)
		case http.MethodPost:
			handler.handleCreate(response, request)
		default:
			response.Header().Set("Allow", "GET, POST")
			writeJSON(response, http.StatusMethodNotAllowed, map[string]any{
				"ok":    false,
				"error": "method_not_allowed",
			})
		}
		return
	}

	if !isSafeSessionID(sessionID) {
		writeJSON(response, http.StatusBadRequest, map[string]any{
			"ok":    false,
			"error": "invalid_session_id",
		})
		return
	}

	switch request.Method {
	case http.MethodGet:
		handler.handleGetSingle(response, sessionID)
	case http.MethodDelete:
		handler.handleDelete(response, request, sessionID)
	default:
		response.Header().Set("Allow", "GET, DELETE")
		writeJSON(response, http.StatusMethodNotAllowed, map[string]any{
			"ok":    false,
			"error": "method_not_allowed",
		})
	}
}

func (handler *Handler) handleList(response http.ResponseWriter, request *http.Request) {
	sessions, err := handler.listMergedSessions(request.Context())
	if err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]any{
			"ok":    false,
			"error": "chat_sessions_list_failed",
		})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":       true,
		"sessions": sessions,
	})
}

func (handler *Handler) handleCreate(response http.ResponseWriter, request *http.Request) {
	var body createSessionRequest
	if request.Body != nil {
		raw, err := io.ReadAll(io.LimitReader(request.Body, maxCreateBodyBytes+1))
		if err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]any{
				"ok":    false,
				"error": "invalid_request_body",
			})
			return
		}
		if len(raw) > maxCreateBodyBytes {
			writeJSON(response, http.StatusRequestEntityTooLarge, map[string]any{
				"ok":    false,
				"error": "payload_too_large",
			})
			return
		}
		if len(bytes.TrimSpace(raw)) > 0 {
			if err := json.Unmarshal(raw, &body); err != nil {
				writeJSON(response, http.StatusBadRequest, map[string]any{
					"ok":    false,
					"error": "invalid_json",
				})
				return
			}
		}
	}

	if strings.TrimSpace(body.ID) != "" && !isSafeSessionID(body.ID) {
		writeJSON(response, http.StatusBadRequest, map[string]any{
			"ok":    false,
			"error": "invalid_session_id",
		})
		return
	}

	session, err := handler.createLegacySession(body)
	if err != nil {
		writeJSON(response, http.StatusInternalServerError, map[string]any{
			"ok":    false,
			"error": "chat_session_create_failed",
		})
		return
	}
	writeJSON(response, http.StatusCreated, map[string]any{
		"ok":      true,
		"session": session,
	})
}

func (handler *Handler) handleGetSingle(response http.ResponseWriter, sessionID string) {
	session, ok := handler.readSingleLegacySession(sessionID)
	if !ok {
		writeJSON(response, http.StatusNotFound, map[string]any{
			"ok":    false,
			"error": "chat_session_not_found",
		})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":      true,
		"session": session,
	})
}

func (handler *Handler) handleDelete(response http.ResponseWriter, request *http.Request, sessionID string) {
	deleted, err := handler.deleteSession(request.Context(), sessionID)
	if err != nil {
		if errors.Is(err, errChatSessionBusy) {
			writeJSON(response, http.StatusConflict, map[string]any{
				"ok":    false,
				"error": "chat_session_busy",
			})
			return
		}
		writeJSON(response, http.StatusInternalServerError, map[string]any{
			"ok":    false,
			"error": "chat_session_delete_failed",
		})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":      true,
		"deleted": deleted,
	})
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}
