// Package webuisessionwatchapi 提供单个会话的 SSE 与原生 WebSocket 实时事件流接口。
//
// 路由（管理面与浏览器别名）：
//
//	GET /v1/management/webui/sessions/watch?provider=...&sessionId=...&projectDirName=...
//	GET /v1/management/webui/sessions/watch/ws
//	GET /v0/webui/sessions/watch/ws
//
// WebSocket 通道遵循首帧鉴权契约（浏览器 new WebSocket 无法附带 HTTP Authorization 头，
// 且 URL 查询串不得承载管理密钥）：握手阶段先校验同源 Origin，建连后在限定时间内读取首条文本帧
// {"authorization":"Bearer ...","provider":"...","sessionId":"...","projectDirName":"..."}，
// 校验通过后订阅 Go sessionevents.Bus 并立即下发 {"type":"connected"}，随后增量推送 {"type":"update",...}。
package webuisessionwatchapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/sessionevents"
)

const (
	// Path 是会话 watch SSE 管理契约路径。
	Path = "/v1/management/webui/sessions/watch"
	// PublicPath 是会话 watch SSE 浏览器契约路径。
	PublicPath = "/v0/webui/sessions/watch"
	// WSPath 是会话 watch 原生 WebSocket 管理契约路径。
	WSPath = "/v1/management/webui/sessions/watch/ws"
	// PublicWSPath 是会话 watch 原生 WebSocket 浏览器契约路径。
	PublicWSPath = "/v0/webui/sessions/watch/ws"

	// DefaultHeartbeatInterval 与其它 WebUI SSE 接口一致。
	DefaultHeartbeatInterval = 30 * time.Second
	// DefaultWSHeartbeatInterval 是 WebSocket Ping 保活周期。
	DefaultWSHeartbeatInterval = 15 * time.Second
	// DefaultAuthTimeout 是 WebSocket 建连后等待首帧鉴权的超时上限。
	DefaultAuthTimeout = 5 * time.Second
	// DefaultWSWriteTimeout 是单帧 WebSocket 写出的背压超时上限（慢消费者超时即断开，防阻塞）。
	DefaultWSWriteTimeout = 5 * time.Second
)

// ErrInvalidDependencies 表示缺少 Authorizer 或 Bus。
var ErrInvalidDependencies = errors.New("WebUI 会话 watch 接口依赖无效")

// Authorizer 是管理面请求的鉴权策略。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 描述会话 watch 接口依赖。
type Dependencies struct {
	Authorizer          Authorizer
	Bus                 *sessionevents.Bus
	AIHomeDir           string
	HostHomeDir         string
	HeartbeatInterval   time.Duration
	WSHeartbeatInterval time.Duration
	AuthTimeout         time.Duration
	WSWriteTimeout      time.Duration
}

// Handler 处理会话实时监听的 SSE 与 WebSocket 请求。
type Handler struct {
	authorizer          Authorizer
	bus                 *sessionevents.Bus
	aiHomeDir           string
	hostHomeDir         string
	heartbeatInterval   time.Duration
	wsHeartbeatInterval time.Duration
	authTimeout         time.Duration
	wsWriteTimeout      time.Duration
}

type watchUpdatePayload struct {
	Type           string                     `json:"type"`
	Provider       string                     `json:"provider"`
	SessionID      string                     `json:"sessionId"`
	ProjectDirName string                     `json:"projectDirName"`
	ProjectPath    string                     `json:"projectPath"`
	Source         string                     `json:"source"`
	EventType      string                     `json:"eventType"`
	Reason         string                     `json:"reason"`
	EventName      string                     `json:"eventName"`
	Phase          string                     `json:"phase"`
	RunID          string                     `json:"runId,omitempty"`
	PromptID       string                     `json:"promptId,omitempty"`
	Prompt         map[string]any             `json:"prompt,omitempty"`
	RetryStatus    *sessionevents.RetryStatus `json:"retryStatus,omitempty"`
}

// NewHandler 校验依赖并构建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Bus == nil {
		return nil, ErrInvalidDependencies
	}
	heartbeat := dependencies.HeartbeatInterval
	if heartbeat <= 0 {
		heartbeat = DefaultHeartbeatInterval
	}
	wsHeartbeat := dependencies.WSHeartbeatInterval
	if wsHeartbeat <= 0 {
		wsHeartbeat = DefaultWSHeartbeatInterval
	}
	authTimeout := dependencies.AuthTimeout
	if authTimeout <= 0 {
		authTimeout = DefaultAuthTimeout
	}
	wsWriteTimeout := dependencies.WSWriteTimeout
	if wsWriteTimeout <= 0 {
		wsWriteTimeout = DefaultWSWriteTimeout
	}
	return &Handler{
		authorizer:          dependencies.Authorizer,
		bus:                 dependencies.Bus,
		aiHomeDir:           strings.TrimSpace(dependencies.AIHomeDir),
		hostHomeDir:         strings.TrimSpace(dependencies.HostHomeDir),
		heartbeatInterval:   heartbeat,
		wsHeartbeatInterval: wsHeartbeat,
		authTimeout:         authTimeout,
		wsWriteTimeout:      wsWriteTimeout,
	}, nil
}

// ServeHTTP 按路径与握手头分派原生 WebSocket 或 SSE 会话变更流。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.bus == nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{
			"ok":      false,
			"error":   "session_watch_unavailable",
			"message": "会话事件监听服务不可用",
		})
		return
	}
	// WebSocket 握手请求由首帧承载 Bearer 凭据，必须在 HTTP 头鉴权前转入 WebSocket 流程。
	if isWebSocketWatchRequest(request) {
		handler.serveWebSocket(response, request)
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(response, http.StatusUnauthorized, map[string]any{
			"ok":      false,
			"error":   "unauthorized",
			"message": "需要管理密钥",
		})
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeJSON(response, http.StatusMethodNotAllowed, map[string]any{
			"ok":      false,
			"error":   "method_not_allowed",
			"message": "仅支持 GET",
		})
		return
	}

	query := request.URL.Query()
	target, ok := parseWatchSessionTarget(
		query.Get("provider"),
		query.Get("sessionId"),
		query.Get("projectDirName"),
	)
	if !ok {
		writeJSON(response, http.StatusBadRequest, map[string]any{
			"ok":      false,
			"error":   "missing_params",
			"message": "provider 和 sessionId 必填",
		})
		return
	}

	_, ok = response.(http.Flusher)
	if !ok {
		writeJSON(response, http.StatusInternalServerError, map[string]any{
			"ok":      false,
			"error":   "streaming_unsupported",
			"message": "当前响应写出器不支持 SSE 刷新",
		})
		return
	}

	eventsCh, doneCh, unsubscribe := handler.bus.Subscribe(target, true)
	defer unsubscribe()

	// SSE sockets are not hijacked: bound every write/flush and unblock it on
	// host cancellation instead of waiting for the global server write timeout.
	controller := http.NewResponseController(response)
	defer controller.SetWriteDeadline(time.Time{})
	deadlineCanceled := make(chan struct{})
	stopOnClose := context.AfterFunc(handler.bus.Context(), func() {
		defer close(deadlineCanceled)
		_ = controller.SetWriteDeadline(time.Now())
	})
	defer func() {
		if !stopOnClose() {
			<-deadlineCanceled
		}
	}()
	writeFrame := func(body any) error {
		if err := handler.bus.Context().Err(); err != nil {
			return err
		}
		if err := controller.SetWriteDeadline(time.Now().Add(handler.wsWriteTimeout)); err != nil {
			return err
		}
		if err := writeSSEJSON(response, body); err != nil {
			return err
		}
		return controller.Flush()
	}

	response.Header().Set("Content-Type", "text/event-stream")
	response.Header().Set("Cache-Control", "no-cache")
	response.Header().Set("Connection", "keep-alive")
	response.Header().Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)

	if err := writeFrame(map[string]string{"type": "connected"}); err != nil {
		return
	}

	heartbeat := time.NewTicker(handler.heartbeatInterval)
	defer heartbeat.Stop()

	ctx := request.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-doneCh:
			return
		case <-heartbeat.C:
			if err := controller.SetWriteDeadline(time.Now().Add(handler.wsWriteTimeout)); err != nil {
				return
			}
			if _, err := response.Write([]byte(": heartbeat\n\n")); err != nil {
				return
			}
			if err := controller.Flush(); err != nil {
				return
			}
		case event := <-eventsCh:
			for _, item := range drainCoalescedWatchBatch(event, eventsCh) {
				payload := handler.buildPayload(target, item)
				if err := writeFrame(payload); err != nil {
					return
				}
			}
		}
	}
}

func parseWatchSessionTarget(rawProvider, rawSessionID, rawProjectDirName string) (sessionevents.Session, bool) {
	provider := strings.ToLower(strings.TrimSpace(rawProvider))
	sessionID := strings.TrimSpace(rawSessionID)
	projectDirName := strings.TrimSpace(rawProjectDirName)
	if provider == "" || sessionID == "" || len(provider) > 64 || len(sessionID) > 1024 || len(projectDirName) > 4096 {
		return sessionevents.Session{}, false
	}
	return sessionevents.Session{
		Provider:       provider,
		SessionID:      sessionID,
		ProjectDirName: projectDirName,
	}, true
}

func isPureWatchRefreshEvent(event sessionevents.Event) bool {
	return (event.Type == "session:update" || event.Type == "session:file-changed") &&
		strings.TrimSpace(event.EventName) == "" &&
		event.Prompt == nil &&
		event.RetryStatus == nil &&
		strings.TrimSpace(event.RunID) == "" &&
		strings.TrimSpace(event.PromptID) == "" &&
		strings.TrimSpace(event.Phase) == ""
}

// drainCoalescedWatchBatch 单趟非阻塞排空当前缓冲事件，合并连续的纯刷新通知，同时严格保留全部带状态负载事件。
func drainCoalescedWatchBatch(first sessionevents.Event, eventsCh <-chan sessionevents.Event) []sessionevents.Event {
	batch := []sessionevents.Event{first}
	for i := 0; i < 64; i++ {
		select {
		case next := <-eventsCh:
			last := &batch[len(batch)-1]
			if isPureWatchRefreshEvent(*last) &&
				isPureWatchRefreshEvent(next) &&
				strings.TrimSpace(last.Type) == strings.TrimSpace(next.Type) &&
				strings.TrimSpace(last.Source) == strings.TrimSpace(next.Source) &&
				last.Reason == next.Reason && last.ProjectDirName == next.ProjectDirName && last.ProjectPath == next.ProjectPath {
				*last = next
			} else {
				batch = append(batch, next)
			}
		default:
			return batch
		}
	}
	return batch
}

func (handler *Handler) buildPayload(session sessionevents.Session, event sessionevents.Event) watchUpdatePayload {
	provider := strings.TrimSpace(event.Provider)
	if provider == "" {
		provider = session.Provider
	}
	sessionID := strings.TrimSpace(event.SessionID)
	if sessionID == "" {
		sessionID = session.SessionID
	}
	projectDirName := strings.TrimSpace(event.ProjectDirName)
	if projectDirName == "" {
		projectDirName = session.ProjectDirName
	}
	projectPath := strings.TrimSpace(event.ProjectPath)
	if projectPath != "" {
		projectPath = sessionevents.CanonicalizePath(projectPath, handler.aiHomeDir, handler.hostHomeDir, provider)
	}
	source := strings.TrimSpace(event.Source)
	if source == "" {
		source = "session-event-bus"
	}
	eventType := strings.TrimSpace(event.Type)
	if eventType == "" {
		eventType = "session:update"
	}
	return watchUpdatePayload{
		Type:           "update",
		Provider:       provider,
		SessionID:      sessionID,
		ProjectDirName: projectDirName,
		ProjectPath:    projectPath,
		Source:         source,
		EventType:      eventType,
		Reason:         strings.TrimSpace(event.Reason),
		EventName:      strings.TrimSpace(event.EventName),
		Phase:          strings.TrimSpace(event.Phase),
		RunID:          strings.TrimSpace(event.RunID),
		PromptID:       strings.TrimSpace(event.PromptID),
		Prompt:         event.Prompt,
		RetryStatus:    event.RetryStatus,
	}
}

func writeSSEJSON(response http.ResponseWriter, body any) error {
	encoded, err := json.Marshal(body)
	if err != nil {
		return err
	}
	frame := make([]byte, 0, len(encoded)+8)
	frame = append(frame, "data: "...)
	frame = append(frame, encoded...)
	frame = append(frame, '\n', '\n')
	_, err = response.Write(frame)
	return err
}

func writeJSON(response http.ResponseWriter, status int, body any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	encoder := json.NewEncoder(response)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(body)
}
