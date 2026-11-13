// Package webuisessionwatchapi 提供单个会话的 SSE 实时事件流接口。
//
// 路由（管理面）：
//
//	GET /v1/management/webui/sessions/watch?provider=...&sessionId=...&projectDirName=...
//
// 连接建立后立即下发 {"type":"connected"}，随后把 Go sessionevents.Bus 上匹配的
// Hook 状态变更与 fsnotify 会话文件变更以 {"type":"update",...} SSE 帧实时推送到前端。
package webuisessionwatchapi

import (
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

	// DefaultHeartbeatInterval 与其它 WebUI SSE 接口一致。
	DefaultHeartbeatInterval = 30 * time.Second
)

// ErrInvalidDependencies 表示缺少 Authorizer 或 Bus。
var ErrInvalidDependencies = errors.New("WebUI 会话 watch 接口依赖无效")

// Authorizer 是管理面请求的鉴权策略。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 描述会话 watch 接口依赖。
type Dependencies struct {
	Authorizer        Authorizer
	Bus               *sessionevents.Bus
	AIHomeDir         string
	HostHomeDir       string
	HeartbeatInterval time.Duration
}

// Handler 处理 GET /v1/management/webui/sessions/watch。
type Handler struct {
	authorizer        Authorizer
	bus               *sessionevents.Bus
	aiHomeDir         string
	hostHomeDir       string
	heartbeatInterval time.Duration
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
	return &Handler{
		authorizer:        dependencies.Authorizer,
		bus:               dependencies.Bus,
		aiHomeDir:         strings.TrimSpace(dependencies.AIHomeDir),
		hostHomeDir:       strings.TrimSpace(dependencies.HostHomeDir),
		heartbeatInterval: heartbeat,
	}, nil
}

// ServeHTTP 输出会话变更 SSE 流。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.bus == nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{
			"ok":      false,
			"error":   "session_watch_unavailable",
			"message": "会话事件监听服务不可用",
		})
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
	provider := strings.ToLower(strings.TrimSpace(query.Get("provider")))
	sessionID := strings.TrimSpace(query.Get("sessionId"))
	projectDirName := strings.TrimSpace(query.Get("projectDirName"))
	if provider == "" || sessionID == "" || len(provider) > 64 || len(sessionID) > 1024 || len(projectDirName) > 4096 {
		writeJSON(response, http.StatusBadRequest, map[string]any{
			"ok":      false,
			"error":   "missing_params",
			"message": "provider 和 sessionId 必填",
		})
		return
	}

	flusher, ok := response.(http.Flusher)
	if !ok {
		writeJSON(response, http.StatusInternalServerError, map[string]any{
			"ok":      false,
			"error":   "streaming_unsupported",
			"message": "当前响应写出器不支持 SSE 刷新",
		})
		return
	}

	target := sessionevents.Session{
		Provider:       provider,
		SessionID:      sessionID,
		ProjectDirName: projectDirName,
	}
	eventsCh, doneCh, unsubscribe := handler.bus.Subscribe(target, true)
	defer unsubscribe()

	response.Header().Set("Content-Type", "text/event-stream")
	response.Header().Set("Cache-Control", "no-cache")
	response.Header().Set("Connection", "keep-alive")
	response.Header().Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)

	if err := writeSSEJSON(response, map[string]string{"type": "connected"}); err != nil {
		return
	}
	flusher.Flush()

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
			if _, err := response.Write([]byte(": heartbeat\n\n")); err != nil {
				return
			}
			flusher.Flush()
		case event := <-eventsCh:
			payload := handler.buildPayload(target, event)
			if err := writeSSEJSON(response, payload); err != nil {
				return
			}
			flusher.Flush()
		}
	}
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
