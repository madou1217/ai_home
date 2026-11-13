package pluginhost

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	plugincontract "github.com/madou1217/ai_home/contracts/plugins"
	adapterplugins "github.com/madou1217/ai_home/internal/adapters/pluginruntime"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

const (
	defaultStartTimeout    = 10 * time.Second
	defaultDialTimeout     = 3 * time.Second
	defaultShutdownTimeout = 3 * time.Second
	defaultTermGrace       = 2 * time.Second
	defaultKillGrace       = 1 * time.Second
	stderrTailLimit        = 8192
	lastExitStderrLimit    = 2048
	readyMarker            = `"plugin_host_ready"`
)

// EnvAllowlist 与 Node supervisor.js 完全一致，不暴露网关凭据或管理密钥给插件宿主子进程。
var EnvAllowlist = []string{
	"PATH", "Path", "PATHEXT",
	"SystemRoot", "SYSTEMROOT", "windir",
	"ComSpec", "COMSPEC",
	"TEMP", "TMP", "TMPDIR",
	"HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA",
	"LANG", "LC_ALL", "LC_CTYPE", "TZ",
}

// ExitEvent 记录宿主子进程退出的退出码、信号与 stderr 尾部摘要。
type ExitEvent struct {
	Code   *int
	Signal string
	At     time.Time
	Stderr string
}

// HostClient 抽象 Supervisor 与运行时之间的宿主 RPC 能力，便于生产真进程与单元测试共用。
type HostClient interface {
	Start(ctx context.Context) error
	Stop(ctx context.Context) error
	Prepare(ctx context.Context, generation int64, plugins []PluginSpec) (HostPrepareResult, error)
	Activate(ctx context.Context, generation int64, retainPrevious bool) (HostActivateResult, error)
	Invoke(ctx context.Context, generation int64, contributionID string, value any, timeout time.Duration) (json.RawMessage, error)
	Dispose(ctx context.Context, generation int64) (HostDisposeResult, error)
	Status(ctx context.Context) (HostStatusResult, error)
	Ping(ctx context.Context) error
	SocketPath() string
	Token() string
	PID() int
	Running() bool
}

// SupervisorOptions 配置 Plugin Host 子进程监督者。
type SupervisorOptions struct {
	AIHomeDir       string
	RepoRoot        string
	SocketPath      string
	Token           string
	HostVersion     string
	NodePath        string
	NodeArgs        []string
	EntryPath       string
	HooksPath       string
	DisableHooks    bool
	Env             []string
	StartTimeout    time.Duration
	DialTimeout     time.Duration
	ShutdownTimeout time.Duration
	OnLog           func(string)
	OnExit          func(ExitEvent)
}

// ResolvePluginSocket 按 Node address.js 相同算法推导本机 IPC 地址（POSIX Unix Socket / Windows Named Pipe）。
func ResolvePluginSocket(aiHomeDir string, targetGOOS string) string {
	if targetGOOS == "" {
		targetGOOS = runtime.GOOS
	}
	base := strings.TrimSpace(aiHomeDir)
	if base == "" {
		base = os.TempDir()
	}
	abs, err := filepath.Abs(base)
	if err != nil {
		abs = base
	}
	sum := sha256.Sum256([]byte(abs))
	digest := hex.EncodeToString(sum[:])[:24]
	if targetGOOS == "windows" {
		return `\\.\pipe\aih-plugin-` + digest
	}
	return filepath.Join(abs, "run", "plugins", "host-"+digest+".sock")
}

// BuildHostEnvironment 仅放行白名单环境变量（与 Node ENV_ALLOWLIST 逐项对齐）。
func BuildHostEnvironment(source []string, extra map[string]string) []string {
	sourceMap := make(map[string]string, len(source))
	for _, item := range source {
		idx := strings.IndexByte(item, '=')
		if idx <= 0 {
			continue
		}
		sourceMap[item[:idx]] = item[idx+1:]
	}
	filtered := make([]string, 0, len(EnvAllowlist)+len(extra))
	for _, key := range EnvAllowlist {
		if val, ok := sourceMap[key]; ok {
			filtered = append(filtered, key+"="+val)
		}
	}
	for key, val := range extra {
		filtered = append(filtered, key+"="+val)
	}
	return filtered
}

// Supervisor 管理单个 Plugin Host Node 子进程及对应的 authenticated RPC 连接。
type Supervisor struct {
	options         SupervisorOptions
	aiHomeDir       string
	socketPath      string
	ownsSocketDir  bool
	token           string
	hostVersion     string
	nodePath        string
	entryPath       string
	hooksPath       string
	startTimeout    time.Duration
	dialTimeout     time.Duration
	shutdownTimeout time.Duration

	mu         sync.Mutex
	cmd        *exec.Cmd
	stdin      io.WriteCloser
	client     *adapterplugins.Client
	exitCh     chan struct{}
	pid        int
	stopping   bool
	startWait  chan struct{}
	startErr   error
	stderrMu   sync.Mutex
	stderrTail string
	lastExit   *ExitEvent
}

// NewSupervisor 构造 Plugin Host 监督者。
func NewSupervisor(options SupervisorOptions) (*Supervisor, error) {
	root := strings.TrimSpace(options.AIHomeDir)
	var absRoot string
	if root != "" {
		resolved, err := filepath.Abs(root)
		if err != nil {
			return nil, err
		}
		absRoot = resolved
	}
	socketPath := strings.TrimSpace(options.SocketPath)
	ownsSocket := socketPath == ""
	if socketPath == "" {
		socketPath = ResolvePluginSocket(absRoot, runtime.GOOS)
	}
	token := strings.TrimSpace(options.Token)
	if token == "" {
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			return nil, fmt.Errorf("生成宿主令牌失败: %w", err)
		}
		token = hex.EncodeToString(raw)
	}
	hostVersion := strings.TrimSpace(options.HostVersion)
	if hostVersion == "" {
		hostVersion = "1.0.0"
	}
	nodePath := strings.TrimSpace(options.NodePath)
	if nodePath == "" {
		nodePath = "node"
	}
	entryPath, hooksPath := resolveHostScripts(options.RepoRoot, options.EntryPath, options.HooksPath)
	startTimeout := options.StartTimeout
	if startTimeout <= 0 {
		startTimeout = defaultStartTimeout
	}
	dialTimeout := options.DialTimeout
	if dialTimeout <= 0 {
		dialTimeout = defaultDialTimeout
	}
	shutdownTimeout := options.ShutdownTimeout
	if shutdownTimeout <= 0 {
		shutdownTimeout = defaultShutdownTimeout
	}
	return &Supervisor{
		options:         options,
		aiHomeDir:       absRoot,
		socketPath:      socketPath,
		ownsSocketDir:  ownsSocket,
		token:           token,
		hostVersion:     hostVersion,
		nodePath:        nodePath,
		entryPath:       entryPath,
		hooksPath:       hooksPath,
		startTimeout:    startTimeout,
		dialTimeout:     dialTimeout,
		shutdownTimeout: shutdownTimeout,
	}, nil
}

func resolveHostScripts(repoRoot, entryPath, hooksPath string) (string, string) {
	entry := strings.TrimSpace(entryPath)
	hooks := strings.TrimSpace(hooksPath)
	searchRoots := make([]string, 0, 4)
	if strings.TrimSpace(repoRoot) != "" {
		searchRoots = append(searchRoots, strings.TrimSpace(repoRoot))
	}
	if cwd, err := os.Getwd(); err == nil {
		searchRoots = append(searchRoots, cwd)
		for cur := cwd; ; {
			parent := filepath.Dir(cur)
			if parent == cur {
				break
			}
			searchRoots = append(searchRoots, parent)
			cur = parent
		}
	}
	if entry == "" {
		for _, base := range searchRoots {
			candidate := filepath.Join(base, "lib", "plugins", "host", "host-entry.mjs")
			if _, err := os.Stat(candidate); err == nil {
				entry = candidate
				break
			}
		}
	}
	if hooks == "" {
		if entry != "" {
			candidate := filepath.Join(filepath.Dir(entry), "register-hooks.mjs")
			if _, err := os.Stat(candidate); err == nil {
				hooks = candidate
			}
		} else {
			for _, base := range searchRoots {
				candidate := filepath.Join(base, "lib", "plugins", "host", "register-hooks.mjs")
				if _, err := os.Stat(candidate); err == nil {
					hooks = candidate
					break
				}
			}
		}
	}
	return entry, hooks
}

func (s *Supervisor) SocketPath() string { return s.socketPath }
func (s *Supervisor) Token() string      { return s.token }

func (s *Supervisor) PID() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pid
}

func (s *Supervisor) Running() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.client != nil && !s.client.Closed() && s.cmd != nil
}

func (s *Supervisor) LastExit() *ExitEvent {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.lastExit == nil {
		return nil
	}
	cp := *s.lastExit
	return &cp
}

// Start 幂等启动 Plugin Host 子进程并完成 RPC 握手；并发调用会合并到同一次启动。
func (s *Supervisor) Start(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	for {
		s.mu.Lock()
		if s.client != nil && !s.client.Closed() && s.cmd != nil {
			s.mu.Unlock()
			return nil
		}
		if s.startWait != nil {
			waitCh := s.startWait
			s.mu.Unlock()
			select {
			case <-waitCh:
				s.mu.Lock()
				err := s.startErr
				s.mu.Unlock()
				return err
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		s.stopping = false
		waitCh := make(chan struct{})
		s.startWait = waitCh
		s.startErr = nil
		s.mu.Unlock()

		err := s.launch(ctx)
		if err != nil {
			stopCtx, cancel := context.WithTimeout(context.Background(), s.shutdownTimeout)
			_ = s.Stop(stopCtx)
			cancel()
		}
		s.mu.Lock()
		s.startErr = err
		s.startWait = nil
		close(waitCh)
		s.mu.Unlock()
		return err
	}
}

func (s *Supervisor) launch(ctx context.Context) error {
	if strings.TrimSpace(s.entryPath) == "" {
		return pluginerr.New(CodeHostStartFailed, "找不到 Plugin Host 入口文件 host-entry.mjs")
	}
	if runtime.GOOS != "windows" {
		if err := os.MkdirAll(filepath.Dir(s.socketPath), 0o700); err != nil {
			return pluginerr.New(CodeHostStartFailed, err.Error())
		}
		_ = os.Remove(s.socketPath)
	}

	s.stderrMu.Lock()
	s.stderrTail = ""
	s.stderrMu.Unlock()

	args := make([]string, 0, len(s.options.NodeArgs)+10)
	args = append(args, s.options.NodeArgs...)
	if !s.options.DisableHooks && s.hooksPath != "" {
		args = append(args, "--import", pathToFileURL(s.hooksPath))
	}
	args = append(args,
		s.entryPath,
		"--socket", s.socketPath,
		"--host-version", s.hostVersion,
		"--exit-with-parent",
	)

	// 不使用 exec.CommandContext：单次 HTTP 请求取消绝不能误杀常驻的 Plugin Host 子进程。
	cmd := exec.Command(s.nodePath, args...)
	srcEnv := s.options.Env
	if srcEnv == nil {
		srcEnv = os.Environ()
	}
	cmd.Env = BuildHostEnvironment(srcEnv, nil)
	configureHostCommand(cmd)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return pluginerr.New(CodeHostStartFailed, err.Error())
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return pluginerr.New(CodeHostStartFailed, err.Error())
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return pluginerr.New(CodeHostStartFailed, err.Error())
	}

	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return pluginerr.New(CodeHostStartFailed, err.Error())
	}

	exitCh := make(chan struct{})
	s.mu.Lock()
	s.cmd = cmd
	s.stdin = stdin
	s.exitCh = exitCh
	if cmd.Process != nil {
		s.pid = cmd.Process.Pid
	}
	s.mu.Unlock()

	// 第一行通过 stdin 写入随机令牌，之后保持管道打开以供子进程感知宿主退出。
	if _, writeErr := io.WriteString(stdin, s.token+"\n"); writeErr != nil {
		// 退出事件会在下面 wait 循环被捕获
	}

	readyCh := make(chan struct{})
	var readyOnce sync.Once
	var pipesWG sync.WaitGroup
	pipesWG.Add(2)

	go func() {
		defer pipesWG.Done()
		reader := bufio.NewReader(stdout)
		var prefix strings.Builder
		for {
			line, readErr := reader.ReadString('\n')
			if len(line) > 0 {
				if prefix.Len() < 64*1024 {
					prefix.WriteString(line)
				}
				if strings.Contains(line, readyMarker) || strings.Contains(prefix.String(), readyMarker) {
					readyOnce.Do(func() { close(readyCh) })
				}
			}
			if readErr != nil {
				return
			}
		}
	}()

	go func() {
		defer pipesWG.Done()
		buf := make([]byte, 4096)
		for {
			n, readErr := stderr.Read(buf)
			if n > 0 {
				chunk := string(buf[:n])
				s.appendStderr(chunk)
				if s.options.OnLog != nil {
					s.options.OnLog(chunk)
				}
			}
			if readErr != nil {
				return
			}
		}
	}()

	go func() {
		waitErr := cmd.Wait()
		pipesWG.Wait()
		evt := buildExitEvent(waitErr, s.readStderrTail())

		s.mu.Lock()
		wasStopping := s.stopping
		s.lastExit = &evt
		if s.cmd == cmd {
			s.cmd = nil
			s.pid = 0
			s.stdin = nil
		}
		cli := s.client
		s.client = nil
		s.mu.Unlock()

		if cli != nil {
			_ = cli.Close()
		}
		close(exitCh)
		if !wasStopping && s.options.OnExit != nil {
			s.options.OnExit(evt)
		}
	}()

	startTimer := time.NewTimer(s.startTimeout)
	defer startTimer.Stop()

	select {
	case <-readyCh:
	case <-exitCh:
		evt := s.LastExit()
		return pluginerr.New(CodeHostExited, formatExitDetail("宿主启动即退出", evt))
	case <-startTimer.C:
		return pluginerr.New(CodeHostStartTimeout, strings.TrimSpace(s.readStderrTail()))
	case <-ctx.Done():
		return ctx.Err()
	}

	dialCtx, dialCancel := context.WithTimeout(ctx, s.dialTimeout)
	defer dialCancel()
	hsTimeout := time.Duration(plugincontract.MaxHandshakeTimeoutMs) * time.Millisecond
	cli, err := adapterplugins.Dial(dialCtx, s.socketPath, adapterplugins.DialOptions{
		Token:            s.token,
		ProtocolVersion:  plugincontract.ProtocolVersion,
		HandshakeTimeout: hsTimeout,
	})
	if err != nil {
		return pluginerr.New(CodeHostStartFailed, err.Error())
	}

	s.mu.Lock()
	if s.stopping || s.cmd != cmd {
		s.mu.Unlock()
		_ = cli.Close()
		return pluginerr.New(CodeHostExited, "宿主在握手完成前停止")
	}
	s.client = cli
	s.mu.Unlock()
	return nil
}

// Stop 优雅关闭宿主子进程：shutdown RPC → 关 stdin → SIGTERM → SIGKILL。
func (s *Supervisor) Stop(ctx context.Context) error {
	if s == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	s.mu.Lock()
	s.stopping = true
	cmd := s.cmd
	stdin := s.stdin
	cli := s.client
	exitCh := s.exitCh
	s.client = nil
	s.mu.Unlock()

	if cli != nil {
		shutCtx, cancel := context.WithTimeout(ctx, s.shutdownTimeout)
		_, _ = cli.Call(shutCtx, "shutdown", map[string]any{}, nil)
		cancel()
		_ = cli.Close()
	}
	if stdin != nil {
		_ = stdin.Close()
	}
	if cmd != nil && exitCh != nil {
		select {
		case <-exitCh:
		case <-time.After(defaultTermGrace):
			if cmd.Process != nil {
				_ = terminateProcess(cmd.Process)
			}
			select {
			case <-exitCh:
			case <-time.After(defaultKillGrace):
				if cmd.Process != nil {
					_ = cmd.Process.Kill()
				}
				<-exitCh
			}
		case <-ctx.Done():
			if cmd.Process != nil {
				_ = cmd.Process.Kill()
			}
			<-exitCh
		}
	}
	if runtime.GOOS != "windows" && strings.TrimSpace(s.socketPath) != "" {
		_ = os.Remove(s.socketPath)
	}
	return nil
}

func (s *Supervisor) Prepare(ctx context.Context, generation int64, plugins []PluginSpec) (HostPrepareResult, error) {
	cli, err := s.ensureClient(ctx)
	if err != nil {
		return HostPrepareResult{}, err
	}
	res, err := cli.Call(ctx, "prepare", map[string]any{
		"generation": generation,
		"plugins":    plugins,
	}, nil)
	if err != nil {
		return HostPrepareResult{}, err
	}
	var out HostPrepareResult
	if err := json.Unmarshal(res.Value, &out); err != nil {
		return HostPrepareResult{}, fmt.Errorf("解析宿主 prepare 结果失败: %w", err)
	}
	return out, nil
}

func (s *Supervisor) Activate(ctx context.Context, generation int64, retainPrevious bool) (HostActivateResult, error) {
	cli, err := s.ensureClient(ctx)
	if err != nil {
		return HostActivateResult{}, err
	}
	res, err := cli.Call(ctx, "activate", map[string]any{
		"generation":     generation,
		"retainPrevious": retainPrevious,
	}, nil)
	if err != nil {
		return HostActivateResult{}, err
	}
	var out HostActivateResult
	if err := json.Unmarshal(res.Value, &out); err != nil {
		return HostActivateResult{}, fmt.Errorf("解析宿主 activate 结果失败: %w", err)
	}
	return out, nil
}

func (s *Supervisor) Invoke(ctx context.Context, generation int64, contributionID string, value any, timeout time.Duration) (json.RawMessage, error) {
	cli, err := s.ensureClient(ctx)
	if err != nil {
		return nil, err
	}
	callCtx := ctx
	if callCtx == nil {
		callCtx = context.Background()
	}
	var cancel context.CancelFunc
	if timeout > 0 {
		callCtx, cancel = context.WithTimeout(callCtx, timeout)
		defer cancel()
	}
	res, err := cli.Call(callCtx, "invoke", map[string]any{
		"generation":     generation,
		"contributionId": contributionID,
		"value":          value,
	}, nil)
	if err != nil {
		return nil, err
	}
	return res.Value, nil
}

func (s *Supervisor) Dispose(ctx context.Context, generation int64) (HostDisposeResult, error) {
	cli, err := s.requireClient()
	if err != nil {
		return HostDisposeResult{Generation: generation, State: "disposed"}, nil
	}
	res, err := cli.Call(ctx, "dispose", map[string]any{
		"generation": generation,
	}, nil)
	if err != nil {
		return HostDisposeResult{}, err
	}
	var out HostDisposeResult
	if err := json.Unmarshal(res.Value, &out); err != nil {
		return HostDisposeResult{}, fmt.Errorf("解析宿主 dispose 结果失败: %w", err)
	}
	return out, nil
}

func (s *Supervisor) Status(ctx context.Context) (HostStatusResult, error) {
	cli, err := s.requireClient()
	if err != nil {
		return HostStatusResult{}, err
	}
	res, err := cli.Call(ctx, "status", map[string]any{}, nil)
	if err != nil {
		return HostStatusResult{}, err
	}
	var out HostStatusResult
	if err := json.Unmarshal(res.Value, &out); err != nil {
		return HostStatusResult{}, fmt.Errorf("解析宿主 status 结果失败: %w", err)
	}
	return out, nil
}

func (s *Supervisor) Ping(ctx context.Context) error {
	cli, err := s.requireClient()
	if err != nil {
		return err
	}
	_, err = cli.Call(ctx, "ping", map[string]any{}, nil)
	return err
}

func (s *Supervisor) ensureClient(ctx context.Context) (*adapterplugins.Client, error) {
	cli, err := s.requireClient()
	if err == nil {
		return cli, nil
	}
	if startErr := s.Start(ctx); startErr != nil {
		return nil, startErr
	}
	return s.requireClient()
}

func (s *Supervisor) requireClient() (*adapterplugins.Client, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.client == nil || s.client.Closed() {
		return nil, pluginerr.New(CodeRuntimeUnavailable, "插件宿主未连接")
	}
	return s.client, nil
}

func (s *Supervisor) appendStderr(chunk string) {
	s.stderrMu.Lock()
	defer s.stderrMu.Unlock()
	s.stderrTail += chunk
	if len(s.stderrTail) > stderrTailLimit {
		s.stderrTail = s.stderrTail[len(s.stderrTail)-stderrTailLimit:]
	}
}

func (s *Supervisor) readStderrTail() string {
	s.stderrMu.Lock()
	defer s.stderrMu.Unlock()
	return s.stderrTail
}

func buildExitEvent(waitErr error, stderrTail string) ExitEvent {
	evt := ExitEvent{At: time.Now().UTC()}
	if len(stderrTail) > lastExitStderrLimit {
		evt.Stderr = stderrTail[len(stderrTail)-lastExitStderrLimit:]
	} else {
		evt.Stderr = stderrTail
	}
	if waitErr == nil {
		zero := 0
		evt.Code = &zero
		return evt
	}
	var exitErr *exec.ExitError
	if errors.As(waitErr, &exitErr) {
		code := exitErr.ExitCode()
		evt.Code = &code
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			evt.Signal = status.Signal().String()
		}
	} else {
		neg := -1
		evt.Code = &neg
	}
	return evt
}

func formatExitDetail(prefix string, evt *ExitEvent) string {
	if evt == nil {
		return prefix
	}
	codeStr := "null"
	if evt.Code != nil {
		codeStr = strconv.Itoa(*evt.Code)
	}
	sigStr := "null"
	if evt.Signal != "" {
		sigStr = evt.Signal
	}
	return strings.TrimSpace(fmt.Sprintf("%s code=%s signal=%s %s", prefix, codeStr, sigStr, strings.TrimSpace(evt.Stderr)))
}

func pathToFileURL(filePath string) string {
	abs, err := filepath.Abs(filePath)
	if err != nil {
		abs = filePath
	}
	slashed := filepath.ToSlash(abs)
	if !strings.HasPrefix(slashed, "/") {
		slashed = "/" + slashed
	}
	return (&url.URL{Scheme: "file", Path: slashed}).String()
}
