package codexappserverapi

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/madou1217/ai_home/internal/runtime/codexappserverws"
)

const (
	// maxAppServerLineBytes 限制 WebSocket 单帧接收上限。
	maxAppServerLineBytes = 16 * 1024 * 1024
	// defaultStartupProbeTimeout 在 WS 握手前短暂探活子进程，避免秒退进程误回 101。
	defaultStartupProbeTimeout = 150 * time.Millisecond
)

var (
	// ErrInvalidAppServerDependencies 表示 Handler 缺少必须的运行配置或目录。
	ErrInvalidAppServerDependencies = errors.New("Codex app-server 代理配置无效")
)

// Authorizer 校验 clientKey 或等价鉴权请求头。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// StdioProcessConfig 描述即将拉起的 codex app-server --listen stdio:// 进程参数。
type StdioProcessConfig struct {
	Command string
	Args    []string
	Env     []string
}

// StdioSession 表示一次双向 stdio 传输连接（生产为子进程，单测可注入管道模拟）。
type StdioSession struct {
	Stdin  io.WriteCloser
	Stdout io.ReadCloser
	Stderr io.ReadCloser
	Wait   func() error
	Close  func() error
}

// AppServerDependencies 声明 Codex app-server WebSocket 代理端口依赖。
type AppServerDependencies struct {
	Authorizer          Authorizer
	AIHomeDir           string
	HostHomeDir         string
	AccountStore        codexappserverws.AccountStore
	StartupProbeTimeout time.Duration
	ResolveCodex        func() (string, error)
	DialStdio           func(ctx context.Context, cfg StdioProcessConfig) (*StdioSession, error)
	LogDebug            func(message string)
	LogError            func(err error)
}

// AppServerHandler 处理 /v0/codex/app-server 与根路径的 WebSocket 升级请求并桥接 stdio app-server。
type AppServerHandler struct {
	authorizer          Authorizer
	aiHomeDir           string
	hostHomeDir         string
	accountStore        codexappserverws.AccountStore
	startupProbeTimeout time.Duration
	resolveCodex        func() (string, error)
	dialStdio           func(ctx context.Context, cfg StdioProcessConfig) (*StdioSession, error)
	logDebug            func(message string)
	logError            func(err error)
}

// NewAppServerHandler 创建 Codex app-server WebSocket 代理 Handler。
func NewAppServerHandler(deps AppServerDependencies) (*AppServerHandler, error) {
	hostHome := strings.TrimSpace(deps.HostHomeDir)
	resolveFn := deps.ResolveCodex
	if resolveFn == nil {
		resolveFn = func() (string, error) {
			return codexappserverws.ResolveCodexBinary(hostHome)
		}
	}
	probeTimeout := deps.StartupProbeTimeout
	if probeTimeout == 0 {
		probeTimeout = defaultStartupProbeTimeout
	} else if probeTimeout < 0 {
		probeTimeout = 0
	}
	dialFn := deps.DialStdio
	if dialFn == nil {
		dialFn = func(ctx context.Context, cfg StdioProcessConfig) (*StdioSession, error) {
			return defaultDialAppServerStdio(ctx, cfg, probeTimeout)
		}
	}
	return &AppServerHandler{
		authorizer:          deps.Authorizer,
		aiHomeDir:           strings.TrimSpace(deps.AIHomeDir),
		hostHomeDir:         hostHome,
		accountStore:        deps.AccountStore,
		startupProbeTimeout: probeTimeout,
		resolveCodex:        resolveFn,
		dialStdio:           dialFn,
		logDebug:            deps.LogDebug,
		logError:            deps.LogError,
	}, nil
}

// BuildSpawnEnv 构造隔离且带有默认账号/网关凭据及远端代理标记的子进程环境变量。
func (h *AppServerHandler) BuildSpawnEnv() []string {
	env, err := h.buildSpawnEnv(context.Background())
	if err != nil {
		if h != nil && h.logError != nil {
			h.logError(err)
		}
		return BuildAppServerSpawnEnv(h.aiHomeDir, h.hostHomeDir, os.Environ())
	}
	return env
}

func (h *AppServerHandler) buildSpawnEnv(ctx context.Context) ([]string, error) {
	return codexappserverws.BuildSpawnEnv(ctx, codexappserverws.SpawnEnvOptions{
		AIHomeDir:    h.aiHomeDir,
		HostHomeDir:  h.hostHomeDir,
		BaseEnv:      os.Environ(),
		AccountStore: h.accountStore,
	})
}

// BuildAppServerSpawnEnv 构造规范化的 app-server 派生环境（含默认账号/网关注入、HOME/CODEX_HOME/XDG 及标志位）。
func BuildAppServerSpawnEnv(aiHomeDir string, hostHomeDir string, baseEnv []string) []string {
	env, err := codexappserverws.BuildSpawnEnv(context.Background(), codexappserverws.SpawnEnvOptions{
		AIHomeDir:   aiHomeDir,
		HostHomeDir: hostHomeDir,
		BaseEnv:     baseEnv,
	})
	if err != nil {
		return baseEnv
	}
	return env
}

func defaultDialAppServerStdio(
	ctx context.Context,
	cfg StdioProcessConfig,
	probeTimeout time.Duration,
) (*StdioSession, error) {
	proc, err := codexappserverws.StartAppServerProcess(codexappserverws.StartProcessOptions{
		Command: cfg.Command,
		Args:    cfg.Args,
		Env:     cfg.Env,
	})
	if err != nil {
		return nil, err
	}
	if err := proc.WaitForStartup(ctx, probeTimeout); err != nil {
		proc.Close()
		return nil, err
	}
	return &StdioSession{
		Stdin:  proc.Stdin(),
		Stdout: proc.Stdout(),
		Stderr: proc.Stderr(),
		Wait: func() error {
			<-proc.Done()
			return proc.WaitErr()
		},
		Close: func() error {
			proc.Close()
			return nil
		},
	}, nil
}

// ServeHTTP 处理 WebSocket 升级、认证校验以及与 Codex app-server stdio 进程的双向帧转发。
func (h *AppServerHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if h == nil || request == nil {
		http.Error(response, "service unavailable", http.StatusServiceUnavailable)
		return
	}
	if !IsAppServerUpgradePath(request.URL.Path) {
		http.NotFound(response, request)
		return
	}
	if request.Method != http.MethodGet {
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if h.authorizer != nil && !h.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		http.Error(response, "unauthorized", http.StatusUnauthorized)
		return
	}
	if !IsUpgradeRequest(request) {
		http.Error(response, "upgrade required", http.StatusUpgradeRequired)
		return
	}

	codexBin, err := h.resolveCodex()
	if err != nil || strings.TrimSpace(codexBin) == "" {
		if h.logError != nil && err != nil {
			h.logError(err)
		}
		http.Error(response, "codex binary unavailable", http.StatusServiceUnavailable)
		return
	}

	spawnEnv, err := h.buildSpawnEnv(request.Context())
	if err != nil {
		if h.logError != nil {
			h.logError(err)
		}
		http.Error(response, "codex spawn environment failed", http.StatusInternalServerError)
		return
	}

	injectedCwd := strings.TrimSpace(request.URL.Query().Get("aih_cwd"))
	ctx, cancel := context.WithCancel(request.Context())
	defer cancel()

	stdio, err := h.dialStdio(ctx, StdioProcessConfig{
		Command: codexBin,
		Args:    []string{"app-server", "--listen", "stdio://"},
		Env:     spawnEnv,
	})
	if err != nil {
		if h.logError != nil {
			h.logError(err)
		}
		http.Error(response, "codex app-server start failed", http.StatusBadGateway)
		return
	}

	controller := http.NewResponseController(response)
	_ = controller.SetReadDeadline(time.Time{})
	_ = controller.SetWriteDeadline(time.Time{})

	wsConn, err := websocket.Accept(response, request, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
	})
	if err != nil {
		if stdio.Close != nil {
			_ = stdio.Close()
		}
		return
	}
	wsConn.SetReadLimit(maxAppServerLineBytes)

	var closeOnce sync.Once
	shutdown := func() {
		closeOnce.Do(func() {
			cancel()
			if stdio.Close != nil {
				_ = stdio.Close()
			}
			_ = wsConn.Close(websocket.StatusNormalClosure, "")
		})
	}
	defer shutdown()

	tracker := NewResponseContextTracker()
	var wg sync.WaitGroup

	// stderr 调试日志泵
	if stdio.Stderr != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			reader := bufio.NewReaderSize(stdio.Stderr, 16*1024)
			for {
				line, readErr := reader.ReadString('\n')
				if h.logDebug != nil {
					if trimmed := strings.TrimSpace(line); trimmed != "" {
						h.logDebug(trimmed)
					}
				}
				if readErr != nil {
					return
				}
			}
		}()
	}

	// stdout -> WebSocket 泵（打补丁后下发给客户端，支持 \r\n 与超长 JSON-RPC 帧）
	if stdio.Stdout != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer shutdown()
			reader := bufio.NewReaderSize(stdio.Stdout, 64*1024)
			for {
				rawLine, readErr := reader.ReadBytes('\n')
				if readErr != nil {
					if !errors.Is(readErr, io.EOF) && h.logError != nil && ctx.Err() == nil {
						h.logError(readErr)
					}
					return
				}
				line := bytes.TrimSuffix(rawLine, []byte("\n"))
				line = bytes.TrimSuffix(line, []byte("\r"))
				if len(line) == 0 {
					continue
				}
				patched := tracker.PatchThreadResumeResponse(line)
				writeCtx, writeCancel := context.WithTimeout(ctx, 15*time.Second)
				writeErr := wsConn.Write(writeCtx, websocket.MessageText, patched)
				writeCancel()
				if writeErr != nil {
					return
				}
			}
		}()
	}

	// 子进程退出监控
	if stdio.Wait != nil {
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer shutdown()
			_ = stdio.Wait()
		}()
	}

	// WebSocket -> stdin 泵（消息重写与请求跟踪）
	var stdinMu sync.Mutex
	for {
		_, data, readErr := wsConn.Read(ctx)
		if readErr != nil {
			break
		}
		rewritten := RewriteClientMessage(data, injectedCwd)
		tracker.RememberThreadResumeRequest(rewritten)
		frame := make([]byte, len(rewritten)+1)
		copy(frame, rewritten)
		frame[len(rewritten)] = '\n'
		stdinMu.Lock()
		_, writeErr := stdio.Stdin.Write(frame)
		stdinMu.Unlock()
		if writeErr != nil {
			if h.logError != nil && ctx.Err() == nil {
				h.logError(writeErr)
			}
			break
		}
	}

	shutdown()
	wg.Wait()
}
