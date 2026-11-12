// Package webuisessioneventsapi 提供 WebUI 会话增量事件的只读管理接口。
//
// 契约来源是 Node lib/sessions/session-reader.js 的 readSessionEvents
// （GET /v0/webui/sessions/:provider/:sessionId/events）：
//
//	GET /v1/management/webui/sessions/{provider}/{sessionId}/events?cursor=<byte>&projectDirName=<dir>
//	响应 { "ok": true, "events": [...], "cursor": <byte>, "requiresSnapshot"?: bool,
//	       "hasAssistantToolCall": bool }
//
// 本切片只承接 codex 的增量读取：它的会话真相是一个可追加的 rollout JSONL，
// cursor 是该文件里的字节偏移。其它 Provider 在 Node 侧只有「文件大小变化就回
// snapshot」的兜底语义，各自需要不同的会话定位器；Go 侧未实现前返回
// unsupported_provider，由 Node 继续本地处理，不猜格式。
//
// 对拍证据：testdata/parity-cases.json 由 Node 现实现生成
// （scripts/dump-session-events-parity-cases.js），TestNodeParity（Go）与
// test/webui-session-events-parity.test.js（Node）共同校验同一份真值。
//
// 与 Node 的差异（有意为之，均为更严格的边界）：
//   - 非法/负 cursor 归零；Node 会用 Number() 接受小数，随后在 fs 调用处失败。
//   - sessionId 必须是安全的单段值（不含 / \ ..）；Node 只做路由正则匹配。
//   - Go 找不到 rollout 时返回 404，而 Node 通过 state DB 仍可能找到 sessions 目录
//     之外的会话；Node 代理据此回落，因此 /v0/webui 的公开契约不变。
package webuisessioneventsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

// Path 是会话增量事件的管理契约路径。
//
//	GET /v1/management/webui/sessions/{provider}/{sessionId}/events
const Path = "/v1/management/webui/sessions/{provider}/{sessionId}/events"

// ErrorCodeUnsupportedProvider 表示该 Provider 的增量事件尚未由 Go 承接。
const ErrorCodeUnsupportedProvider = "unsupported_provider"

// ErrInvalidDependencies 表示 Handler 缺少鉴权或读取端口。
var ErrInvalidDependencies = errors.New("会话事件接口依赖无效")

// ErrUnsupportedProvider 表示该 Provider 的增量事件尚未由 Go 承接。
var ErrUnsupportedProvider = errors.New("该 Provider 的增量事件尚未由 Go 承接")

// ErrSessionNotFound 表示 Go 的会话定位器找不到 rollout 文件。
//
// 这不等同于 Node 的「空事件 + cursor 0」：Node 可能通过 state DB 找到 sessions
// 目录之外的文件。Handler 返回 404，Node 代理据此回落，公开契约保持不变。
var ErrSessionNotFound = errors.New("会话文件不存在")

// Authorizer 是管理面请求的鉴权策略（与其它 WebUI 契约共用同一个 Bearer 实现）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// EventRequest 是一次增量读取的输入。
//
// ProjectDirName 只为与 Node 的查询参数保持同形；codex 的 sessionId 已能唯一定位文件。
type EventRequest struct {
	Provider       string
	SessionID      string
	ProjectDirName string
	Cursor         int64
}

// Event 是响应里的一条增量事件。
//
// Node 按事件类型输出不同的字段集合，这里用 Kind 驱动 MarshalJSON，避免 Go 的
// 结构体零值把 Node 不会出现的字段带进响应。
type Event struct {
	Kind      string
	Timestamp any
	Content   string
	Images    []string
	Source    string
	Text      string
	CallID    any
	Model     string
}

// EventResult 是增量读取的结果；字段与 Node 的返回对象一一对应。
type EventResult struct {
	Events []Event `json:"events"`
	Cursor int64   `json:"cursor"`
	// RequiresSnapshot 为 nil 时省略该字段：Node 在「cursor 已是最新」的早退分支
	// 不返回它，其余分支都显式返回布尔值。
	RequiresSnapshot     *bool `json:"requiresSnapshot,omitempty"`
	HasAssistantToolCall bool  `json:"hasAssistantToolCall"`
}

// Reader 是按字节游标读取会话增量事件的端口。
type Reader interface {
	ReadEvents(ctx context.Context, request EventRequest) (EventResult, error)
}

// Dependencies 汇总会话事件接口的依赖。
type Dependencies struct {
	Authorizer  Authorizer
	HostHomeDir string
	Reader      Reader
	// MaxEventBytes 只在 Reader 为空、由本包构造 FileReader 时生效。
	MaxEventBytes int
}

// Handler 是会话增量事件的 HTTP 入站适配器。
type Handler struct {
	authorizer Authorizer
	reader     Reader
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (http.Handler, error) {
	if dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	reader := dependencies.Reader
	if reader == nil {
		home := strings.TrimSpace(dependencies.HostHomeDir)
		if home == "" {
			return nil, ErrInvalidDependencies
		}
		reader = &FileReader{HostHomeDir: home, MaxEventBytes: dependencies.MaxEventBytes}
	}
	return &Handler{authorizer: dependencies.Authorizer, reader: reader}, nil
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
	if provider == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_provider"})
		return
	}
	cursor := parseCursor(r.URL.Query().Get("cursor"))
	result, err := handler.reader.ReadEvents(r.Context(), EventRequest{
		Provider:       provider,
		SessionID:      sessionID,
		ProjectDirName: strings.TrimSpace(r.URL.Query().Get("projectDirName")),
		Cursor:         cursor,
	})
	if err != nil {
		if errors.Is(err, ErrUnsupportedProvider) {
			writeJSON(w, http.StatusNotImplemented, map[string]any{
				"ok": false, "error": ErrorCodeUnsupportedProvider,
				"message": "该 Provider 的增量事件尚未由 Go 承接",
			})
			return
		}
		if errors.Is(err, ErrSessionNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]any{
				"ok": false, "error": "session_not_found", "message": "会话文件不存在",
			})
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"ok": false, "error": "get_session_events_failed", "message": "会话事件读取失败",
		})
		return
	}
	if result.Events == nil {
		result.Events = []Event{}
	}
	writeJSON(w, http.StatusOK, struct {
		OK bool `json:"ok"`
		EventResult
	}{OK: true, EventResult: result})
}

// parseCursor 复刻 Node 的 Math.max(0, Number(value) || 0) 可接受输入。
func parseCursor(raw string) int64 {
	value := strings.TrimSpace(raw)
	if value == "" {
		return 0
	}
	cursor, err := strconv.ParseInt(value, 10, 64)
	if err != nil || cursor < 0 {
		return 0
	}
	return cursor
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(body)
}
