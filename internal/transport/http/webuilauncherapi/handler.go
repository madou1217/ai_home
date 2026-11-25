// Package webuilauncherapi exposes the AIH Launch management HTTP API under /v1/management/launcher.
//
//	GET  /v1/management/launcher/apps?q=&refresh=1&limit=
//	POST /v1/management/launcher/open
//	POST /v1/management/launcher/show
//	GET  /v1/management/launcher/status
package webuilauncherapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/application/launcher"
)

const (
	// Path is the management route prefix for AIH Launch (§5).
	Path = "/v1/management/launcher"

	defaultMaxRequestBytes = 64 * 1024
)

// Authorizer validates management-key requests.
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Handler serves AIH Launch management HTTP requests.
type Handler struct {
	Authorizer    Authorizer
	Service       *launcher.Service
	Show          func(context.Context) error
	DesktopStatus func(context.Context) any
	MaxBody       int64
}

// NewHandler constructs a launcher management API handler.
func NewHandler(authorizer Authorizer, service *launcher.Service) (*Handler, error) {
	if authorizer == nil || service == nil {
		return nil, errors.New("launcher_handler_dependencies_invalid")
	}
	return &Handler{
		Authorizer: authorizer,
		Service:    service,
		MaxBody:    defaultMaxRequestBytes,
	}, nil
}

// ServeHTTP dispatches launcher routes under Path.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h == nil || h.Service == nil {
		writeError(w, http.StatusServiceUnavailable, "launcher_unavailable", "启动器服务未就绪")
		return
	}
	if h.Authorizer == nil || !h.Authorizer.Authorized(r) {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeError(w, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	rawPath := strings.TrimSpace(r.URL.Path)
	if !strings.HasPrefix(rawPath, Path) {
		writeError(w, http.StatusNotFound, "not_found", "没有这个启动器路由")
		return
	}
	rest := strings.Trim(strings.TrimPrefix(rawPath, Path), "/")
	switch rest {
	case "apps":
		h.handleApps(w, r)
	case "open":
		h.handleOpen(w, r)
	case "show":
		h.handleShow(w, r)
	case "status":
		h.handleStatus(w, r)
	default:
		writeError(w, http.StatusNotFound, "not_found", "没有这个启动器路由")
	}
}

func (h *Handler) handleApps(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
		return
	}
	q := r.URL.Query()
	opts := launcher.ListOptions{
		Query: q.Get("q"),
	}
	if rawRefresh := strings.TrimSpace(q.Get("refresh")); rawRefresh != "" {
		switch strings.ToLower(rawRefresh) {
		case "1", "true":
			opts.Refresh = true
		case "0", "false":
			opts.Refresh = false
		default:
			writeError(w, http.StatusBadRequest, "invalid_refresh", "refresh 参数无效")
			return
		}
	}
	if rawLimit := strings.TrimSpace(q.Get("limit")); rawLimit != "" {
		parsed, err := strconv.Atoi(rawLimit)
		if err != nil || parsed <= 0 {
			writeError(w, http.StatusBadRequest, "invalid_limit", "limit 必须是正整数")
			return
		}
		opts.Limit = parsed
	}

	result, err := h.Service.List(r.Context(), opts)
	if err != nil {
		h.writeDomainError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (h *Handler) handleOpen(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := h.decodeJSON(w, r, &body); err != nil {
		h.writeDecodeError(w, err)
		return
	}
	if strings.TrimSpace(body.ID) == "" {
		writeError(w, http.StatusBadRequest, "launcher_invalid_input", "缺少应用 ID")
		return
	}
	if _, err := h.Service.Open(r.Context(), body.ID); err != nil {
		h.writeDomainError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) handleShow(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
		return
	}
	if h.Show == nil {
		writeError(w, http.StatusNotImplemented, "launcher_unsupported", "当前环境没有可用的桌面启动器面板")
		return
	}
	if err := h.Show(r.Context()); err != nil {
		h.writeDomainError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *Handler) handleStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的请求方法")
		return
	}
	status := h.Service.Status(r.Context())
	if h.DesktopStatus != nil {
		if desktop := h.DesktopStatus(r.Context()); desktop != nil {
			writeJSON(w, http.StatusOK, struct {
				launcher.Status
				Desktop any `json:"desktop,omitempty"`
			}{
				Status:  status,
				Desktop: desktop,
			})
			return
		}
	}
	writeJSON(w, http.StatusOK, status)
}

func (h *Handler) decodeJSON(w http.ResponseWriter, r *http.Request, dst any) error {
	maxBody := h.MaxBody
	if maxBody <= 0 {
		maxBody = defaultMaxRequestBytes
	}
	limited := http.MaxBytesReader(w, r.Body, maxBody)
	decoder := json.NewDecoder(limited)
	if err := decoder.Decode(dst); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("trailing_json_data")
	}
	return nil
}

func (h *Handler) writeDecodeError(w http.ResponseWriter, err error) {
	var maxBytesErr *http.MaxBytesError
	if errors.As(err, &maxBytesErr) {
		writeError(w, http.StatusRequestEntityTooLarge, "request_too_large", "请求体超过大小限制")
		return
	}
	writeError(w, http.StatusBadRequest, "invalid_json", "请求 JSON 格式无效")
}

func (h *Handler) writeDomainError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, launcher.ErrNotFound):
		writeError(w, http.StatusNotFound, "launcher_app_not_found", "未找到指定应用")
	case errors.Is(err, launcher.ErrInvalidInput):
		writeError(w, http.StatusBadRequest, "launcher_invalid_input", err.Error())
	case errors.Is(err, launcher.ErrUnsupported):
		writeError(w, http.StatusNotImplemented, "launcher_unsupported", "当前平台不支持应用启动器")
	case errors.Is(err, launcher.ErrUnavailable):
		writeError(w, http.StatusServiceUnavailable, "launcher_unavailable", "启动器服务未就绪")
	default:
		writeError(w, http.StatusInternalServerError, "launcher_error", err.Error())
	}
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, code string, message string) {
	writeJSON(w, status, map[string]string{
		"error":   code,
		"message": message,
	})
}
