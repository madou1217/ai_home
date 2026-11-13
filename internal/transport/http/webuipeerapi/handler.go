// Package webuipeerapi 提供 WebUI peer 只读收件箱与变更 SSE 流接口。
package webuipeerapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/peer"
)

const (
	// MessagesPath 是 peer 消息只读列表契约路径。
	MessagesPath = "/v1/management/webui/peer/messages"
	// WatchPath 是 peer 目录变更 SSE 契约路径。
	WatchPath = "/v1/management/webui/peer/messages/watch"

	defaultHeartbeat = 30 * time.Second
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("peer WebUI 接口依赖无效")

// Authorizer 校验 WebUI 管理请求的访问权限。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总 peer 只读接口所需的端口。
type Dependencies struct {
	Authorizer        Authorizer
	AIHomeDir         string
	HeartbeatInterval time.Duration
	WatchDebounce     time.Duration
	Now               func() time.Time
	NewWatcher        func() (peer.DirectoryWatcher, error)
}

// Handler 处理 /v1/management/webui/peer/messages* 请求。
type Handler struct {
	authorizer        Authorizer
	aiHomeDir         string
	heartbeatInterval time.Duration
	watchDebounce     time.Duration
	now               func() time.Time
	newWatcher        func() (peer.DirectoryWatcher, error)
}

// NewHandler 创建失败关闭的 peer 只读接口处理器。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	heartbeat := dependencies.HeartbeatInterval
	if heartbeat <= 0 {
		heartbeat = defaultHeartbeat
	}
	return &Handler{
		authorizer:        dependencies.Authorizer,
		aiHomeDir:         strings.TrimSpace(dependencies.AIHomeDir),
		heartbeatInterval: heartbeat,
		watchDebounce:     dependencies.WatchDebounce,
		now:               dependencies.Now,
		newWatcher:        dependencies.NewWatcher,
	}, nil
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "peer_store_unavailable"})
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(response, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized", "message": "需要管理密钥"})
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
		return
	}
	if handler.aiHomeDir == "" {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "peer_store_unavailable"})
		return
	}

	if request.URL != nil && request.URL.Path == WatchPath {
		handler.handleWatch(response, request)
		return
	}
	handler.handleMessages(response, request)
}

func (handler *Handler) handleMessages(response http.ResponseWriter, request *http.Request) {
	query := request.URL.Query()
	state := peer.NormalizeState(query.Get("state"))
	limit := 0
	if rawLimit := strings.TrimSpace(query.Get("limit")); rawLimit != "" {
		if parsed, err := strconv.Atoi(rawLimit); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	result, err := peer.ListMessages(handler.aiHomeDir, state, limit)
	if err != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "peer_store_unavailable"})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":       true,
		"messages": result.Messages,
		"counts":   result.Counts,
		"store":    result.Store,
	})
}

func (handler *Handler) handleWatch(response http.ResponseWriter, request *http.Request) {
	events, err := peer.Watch(request.Context(), handler.aiHomeDir, peer.WatchOptions{
		Debounce:   handler.watchDebounce,
		Now:        handler.now,
		NewWatcher: handler.newWatcher,
	})
	if err != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "peer_store_unavailable"})
		return
	}

	header := response.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-cache")
	header.Set("Connection", "keep-alive")
	header.Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)

	flusher, _ := response.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}

	heartbeat := time.NewTicker(handler.heartbeatInterval)
	defer heartbeat.Stop()

	for {
		select {
		case <-request.Context().Done():
			return
		case ev, ok := <-events:
			if !ok {
				return
			}
			encoded, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			if _, err := response.Write([]byte("data: " + string(encoded) + "\n\n")); err != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		case <-heartbeat.C:
			if _, err := response.Write([]byte(": heartbeat\n\n")); err != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		http.Error(response, "json_encode_failed", http.StatusInternalServerError)
		return
	}
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_, _ = response.Write(body)
}
