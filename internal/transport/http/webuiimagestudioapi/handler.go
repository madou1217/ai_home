// Package webuiimagestudioapi 承接 Image Studio 工作台的全部管理端 HTTP 路由：
//
//	GET    /v1/management/webui/studio/image/models
//	GET    /v1/management/webui/studio/image/sessions
//	POST   /v1/management/webui/studio/image/sessions
//	GET    /v1/management/webui/studio/image/sessions/{sessionId}
//	PATCH  /v1/management/webui/studio/image/sessions/{sessionId}
//	DELETE /v1/management/webui/studio/image/sessions/{sessionId}
//	POST   /v1/management/webui/studio/image/sessions/{sessionId}/runs
//	GET    /v1/management/webui/studio/image/sessions/{sessionId}/assets/{assetId}
//
// 会话持久化、模型目录、参数校验、运行编排与二进制资产读写全部位于 internal/runtime/imagestudio。
package webuiimagestudioapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/imagestudio"
)

const (
	// Path 是 Go 管理端 Image Studio 接口前缀。
	Path = "/v1/management/webui/studio/image"

	defaultJSONBodyLimitBytes int64 = 1024 * 1024
	runJSONBodyLimitBytes     int64 = 16 * 1024 * 1024
)

// ErrInvalidDependencies 表示 Handler 缺少核心依赖。
var ErrInvalidDependencies = errors.New("image Studio HTTP 接口依赖无效")

// Authorizer 校验 Management Key 授权状态。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总 Image Studio HTTP Handler 所需依赖。
type Dependencies struct {
	Authorizer Authorizer
	Service    *imagestudio.Service
}

// Handler 处理 /v1/management/webui/studio/image* 请求。
type Handler struct {
	authorizer Authorizer
	service    *imagestudio.Service
}

// NewHandler 创建并校验 Image Studio HTTP 处理器。
func NewHandler(deps Dependencies) (*Handler, error) {
	if deps.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: deps.Authorizer,
		service:    deps.Service,
	}, nil
}

// ServeHTTP 鉴权后按路径与 HTTP 方法分发到对应操作。
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.authorizer == nil {
		writeStudioError(w, http.StatusServiceUnavailable, "image_studio_unavailable", "image Studio service is unavailable")
		return
	}
	if !h.authorizer.Authorized(r) {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeStudioError(w, http.StatusUnauthorized, "unauthorized", "management key is required")
		return
	}
	if h.service == nil || h.service.Store() == nil {
		writeStudioError(w, http.StatusServiceUnavailable, "image_studio_store_unavailable", "image Studio store is not configured")
		return
	}

	subPath := strings.TrimPrefix(r.URL.Path, Path)
	switch {
	case subPath == "/models" && r.Method == http.MethodGet:
		h.handleListModels(w, r)
	case subPath == "/sessions" && r.Method == http.MethodGet:
		h.handleListSessions(w, r)
	case subPath == "/sessions" && r.Method == http.MethodPost:
		h.handleCreateSession(w, r)
	case strings.HasPrefix(subPath, "/sessions/"):
		h.serveSessionSubroute(w, r, strings.TrimPrefix(subPath, "/sessions/"))
	default:
		writeStudioError(w, http.StatusNotFound, "image_studio_route_not_found", "image Studio route was not found")
	}
}

func (h *Handler) serveSessionSubroute(w http.ResponseWriter, r *http.Request, rest string) {
	parts := strings.Split(rest, "/")
	sessionID := parts[0]
	if sessionID == "" {
		writeStudioError(w, http.StatusNotFound, "image_studio_route_not_found", "image Studio route was not found")
		return
	}

	switch {
	case len(parts) == 1 && r.Method == http.MethodGet:
		h.handleGetSession(w, r, sessionID)
	case len(parts) == 1 && r.Method == http.MethodPatch:
		h.handleRenameSession(w, r, sessionID)
	case len(parts) == 1 && r.Method == http.MethodDelete:
		h.handleDeleteSession(w, r, sessionID)
	case len(parts) == 2 && parts[1] == "runs" && r.Method == http.MethodPost:
		h.handleExecuteRun(w, r, sessionID)
	case len(parts) == 3 && parts[1] == "assets" && parts[2] != "" && r.Method == http.MethodGet:
		h.handleReadAsset(w, r, sessionID, parts[2])
	default:
		writeStudioError(w, http.StatusNotFound, "image_studio_route_not_found", "image Studio route was not found")
	}
}

func (h *Handler) handleListModels(w http.ResponseWriter, r *http.Request) {
	models, defKey, err := h.service.ListModels(r.Context(), r.URL.Query().Get("provider"))
	if err != nil {
		writeFromStudioErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":              true,
		"models":          models,
		"defaultModelKey": defKey,
	})
}

func (h *Handler) handleListSessions(w http.ResponseWriter, r *http.Request) {
	sessions, err := h.service.Store().ListSessions(r.Context())
	if err != nil {
		writeFromStudioErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"sessions": sessions,
	})
}

func (h *Handler) handleCreateSession(w http.ResponseWriter, r *http.Request) {
	raw, ok := readBodyBytes(w, r, defaultJSONBodyLimitBytes)
	if !ok {
		return
	}
	var payload struct {
		Title string `json:"title"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &payload); err != nil {
			writeStudioError(w, http.StatusBadRequest, "invalid_json", "request body must be valid JSON")
			return
		}
	}
	session, err := h.service.Store().CreateSession(r.Context(), payload.Title)
	if err != nil {
		writeFromStudioErr(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"ok":      true,
		"session": session,
	})
}

func (h *Handler) handleGetSession(w http.ResponseWriter, r *http.Request, sessionID string) {
	session, err := h.service.Store().GetSession(r.Context(), sessionID)
	if err != nil {
		writeFromStudioErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"session": session,
	})
}

func (h *Handler) handleRenameSession(w http.ResponseWriter, r *http.Request, sessionID string) {
	raw, ok := readBodyBytes(w, r, defaultJSONBodyLimitBytes)
	if !ok {
		return
	}
	var payload struct {
		Title string `json:"title"`
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &payload); err != nil {
			writeStudioError(w, http.StatusBadRequest, "invalid_json", "request body must be valid JSON")
			return
		}
	}
	session, err := h.service.Store().RenameSession(r.Context(), sessionID, payload.Title)
	if err != nil {
		writeFromStudioErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"session": session,
	})
}

func (h *Handler) handleDeleteSession(w http.ResponseWriter, r *http.Request, sessionID string) {
	deleted, err := h.service.Store().DeleteSession(r.Context(), sessionID)
	if err != nil {
		writeFromStudioErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":               true,
		"deletedSessionId": deleted.ID,
	})
}

func (h *Handler) handleExecuteRun(w http.ResponseWriter, r *http.Request, sessionID string) {
	raw, ok := readBodyBytes(w, r, runJSONBodyLimitBytes)
	if !ok {
		return
	}
	var runReq imagestudio.RunRequest
	if len(raw) > 0 {
		var presence map[string]json.RawMessage
		if err := json.Unmarshal(raw, &presence); err != nil || presence == nil {
			writeStudioError(w, http.StatusBadRequest, "invalid_json", "request body must be valid JSON")
			return
		}
		if err := json.Unmarshal(raw, &runReq); err != nil {
			writeStudioError(w, http.StatusBadRequest, "invalid_json", "request body must be valid JSON")
			return
		}
		if rawSources, exists := presence["sources"]; exists && string(bytes.TrimSpace(rawSources)) != "null" {
			runReq.HasSources = true
		}
	}
	res, err := h.service.ExecuteRun(r.Context(), sessionID, runReq)
	if err != nil {
		writeFromStudioErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":         true,
		"session":    res.Session,
		"revisionId": res.RevisionID,
	})
}

func (h *Handler) handleReadAsset(w http.ResponseWriter, r *http.Request, sessionID string, assetID string) {
	asset, data, err := h.service.Store().ReadAsset(r.Context(), sessionID, assetID)
	if err != nil {
		writeFromStudioErr(w, err)
		return
	}
	headers := w.Header()
	headers.Set("Content-Type", asset.MIME)
	headers.Set("Content-Length", strconv.Itoa(len(data)))
	headers.Set("Cache-Control", "private, max-age=31536000, immutable")
	headers.Set("Content-Disposition", `inline; filename="`+asset.ID+`"`)
	headers.Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func readBodyBytes(w http.ResponseWriter, r *http.Request, maxBytes int64) ([]byte, bool) {
	if r.Body == nil {
		return nil, true
	}
	limited := http.MaxBytesReader(w, r.Body, maxBytes)
	raw, err := io.ReadAll(limited)
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			writeStudioError(w, http.StatusRequestEntityTooLarge, "request_body_too_large", "request body is too large")
			return nil, false
		}
		writeStudioError(w, http.StatusBadRequest, "invalid_request_body", "request body could not be read")
		return nil, false
	}
	return bytes.TrimSpace(raw), true
}

func writeJSON(w http.ResponseWriter, status int, payload map[string]any) {
	headers := w.Header()
	headers.Set("Content-Type", "application/json; charset=utf-8")
	headers.Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeStudioError(w http.ResponseWriter, status int, code string, detail string) {
	if status <= 0 {
		status = http.StatusInternalServerError
	}
	if code == "" {
		code = "image_studio_error"
	}
	if detail == "" {
		detail = "image Studio request failed"
	}
	writeJSON(w, status, map[string]any{
		"ok":     false,
		"error":  code,
		"detail": detail,
	})
}

func writeFromStudioErr(w http.ResponseWriter, err error) {
	var studioErr *imagestudio.Error
	if errors.As(err, &studioErr) {
		writeStudioError(w, studioErr.StatusCode, studioErr.Code, studioErr.Detail)
		return
	}
	writeStudioError(w, http.StatusInternalServerError, "image_studio_error", err.Error())
}
