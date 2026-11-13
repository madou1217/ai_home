// Package webuiterminalapi 提供 WebUI 底部终端面板的 Go 传输层。
//
// 边界（重要）：
//   - 终端会话（PTY、回放缓冲、空闲回收、mux SSE 分发）全部由本包的
//     terminalsession.Service 承担；Node 只保留浏览器路径与管理密钥门，把请求原样
//     反代到 /v1/management/webui/terminal/*；
//   - 浏览器协议与 SSE 帧形状必须与旧 Node 实现逐字段一致（见 sessions.go / sse.go），
//     前端不感知这次迁移；
//   - 需要任意可执行/argv/env 的入口只有 /launch：它面向 Node 进程内的账号/远程工作区
//     启动器，永远不经浏览器路由转发。浏览器 /open 只接受 cols/rows/muxId/cwd/sessionKey。
//
// 持久化：会话 key 对应的 tmux 外层由 tmux.go 管理（与旧 Node webui-terminal-persistence
// 同一套 socket 命名与 systemd scope 语义），服务重启后 attach 可接回原 shell。
package webuiterminalapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/contracts/chatattachments"
	"github.com/madou1217/ai_home/internal/runtime/pty"
	"github.com/madou1217/ai_home/internal/runtime/terminalsession"
)

const (
	// Prefix 是本切片的管理前缀。浏览器仍走 Node 的 /v0/webui/terminal/*。
	Prefix = "/v1/management/webui/terminal"

	// defaultCols / defaultRows 与 Node 路由的缺省尺寸一致。
	defaultCols = 80
	defaultRows = 24
	// maxJSONBodyBytes 与 Node readJsonBody 的默认上限一致。
	maxJSONBodyBytes = 256 * 1024
	// maxClipboardBodyBytes 按 contracts/chatattachments 的 MaxImageBytes
	// 反推 base64 体积，再留 4KB 头尾余量（与 Node 完全一致）。
	maxClipboardBodyBytes = (chatattachments.MaxImageBytes+2)/3*4 + 4096
	// DefaultHeartbeatInterval 与 Node 的 30s SSE 心跳一致。
	DefaultHeartbeatInterval = 30 * time.Second
	// subscriptionQueueSize 是单个 session 订阅的帧缓冲；慢消费者被摘除而不是反压 PTY。
	subscriptionQueueSize = 256
)

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// SessionService 是 terminalsession.Service 的入站端口。
//
// 这里依赖接口而不是具体类型，是为了让 handler 的错误路径测试可以注入假实现；
// 返回的订阅仍是具体类型（它带闭包状态，无法在包外构造）。
type SessionService interface {
	Create(context.Context, terminalsession.Spec) (terminalsession.Snapshot, error)
	Attach(string) (terminalsession.Snapshot, error)
	Write(string, []byte) error
	Resize(string, pty.Size) (terminalsession.Snapshot, error)
	Kill(string) error
	Subscribe(string, int) (*terminalsession.Subscription, error)
	List() []terminalsession.Snapshot
	Reap() []string
}

// Shell 是一个终端要执行的命令。
type Shell struct {
	File string
	Args []string
}

// ShellPicker 返回宿主默认 shell；Windows 与 Unix 的差异只在实现里。
type ShellPicker func() Shell

// Dependencies 汇总入站依赖。
type Dependencies struct {
	Authorizer Authorizer
	Sessions   SessionService
	// Durable 管理 sessionKey 对应的 tmux 外层；为空时按「tmux 不可用」处理，
	// 终端仍可打开，只是返回 durable=false（与 Node 在 tmux 缺失时的行为一致）。
	Durable DurableStore
	// Shell 覆盖默认 shell 选择（测试用）。
	Shell ShellPicker
	// HomeDir 是 cwd 回退目录；为空时用 os.UserHomeDir()。
	HomeDir string
	// LookupEnv 允许测试注入环境变量读取；为空时用 os.LookupEnv。
	LookupEnv func(string) string
	// MaxBodyBytes 覆盖普通 JSON 请求上限。
	MaxBodyBytes int64
	// HeartbeatInterval 覆盖 SSE 心跳间隔；<=0 表示关闭心跳。
	HeartbeatInterval time.Duration
	// Now 提供时间（测试可注入）。
	Now func() time.Time
}

// Handler 实现 /v1/management/webui/terminal/* 的全部端点。
type Handler struct {
	authorizer Authorizer
	sessions   SessionService
	durable    DurableStore
	pickShell  ShellPicker
	homeDir    string
	lookupEnv  func(string) string
	maxBody    int64
	heartbeat  time.Duration
	now        func() time.Time

	shimOnce sync.Once
	shimDir  string

	mu    sync.Mutex
	muxes map[string]*muxStream
	meta  map[string]*sessionMeta
}

// sessionMeta 是 terminalsession.Snapshot 之外、只有传输层关心的会话信息。
// muxID 决定输出分发到哪条面板流；shell 是用户请求的 shell（durable 会话底层
// 跑的是 tmux attach，不能拿 Snapshot.Path 当 shell 回报）。
type sessionMeta struct {
	muxID string
	shell string
}

// ErrInvalidDependencies 表示 handler 缺少必需依赖。
var ErrInvalidDependencies = errors.New("WebUI 终端接口依赖无效")

// NewHandler 校验依赖并返回 handler。缺鉴权或会话服务必须装配期失败。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Sessions == nil {
		return nil, ErrInvalidDependencies
	}
	homeDir := strings.TrimSpace(dependencies.HomeDir)
	if homeDir == "" {
		homeDir, _ = os.UserHomeDir()
	}
	lookupEnv := dependencies.LookupEnv
	if lookupEnv == nil {
		lookupEnv = func(key string) string {
			value, _ := os.LookupEnv(key)
			return value
		}
	}
	pickShell := dependencies.Shell
	if pickShell == nil {
		pickShell = defaultShellPicker(lookupEnv)
	}
	maxBody := dependencies.MaxBodyBytes
	if maxBody <= 0 {
		maxBody = maxJSONBodyBytes
	}
	heartbeat := dependencies.HeartbeatInterval
	if heartbeat == 0 {
		heartbeat = DefaultHeartbeatInterval
	}
	now := dependencies.Now
	if now == nil {
		now = time.Now
	}
	durable := dependencies.Durable
	if durable == nil {
		durable = missingDurable{}
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		sessions:   dependencies.Sessions,
		durable:    durable,
		pickShell:  pickShell,
		homeDir:    homeDir,
		lookupEnv:  lookupEnv,
		maxBody:    maxBody,
		heartbeat:  heartbeat,
		now:        now,
		muxes:      make(map[string]*muxStream),
		meta:       make(map[string]*sessionMeta),
	}, nil
}

// terminalError 是领域错误到 HTTP 状态的唯一映射点。
// 同一错误码在不同端点有不同状态（attach 的 persistent_terminal_unavailable 是 503，
// open 的是 500——与 Node 路由一一对应），因此这里只带错误码，状态由端点决定。
type terminalError struct {
	code    string
	message string
}

func (err *terminalError) Error() string {
	if err.message != "" {
		return err.code + ": " + err.message
	}
	return err.code
}

var (
	errTerminalNotFound              = &terminalError{code: "terminal_not_found"}
	errTooManyTerminals              = &terminalError{code: "too_many_terminals"}
	errPersistentTerminalUnavailable = &terminalError{code: "persistent_terminal_unavailable"}
	errPTYSpawnFailed                = &terminalError{code: "pty_spawn_failed"}
)

// ServeHTTP 按路径分发；未知路径返回稳定的 JSON 404。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.sessions == nil {
		writeError(response, http.StatusServiceUnavailable, "terminal_unavailable", "终端服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}

	path := strings.TrimPrefix(request.URL.Path, Prefix)
	switch {
	case request.Method == http.MethodGet && path == "/mux":
		handler.handleMux(response, request)
	case request.Method == http.MethodGet && path == "/stream":
		handler.handleStream(response, request)
	case request.Method == http.MethodGet && path == "/probe":
		handler.handleProbe(response, request)
	case request.Method == http.MethodPost && path == "/open":
		handler.handleOpen(response, request)
	case request.Method == http.MethodPost && path == "/attach":
		handler.handleAttach(response, request)
	case request.Method == http.MethodPost && path == "/launch":
		handler.handleLaunch(response, request)
	case request.Method == http.MethodPost && path == "/input":
		handler.handleInput(response, request)
	case request.Method == http.MethodPost && path == "/resize":
		handler.handleResize(response, request)
	case request.Method == http.MethodPost && path == "/close":
		handler.handleClose(response, request)
	case request.Method == http.MethodPost && path == "/clipboard-image":
		handler.handleClipboardImage(response, request)
	default:
		writeError(response, http.StatusNotFound, "terminal_route_not_found", "未知终端端点")
	}
}

// Close 解除所有 mux 订阅，供宿主停机时调用。
func (handler *Handler) Close() error {
	if handler == nil {
		return nil
	}
	handler.mu.Lock()
	muxes := make([]*muxStream, 0, len(handler.muxes))
	for id, stream := range handler.muxes {
		muxes = append(muxes, stream)
		delete(handler.muxes, id)
	}
	handler.mu.Unlock()
	for _, stream := range muxes {
		stream.shutdown()
	}
	return nil
}

// ---------- JSON 工具 ----------

// readJSON 尽力解码请求体；解析失败或超限时保持零值（对齐 Node readJsonBody 的
// 「失败即 null」语义：open 退化成默认参数，而不是直接 400）。
func (handler *Handler) readJSON(request *http.Request, limit int64, target any) {
	if request == nil || request.Body == nil {
		return
	}
	var reader io.Reader = request.Body
	if limit > 0 {
		reader = http.MaxBytesReader(nil, request.Body, limit)
	}
	decoder := json.NewDecoder(reader)
	_ = decoder.Decode(target)
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		http.Error(response, "terminal_response_encode_failed", http.StatusInternalServerError)
		return
	}
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_, _ = response.Write(body)
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}

func writeTerminalError(response http.ResponseWriter, status int, err *terminalError) {
	writeJSON(response, status, errorView{OK: false, Error: err.code, Message: err.message})
}

// statusForOpen / statusForAttach 复刻 Node 路由的状态码。
func statusForOpen(err *terminalError) int {
	if err.code == "too_many_terminals" {
		return http.StatusTooManyRequests
	}
	return http.StatusInternalServerError
}

func statusForAttach(err *terminalError) int {
	switch err.code {
	case "terminal_not_found":
		return http.StatusNotFound
	case "too_many_terminals":
		return http.StatusTooManyRequests
	default:
		return http.StatusServiceUnavailable
	}
}

// intValue 容忍前端可能送来的数字或数字字符串（Node 用 Number(...) 归一）。
func intValue(value any) int {
	switch item := value.(type) {
	case float64:
		return int(item)
	case int:
		return item
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(item))
		if err == nil {
			return parsed
		}
	}
	return 0
}
