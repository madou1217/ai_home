// Package webuitasksapi 提供 WebUI 全局活跃任务队列的列表与 SSE 监听接口。
package webuitasksapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/taskhub"
)

const (
	// Path 是全局任务列表契约路径。
	Path = "/v1/management/webui/tasks"
	// WatchPath 是全局任务 SSE 监听契约路径。
	WatchPath = Path + "/watch"

	defaultHeartbeat = 30 * time.Second
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("任务队列 WebUI 接口依赖无效")

// Authorizer 校验 WebUI 管理请求的访问权限。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总任务队列接口依赖。
type Dependencies struct {
	Authorizer        Authorizer
	Hub               *taskhub.Hub
	HeartbeatInterval time.Duration
}

// Handler 处理 /v1/management/webui/tasks* 请求。
type Handler struct {
	authorizer        Authorizer
	hub               *taskhub.Hub
	heartbeatInterval time.Duration
}

// NewHandler 创建失败关闭的任务队列处理器。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Hub == nil {
		return nil, ErrInvalidDependencies
	}
	heartbeat := dependencies.HeartbeatInterval
	if heartbeat <= 0 {
		heartbeat = defaultHeartbeat
	}
	return &Handler{
		authorizer:        dependencies.Authorizer,
		hub:               dependencies.Hub,
		heartbeatInterval: heartbeat,
	}, nil
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.hub == nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false, "error": "task_hub_unavailable"})
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
	if request.URL != nil && request.URL.Path == WatchPath {
		handler.handleWatch(response, request)
		return
	}
	tasks := handler.hub.ListActive()
	if tasks == nil {
		tasks = []taskhub.Task{}
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok":    true,
		"tasks": tasks,
	})
}

func (handler *Handler) handleWatch(response http.ResponseWriter, request *http.Request) {
	events, cancel := handler.hub.Subscribe()
	defer cancel()

	header := response.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-cache")
	header.Set("Connection", "keep-alive")
	header.Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)

	flusher, _ := response.(http.Flusher)

	if !writeSSEJSON(response, flusher, taskhub.Event{Type: "connected"}) {
		return
	}
	snapshot := handler.hub.ListActive()
	if snapshot == nil {
		snapshot = []taskhub.Task{}
	}
	if !writeSSEJSON(response, flusher, taskhub.Event{Type: "snapshot", Tasks: snapshot}) {
		return
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
			if !writeSSEJSON(response, flusher, ev) {
				return
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

func writeSSEJSON(response http.ResponseWriter, flusher http.Flusher, payload any) bool {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return true
	}
	if _, err := response.Write([]byte("data: " + string(encoded) + "\n\n")); err != nil {
		return false
	}
	if flusher != nil {
		flusher.Flush()
	}
	return true
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		http.Error(response, "json_encode_failed", http.StatusInternalServerError)
		return
	}
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_, _ = response.Write(encoded)
}
