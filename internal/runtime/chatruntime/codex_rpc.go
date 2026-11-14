package chatruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/codexhooks"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
	"github.com/madou1217/ai_home/internal/runtime/providercliupgrade"
)

const (
	defaultCodexRPCTimeout = 60 * time.Second
)

// CodexVerifiedIdentity 描述已校验的 Codex app-server 执行账号身份。
type CodexVerifiedIdentity struct {
	Verified   bool   `json:"verified"`
	Kind       string `json:"kind"`
	Assurance  string `json:"assurance"`
	AccountRef string `json:"accountRef,omitempty"`
}

// CodexRuntimeHome 描述已校验的 Codex 运行目录与配置文件位置。
type CodexRuntimeHome struct {
	RuntimeScope string `json:"runtimeScope"`
	CodexHome    string `json:"codexHome"`
	HomeHash     string `json:"homeHash,omitempty"`
}

// CodexRPCError 表示 JSON-RPC 错误载荷。
type CodexRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func (e *CodexRPCError) Error() string {
	if e == nil {
		return ""
	}
	if e.Message != "" {
		return fmt.Sprintf("codex app-server rpc %d: %s", e.Code, e.Message)
	}
	return fmt.Sprintf("codex app-server rpc %d", e.Code)
}

// CodexJSONRPCMessage 描述一条双向 JSON-RPC 2.0 消息（请求、响应或通知）。
type CodexJSONRPCMessage struct {
	// Context 携带连接代次；回调内的 RPC 不能静默重连到其他子进程。
	Context context.Context `json:"-"`
	JSONRPC string          `json:"jsonrpc,omitempty"`
	ID      any             `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  map[string]any  `json:"params,omitempty"`
	Result  map[string]any  `json:"result,omitempty"`
	Error   *CodexRPCError  `json:"error,omitempty"`
}

// CodexTurnBinding 描述单线程的实时事件与断开回调。
type CodexTurnBinding struct {
	OnDisconnected    func(err error)
	OnNotification    func(msg CodexJSONRPCMessage)
	OnServerRequest   func(msg CodexJSONRPCMessage)
	OnReconnectResume func(response map[string]any, client CodexRPCClient)
	ResumeParams      map[string]any
}

// CodexRPCClient 定义 Codex app-server 双向 JSON-RPC 端口（支持真实子进程与测试桩）。
type CodexRPCClient interface {
	EnsureConnected(ctx context.Context) error
	Request(ctx context.Context, method string, params any) (map[string]any, error)
	Respond(ctx context.Context, requestID any, result any) error
	RespondError(ctx context.Context, requestID any, code int, message string) error
	BindTurn(threadID string, binding CodexTurnBinding)
	UnbindTurn(threadID string)
	ReleaseThread(ctx context.Context, threadID string) error
	GetVerifiedAccountIdentity() *CodexVerifiedIdentity
	GetVerifiedRuntimeHome() (CodexRuntimeHome, bool)
	Close() error
}

// CodexAppServerClientOptions 配置 stdio app-server 子进程客户端。
type CodexAppServerClientOptions struct {
	AIHomeDir          string
	HostHomeDir        string
	RuntimeScope       string
	RuntimeFingerprint string
	AccountRef         string
	ExecutablePath     string
	Command            string
	Args               []string
	Env                []string
	RequestTimeout     time.Duration
	DiagnosticSink     func(map[string]any)
}

// CodexAppServerClient 维护一条常驻的 codex app-server --listen stdio:// 双向 JSON-RPC 连接。
type CodexAppServerClient struct {
	opts           CodexAppServerClientOptions
	requestTimeout time.Duration

	mu             sync.Mutex
	connected      bool
	ready          bool
	connecting     *codexConnectFlight
	dispatch       *codexRPCDispatch
	dispatchers    int
	connectionDone chan struct{}
	releases       map[string]*codexThreadRelease
	onIdle         func()
	closed         bool
	retiring       bool
	cmd            *exec.Cmd
	waitDone       chan struct{}
	stdin          io.WriteCloser
	stdout         io.ReadCloser
	stderr         io.ReadCloser
	writeMu        sync.Mutex
	nextID         atomic.Int64
	pending        map[string]chan codexRPCResult
	bindings       map[string]*codexTurnRegistration
	identity       *CodexVerifiedIdentity
	runtimeHome    CodexRuntimeHome
	hasHome        bool
	stderrTail     bytes.Buffer
}

type codexRPCResult struct {
	result map[string]any
	err    error
}

// NewCodexAppServerClient 构造常驻双向 app-server 客户端（延迟建连）。
func NewCodexAppServerClient(opts CodexAppServerClientOptions) *CodexAppServerClient {
	timeout := opts.RequestTimeout
	if timeout <= 0 {
		timeout = defaultCodexRPCTimeout
	}
	return &CodexAppServerClient{
		opts:           opts,
		requestTimeout: timeout,
		pending:        make(map[string]chan codexRPCResult),
		bindings:       make(map[string]*codexTurnRegistration),
		releases:       make(map[string]*codexThreadRelease),
	}
}

// Request 始终施加有界 deadline，调用方更短的 deadline / 取消仍优先。
func (c *CodexAppServerClient) Request(ctx context.Context, method string, params any) (map[string]any, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	ctx, cancel := context.WithTimeout(ctx, c.requestTimeout)
	defer cancel()
	cmd, scoped := ctx.Value(codexRPCConnectionKey{}).(*exec.Cmd)
	if !scoped {
		if err := c.EnsureConnected(ctx); err != nil {
			return nil, err
		}
		c.mu.Lock()
		if !c.ready || !c.connected || c.closed || c.retiring {
			c.mu.Unlock()
			return nil, NewError("codex_app_server_disconnected", http.StatusBadGateway, nil)
		}
		cmd = c.cmd
		c.mu.Unlock()
	}
	return c.requestConnected(ctx, cmd, method, params)
}

// requestConnected 只在指定连接上发送；initialize 也走此入口而不递归 EnsureConnected。
func (c *CodexAppServerClient) requestConnected(ctx context.Context, cmd *exec.Cmd, method string, params any) (map[string]any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	idNum := c.nextID.Add(1)
	key := "n:" + strconv.FormatInt(idNum, 10)
	ch := make(chan codexRPCResult, 1)
	c.mu.Lock()
	if !c.connected || c.closed || c.retiring || c.cmd != cmd || cmd == nil {
		c.mu.Unlock()
		return nil, NewError("codex_app_server_disconnected", http.StatusBadGateway, nil)
	}
	// 旧 unsubscribe 完成前不能重新 resume/start/steer 同线程；失败明确可重试，
	// 不把新请求写入上游后再发现 release 仍在飞。读目录等无 threadId 请求不受影响。
	if method != "thread/unsubscribe" {
		if object, ok := params.(map[string]any); ok {
			if threadID := asString(object["threadId"]); threadID != "" && c.releases[threadID] != nil {
				c.mu.Unlock()
				return nil, NewError("codex_thread_release_in_progress", http.StatusConflict, nil)
			}
		}
	}
	if len(c.pending) >= maxCodexPendingRequests {
		c.mu.Unlock()
		return nil, NewError("codex_app_server_requests_full", http.StatusTooManyRequests, nil)
	}
	c.pending[key] = ch
	c.mu.Unlock()
	defer func() { c.mu.Lock(); delete(c.pending, key); c.mu.Unlock() }()
	envelope := map[string]any{"jsonrpc": "2.0", "id": idNum, "method": method}
	if params != nil {
		envelope["params"] = params
	}
	if err := c.writeConnectionEnvelope(ctx, cmd, envelope); err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		err := NewErrorWithMessage("codex_app_server_timeout", http.StatusGatewayTimeout, ctx.Err().Error(), map[string]any{"method": method})
		err.Cause = ctx.Err()
		return nil, err
	case res := <-ch:
		return res.result, res.err
	}
}

// Respond 回写服务端发起请求的 JSON-RPC 成功响应（审批/提问/elicitation）。
func (c *CodexAppServerClient) Respond(ctx context.Context, requestID any, result any) error {
	if result == nil {
		result = map[string]any{}
	}
	return c.writeEnvelope(ctx, map[string]any{
		"jsonrpc": "2.0",
		"id":      requestID,
		"result":  result,
	})
}

// RespondError 回写服务端发起请求的 JSON-RPC 错误响应。
func (c *CodexAppServerClient) RespondError(ctx context.Context, requestID any, code int, message string) error {
	return c.writeEnvelope(ctx, map[string]any{
		"jsonrpc": "2.0",
		"id":      requestID,
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	})
}

// GetVerifiedAccountIdentity 返回已校验的执行身份（支持 runtime-home 与 gateway 校验）。
func (c *CodexAppServerClient) GetVerifiedAccountIdentity() *CodexVerifiedIdentity {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.identity != nil {
		cp := *c.identity
		return &cp
	}
	if strings.TrimSpace(c.opts.AccountRef) != "" {
		return &CodexVerifiedIdentity{
			Verified:   true,
			Kind:       "oauth",
			Assurance:  "runtime-home",
			AccountRef: c.opts.AccountRef,
		}
	}
	return nil
}

// GetVerifiedRuntimeHome 返回已校验的运行目录描述。
func (c *CodexAppServerClient) GetVerifiedRuntimeHome() (CodexRuntimeHome, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.runtimeHome, c.hasHome
}

// Close 关闭底层 app-server 子进程与全部挂起请求。
func (c *CodexAppServerClient) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	c.mu.Unlock()
	return c.disconnect(NewError("codex_app_server_closed", http.StatusGone, nil))
}

func canonicalRPCIDKey(raw any) string {
	switch v := raw.(type) {
	case string:
		return "s:" + v
	case json.Number:
		return "n:" + v.String()
	case int:
		return "n:" + strconv.Itoa(v)
	case int64:
		return "n:" + strconv.FormatInt(v, 10)
	case float64:
		return "n:" + strconv.FormatInt(int64(v), 10)
	default:
		return fmt.Sprintf("v:%v", raw)
	}
}

func (c *CodexAppServerClient) resolveSpawnSpec() (string, []string, []string, CodexRuntimeHome, error) {
	command := strings.TrimSpace(c.opts.Command)
	args := append([]string(nil), c.opts.Args...)
	if command == "" {
		bin, err := providercli.ResolveBinary("codex", strings.TrimSpace(c.opts.ExecutablePath))
		if err != nil {
			return "", nil, nil, CodexRuntimeHome{}, NewErrorWithMessage("codex_app_server_binary_unavailable", http.StatusServiceUnavailable, err.Error(), nil)
		}
		command = bin
		if len(args) == 0 {
			args = []string{"app-server", "--listen", "stdio://", "-c", "thread_unload_delay_secs=0"}
		}
	}

	env := append([]string(nil), c.opts.Env...)
	if len(env) == 0 {
		env = os.Environ()
	}

	homeDir := strings.TrimSpace(c.opts.HostHomeDir)
	if homeDir == "" {
		homeDir, _ = os.UserHomeDir()
	}
	aiHomeDir := strings.TrimSpace(c.opts.AIHomeDir)
	if aiHomeDir == "" && homeDir != "" {
		aiHomeDir = filepath.Join(homeDir, ".ai_home")
	}

	scope := strings.TrimSpace(c.opts.RuntimeScope)
	if scope == "" {
		scope = strings.TrimSpace(c.opts.AccountRef)
	}
	if scope == "" {
		scope = GatewayRuntimeScope
	}

	var codexHome string
	for _, entry := range env {
		if k, v, ok := strings.Cut(entry, "="); ok && k == "CODEX_HOME" && strings.TrimSpace(v) != "" {
			codexHome = strings.TrimSpace(v)
			break
		}
	}
	if codexHome == "" && aiHomeDir != "" {
		safeScope := strings.NewReplacer("/", "_", "\\", "_", ":", "_").Replace(scope)
		codexHome = filepath.Join(aiHomeDir, "run", "codex-app-server-homes", safeScope)
		env = appendOrReplaceEnv(env, "CODEX_HOME", codexHome)
		env = appendOrReplaceEnv(env, "CODEX_SQLITE_HOME", codexHome)
		env = appendOrReplaceEnv(env, codexhooks.CodexAppServerPassthroughEnv, "1")
	}
	if codexHome != "" {
		_ = os.MkdirAll(codexHome, 0o700)
		// 对齐网关托管 config.toml：确保 aih_server provider 节存在，避免 codex 秒退。
		_ = providercliupgrade.HealCodexSandboxConfig(codexHome, "")
	}

	runtimeHome := CodexRuntimeHome{
		RuntimeScope: scope,
		CodexHome:    codexHome,
	}
	return command, args, env, runtimeHome, nil
}

func appendOrReplaceEnv(env []string, key, value string) []string {
	prefix := key + "="
	out := make([]string, 0, len(env)+1)
	replaced := false
	for _, e := range env {
		if strings.HasPrefix(e, prefix) {
			if !replaced {
				out = append(out, prefix+value)
				replaced = true
			}
			continue
		}
		out = append(out, e)
	}
	if !replaced {
		out = append(out, prefix+value)
	}
	return out
}
