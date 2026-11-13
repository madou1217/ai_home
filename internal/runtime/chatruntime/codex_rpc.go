package chatruntime

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
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
	JSONRPC string         `json:"jsonrpc,omitempty"`
	ID      any            `json:"id,omitempty"`
	Method  string         `json:"method,omitempty"`
	Params  map[string]any `json:"params,omitempty"`
	Result  map[string]any `json:"result,omitempty"`
	Error   *CodexRPCError `json:"error,omitempty"`
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

	mu          sync.Mutex
	connected   bool
	closed      bool
	cmd         *exec.Cmd
	waitDone    chan struct{}
	stdin       io.WriteCloser
	writeMu     sync.Mutex
	nextID      atomic.Int64
	pending     map[string]chan codexRPCResult
	bindings    map[string]CodexTurnBinding
	identity    *CodexVerifiedIdentity
	runtimeHome CodexRuntimeHome
	hasHome     bool
	stderrTail  bytes.Buffer
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
		bindings:       make(map[string]CodexTurnBinding),
	}
}

// EnsureConnected 建立或复用与 codex app-server 的 stdio 会话并完成 initialize 握手。
func (c *CodexAppServerClient) EnsureConnected(ctx context.Context) error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return NewError("codex_app_server_closed", http.StatusGone, nil)
	}
	if c.connected {
		c.mu.Unlock()
		return nil
	}
	c.mu.Unlock()

	if ctx == nil {
		ctx = context.Background()
	}

	command, args, env, runtimeHome, err := c.resolveSpawnSpec()
	if err != nil {
		return err
	}

	cmd := exec.Command(command, args...)
	cmd.Env = env
	if runtimeHome.CodexHome != "" {
		_ = os.MkdirAll(runtimeHome.CodexHome, 0o700)
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return NewErrorWithMessage("codex_app_server_spawn_failed", http.StatusBadGateway, err.Error(), nil)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return NewErrorWithMessage("codex_app_server_spawn_failed", http.StatusBadGateway, err.Error(), nil)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return NewErrorWithMessage("codex_app_server_spawn_failed", http.StatusBadGateway, err.Error(), nil)
	}
	if err := cmd.Start(); err != nil {
		return NewErrorWithMessage("codex_app_server_spawn_failed", http.StatusBadGateway, err.Error(), nil)
	}

	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		_ = stdin.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		_ = cmd.Wait()
		return NewError("codex_app_server_closed", http.StatusGone, nil)
	}
	waitDone := make(chan struct{})
	c.cmd = cmd
	c.waitDone = waitDone
	c.stdin = stdin
	c.connected = true
	c.runtimeHome = runtimeHome
	c.hasHome = runtimeHome.CodexHome != ""
	c.identity = &CodexVerifiedIdentity{
		Verified:   true,
		Kind:       "oauth",
		Assurance:  "runtime-home",
		AccountRef: c.opts.AccountRef,
	}
	c.stderrTail.Reset()
	c.mu.Unlock()

	go c.drainStderr(stderr)
	go c.readLoop(stdout, cmd, waitDone)

	// 执行 initialize 握手与 initialized 通知，并在失败时收口进程。
	initCtx, cancel := context.WithTimeout(ctx, c.requestTimeout)
	defer cancel()
	if _, err := c.Request(initCtx, "initialize", map[string]any{
		"clientInfo": map[string]any{
			"name":    "ai_home",
			"title":   "AIH Server",
			"version": "1.0.0",
		},
		"capabilities": map[string]any{
			"experimentalApi": true,
		},
	}); err != nil {
		_ = c.disconnect(err)
		return NewErrorWithMessage("codex_app_server_initialize_failed", http.StatusBadGateway, err.Error(), nil)
	}
	_ = c.writeEnvelope(map[string]any{
		"jsonrpc": "2.0",
		"method":  "initialized",
	})
	return nil
}

// Request 向 app-server 发起 JSON-RPC 请求并等待匹配响应。
func (c *CodexAppServerClient) Request(ctx context.Context, method string, params any) (map[string]any, error) {
	if err := c.EnsureConnected(ctx); err != nil {
		return nil, err
	}
	if ctx == nil {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(context.Background(), c.requestTimeout)
		defer cancel()
	}

	idNum := c.nextID.Add(1)
	key := "n:" + strconv.FormatInt(idNum, 10)
	ch := make(chan codexRPCResult, 1)

	c.mu.Lock()
	if !c.connected || c.closed {
		c.mu.Unlock()
		return nil, NewError("codex_app_server_disconnected", http.StatusBadGateway, nil)
	}
	c.pending[key] = ch
	c.mu.Unlock()

	envelope := map[string]any{
		"jsonrpc": "2.0",
		"id":      idNum,
		"method":  method,
	}
	if params != nil {
		envelope["params"] = params
	}
	if err := c.writeEnvelope(envelope); err != nil {
		c.mu.Lock()
		delete(c.pending, key)
		c.mu.Unlock()
		return nil, NewErrorWithMessage("codex_app_server_write_failed", http.StatusBadGateway, err.Error(), nil)
	}

	select {
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, key)
		c.mu.Unlock()
		return nil, NewErrorWithMessage("codex_app_server_timeout", http.StatusGatewayTimeout, ctx.Err().Error(), map[string]any{"method": method})
	case res := <-ch:
		return res.result, res.err
	}
}

// Respond 回写服务端发起请求的 JSON-RPC 成功响应（审批/提问/elicitation）。
func (c *CodexAppServerClient) Respond(_ context.Context, requestID any, result any) error {
	if result == nil {
		result = map[string]any{}
	}
	return c.writeEnvelope(map[string]any{
		"jsonrpc": "2.0",
		"id":      requestID,
		"result":  result,
	})
}

// RespondError 回写服务端发起请求的 JSON-RPC 错误响应。
func (c *CodexAppServerClient) RespondError(_ context.Context, requestID any, code int, message string) error {
	return c.writeEnvelope(map[string]any{
		"jsonrpc": "2.0",
		"id":      requestID,
		"error": map[string]any{
			"code":    code,
			"message": message,
		},
	})
}

// BindTurn 注册指定原生线程的通知与服务端请求回调。
func (c *CodexAppServerClient) BindTurn(threadID string, binding CodexTurnBinding) {
	id := strings.TrimSpace(threadID)
	if id == "" {
		return
	}
	c.mu.Lock()
	c.bindings[id] = binding
	c.mu.Unlock()
}

// UnbindTurn 解除指定原生线程的事件绑定。
func (c *CodexAppServerClient) UnbindTurn(threadID string) {
	id := strings.TrimSpace(threadID)
	if id == "" {
		return
	}
	c.mu.Lock()
	delete(c.bindings, id)
	c.mu.Unlock()
}

// ReleaseThread 释放常驻线程占用的运行态（与 Node releaseThread 对齐，尽力而为）。
func (c *CodexAppServerClient) ReleaseThread(_ context.Context, threadID string) error {
	c.UnbindTurn(threadID)
	return nil
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

func (c *CodexAppServerClient) disconnect(reason error) error {
	c.mu.Lock()
	wasConnected := c.connected
	c.connected = false
	cmd := c.cmd
	waitDone := c.waitDone
	stdin := c.stdin
	c.cmd = nil
	c.waitDone = nil
	c.stdin = nil
	pending := c.pending
	c.pending = make(map[string]chan codexRPCResult)
	bindings := make([]CodexTurnBinding, 0, len(c.bindings))
	for _, b := range c.bindings {
		bindings = append(bindings, b)
	}
	c.bindings = make(map[string]CodexTurnBinding)
	c.mu.Unlock()

	if stdin != nil {
		_ = stdin.Close()
	}
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
	if waitDone != nil {
		select {
		case <-waitDone:
		case <-time.After(2 * time.Second):
		}
	}

	if reason == nil {
		reason = NewError("codex_app_server_disconnected", http.StatusBadGateway, nil)
	}
	for _, ch := range pending {
		ch <- codexRPCResult{err: reason}
		close(ch)
	}
	if wasConnected {
		for _, b := range bindings {
			if b.OnDisconnected != nil {
				b.OnDisconnected(reason)
			}
		}
	}
	return nil
}

func (c *CodexAppServerClient) writeEnvelope(payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	c.mu.Lock()
	stdin := c.stdin
	connected := c.connected
	c.mu.Unlock()
	if !connected || stdin == nil {
		return NewError("codex_app_server_disconnected", http.StatusBadGateway, nil)
	}
	raw = append(raw, '\n')
	_, err = stdin.Write(raw)
	return err
}

func (c *CodexAppServerClient) drainStderr(r io.Reader) {
	buf := make([]byte, 4096)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			c.mu.Lock()
			if c.stderrTail.Len() > 8192 {
				b := c.stderrTail.Bytes()
				c.stderrTail.Reset()
				_, _ = c.stderrTail.Write(b[len(b)-4096:])
			}
			_, _ = c.stderrTail.Write(buf[:n])
			c.mu.Unlock()
		}
		if err != nil {
			return
		}
	}
}

func (c *CodexAppServerClient) readLoop(stdout io.Reader, cmd *exec.Cmd, waitDone chan struct{}) {
	defer func() {
		_ = cmd.Wait()
		close(waitDone)
	}()
	reader := bufio.NewReader(stdout)
	for {
		line, err := reader.ReadBytes('\n')
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) > 0 {
			c.dispatchLine(trimmed)
		}
		if err != nil {
			c.mu.Lock()
			tail := strings.TrimSpace(c.stderrTail.String())
			stillSame := c.cmd == cmd
			c.mu.Unlock()
			if !stillSame {
				return
			}
			msg := "codex app-server disconnected"
			if tail != "" {
				msg = tail
			} else if err != nil && !errors.Is(err, io.EOF) {
				msg = err.Error()
			}
			_ = c.disconnect(NewErrorWithMessage("codex_app_server_disconnected", http.StatusBadGateway, msg, nil))
			return
		}
	}
}

func (c *CodexAppServerClient) dispatchLine(line []byte) {
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.UseNumber()
	var raw map[string]any
	if err := dec.Decode(&raw); err != nil {
		return
	}
	idVal, hasID := raw["id"]
	method := strings.TrimSpace(asString(raw["method"]))
	params, _ := raw["params"].(map[string]any)
	result, _ := raw["result"].(map[string]any)

	// 带 id 且无 method → 我方出站请求的响应
	if hasID && method == "" {
		key := canonicalRPCIDKey(idVal)
		c.mu.Lock()
		ch := c.pending[key]
		delete(c.pending, key)
		c.mu.Unlock()
		if ch == nil {
			return
		}
		if errRaw, ok := raw["error"].(map[string]any); ok {
			codeInt := -32000
			if n, ok := coerceInt(errRaw["code"]); ok {
				codeInt = n
			}
			rpcErr := &CodexRPCError{
				Code:    codeInt,
				Message: strings.TrimSpace(asString(errRaw["message"])),
				Data:    errRaw["data"],
			}
			ch <- codexRPCResult{
				err: NewErrorWithMessage("codex_app_server_rpc_error", http.StatusBadGateway, rpcErr.Error(), map[string]any{
					"rpcCode": rpcErr.Code,
				}),
			}
		} else {
			ch <- codexRPCResult{result: result}
		}
		close(ch)
		return
	}

	msg := CodexJSONRPCMessage{
		ID:     idVal,
		Method: method,
		Params: params,
	}

	// 带 id 且带 method → 服务端发起的双向请求（审批/提问/MCP elicitation/remote tool）
	if hasID && method != "" {
		binding, ok := c.lookupBinding(params)
		if !ok || binding.OnServerRequest == nil {
			_ = c.RespondError(context.Background(), idVal, -32601, "unsupported server request method: "+method)
			return
		}
		binding.OnServerRequest(msg)
		return
	}

	// 通知（无 id，有 method）
	if method != "" {
		binding, ok := c.lookupBinding(params)
		if ok && binding.OnNotification != nil {
			binding.OnNotification(msg)
		}
	}
}

func (c *CodexAppServerClient) lookupBinding(params map[string]any) (CodexTurnBinding, bool) {
	threadID := strings.TrimSpace(asString(params["threadId"]))
	if threadID == "" {
		if turnMap, ok := params["turn"].(map[string]any); ok {
			threadID = strings.TrimSpace(asString(turnMap["threadId"]))
		}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if threadID != "" {
		b, ok := c.bindings[threadID]
		return b, ok
	}
	if len(c.bindings) == 1 {
		for _, b := range c.bindings {
			return b, true
		}
	}
	return CodexTurnBinding{}, false
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

// CodexClientLease 表示对池中常驻 CodexRPCClient 的借用租约。
type CodexClientLease struct {
	Client  CodexRPCClient
	Release func() bool
}

// CodexClientPool 按 runtimeScope + fingerprint 复用常驻 app-server 客户端。
type CodexClientPool struct {
	mu      sync.Mutex
	entries map[string]*codexPoolEntry
	closed  bool
	factory func(opts CodexAppServerClientOptions) CodexRPCClient
}

type codexPoolEntry struct {
	key    string
	client CodexRPCClient
	refs   int
}

// NewCodexClientPool 构造常驻 Codex app-server 客户端连接池。
func NewCodexClientPool(factory func(opts CodexAppServerClientOptions) CodexRPCClient) *CodexClientPool {
	if factory == nil {
		factory = func(opts CodexAppServerClientOptions) CodexRPCClient {
			return NewCodexAppServerClient(opts)
		}
	}
	return &CodexClientPool{
		entries: make(map[string]*codexPoolEntry),
		factory: factory,
	}
}

// Acquire 获取或创建对应作用域的客户端租约。
func (p *CodexClientPool) Acquire(opts CodexAppServerClientOptions) *CodexClientLease {
	key := strings.TrimSpace(opts.RuntimeScope) + "::" + strings.TrimSpace(opts.RuntimeFingerprint)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		client := p.factory(opts)
		return &CodexClientLease{
			Client: client,
			Release: func() bool {
				_ = client.Close()
				return true
			},
		}
	}
	entry := p.entries[key]
	if entry == nil {
		entry = &codexPoolEntry{
			key:    key,
			client: p.factory(opts),
		}
		p.entries[key] = entry
	}
	entry.refs++
	var once sync.Once
	return &CodexClientLease{
		Client: entry.client,
		Release: func() bool {
			released := false
			once.Do(func() {
				p.mu.Lock()
				defer p.mu.Unlock()
				entry.refs--
				released = true
				if entry.refs <= 0 && (p.closed || p.entries[key] != entry) {
					delete(p.entries, key)
					_ = entry.client.Close()
				}
			})
			return released
		},
	}
}

// Close 释放池中全部常驻客户端。
func (p *CodexClientPool) Close() error {
	p.mu.Lock()
	p.closed = true
	entries := make([]*codexPoolEntry, 0, len(p.entries))
	for k, e := range p.entries {
		entries = append(entries, e)
		delete(p.entries, k)
	}
	p.mu.Unlock()
	for _, e := range entries {
		_ = e.client.Close()
	}
	return nil
}
