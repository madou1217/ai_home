// Package proxyserve 管理 Server 主机上的本地代理入口子进程。
//
// 它只启动 aih-go 的 `proxy serve --json` 子进程并读取入口信息；
// 健康、续期、系统代理与 TUN 仍由该 CLI 负责。权限动作（system/TUN）
// 不在这里隐式提权，避免 WebUI 管理面绕过操作系统权限提示。
package proxyserve

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	ErrAlreadyRunning  = errors.New("proxy_serve_already_running")
	ErrCLINotFound     = errors.New("proxy_serve_cli_not_found")
	ErrStartFailed     = errors.New("proxy_serve_start_failed")
	ErrStartTimeout    = errors.New("proxy_serve_start_timeout")
	ErrServerURL       = errors.New("proxy_serve_server_url_missing")
	ErrSelectorInvalid = errors.New("proxy_serve_selector_invalid")
	ErrPeerInvalid     = errors.New("proxy_serve_peer_invalid")
)

// Request 是本地入口的启动参数。
type Request struct {
	Selector string `json:"selector"`
	NoSocks  bool   `json:"noSocks,omitempty"`
	// HTTPPort / SocksPort 是入口端口；0 表示随机。默认在 CLI 层为 6152/6153。
	HTTPPort  int `json:"httpPort,omitempty"`
	SocksPort int `json:"socksPort,omitempty"`
	// Anonymous 允许 loopback 客户端不带代理凭据；nil 使用默认（匿名）。
	Anonymous *bool `json:"anonymous,omitempty"`
	// Peer 非空时通过已保存的 SSH 连接借用远端 AIH 的入口；PeerVia 是可选跳板。
	// PeerAIH 可指定远端可执行文件，空值由远端 CLI 自动探测。
	Peer    string `json:"peer,omitempty"`
	PeerVia string `json:"peerVia,omitempty"`
	PeerAIH string `json:"peerAih,omitempty"`
}

// PathEvidence 是对等链路的脱敏路径证据。
// Mode 取值与 network.connector 的 direct-p2p / peer-relay 语义一致。
type PathEvidence struct {
	Mode       string `json:"mode,omitempty"`
	Confidence string `json:"confidence,omitempty"`
	Source     string `json:"source,omitempty"`
	Path       string `json:"path,omitempty"`
	Transport  string `json:"transport,omitempty"`
}

// View 是 WebUI 可见的入口状态；URL 含租约令牌，只返回给管理面。
type View struct {
	Running   bool   `json:"running"`
	PID       int    `json:"pid,omitempty"`
	Selector  string `json:"selector,omitempty"`
	Name      string `json:"name,omitempty"`
	HTTPURL   string `json:"httpUrl,omitempty"`
	SOCKS5URL string `json:"socks5Url,omitempty"`
	StartedAt int64  `json:"startedAt,omitempty"`
	Error     string `json:"error,omitempty"`
	// Transport 为 server（本机管理面）或 ssh-peer（经 SSH 借用远端入口）。
	Transport string `json:"transport,omitempty"`
	Peer      string `json:"peer,omitempty"`
	PeerVia   string `json:"via,omitempty"`
	// Path 只在对等模式下出现；本机管理面模式不虚构 P2P 路径。
	Path *PathEvidence `json:"path,omitempty"`
}

type session struct {
	cmd      *exec.Cmd
	view     View
	exited   chan struct{}
	waitErr  error
	stopping bool
	stopOnce sync.Once
}

// Manager 在任意时刻只允许一个本地入口，避免端口/租约/系统代理互相竞争。
type Manager struct {
	mu            sync.Mutex
	aiHomeDir     string
	serverURL     string
	managementKey func() string
	cliPath       string
	starting      bool
	current       *session
	last          View
}

// Options 构造 Manager。
type Options struct {
	AIHomeDir     string
	ServerURL     string
	ManagementKey func() string
	CLIPath       string
}

func NewManager(options Options) *Manager {
	return &Manager{
		aiHomeDir:     strings.TrimSpace(options.AIHomeDir),
		serverURL:     NormalizeServerURL(options.ServerURL),
		managementKey: options.ManagementKey,
		cliPath:       strings.TrimSpace(options.CLIPath),
	}
}

// NormalizeServerURL 把管理面地址修成子进程可拨号的形式。
//
// Server 可能监听 0.0.0.0/::；这些地址不是合法的客户端目标，本机入口
// 必须改拨回环地址。其它主机名/IP 原样保留。
func NormalizeServerURL(raw string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Host == "" {
		return trimmed
	}
	host := parsed.Hostname()
	if host == "" {
		return trimmed
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsUnspecified() {
		port := parsed.Port()
		if port == "" {
			parsed.Host = "127.0.0.1"
		} else {
			parsed.Host = net.JoinHostPort("127.0.0.1", port)
		}
	}
	return strings.TrimRight(parsed.String(), "/")
}

// View 返回当前或最近一次入口状态。
func (manager *Manager) View() View {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if manager.current != nil {
		return manager.current.view
	}
	return manager.last
}

// LocateCLI 返回与 Server 同目录的 aih-go；找不到时返回 ErrCLINotFound。
func LocateCLI() (string, error) {
	executable, err := os.Executable()
	if err == nil {
		dir := filepath.Dir(executable)
		for _, name := range []string{"aih-go", "aih-go.exe", "aih"} {
			candidate := filepath.Join(dir, name)
			if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
				return candidate, nil
			}
		}
	}
	for _, name := range []string{"aih-go", "aih"} {
		if resolved, lookErr := exec.LookPath(name); lookErr == nil {
			return resolved, nil
		}
	}
	return "", ErrCLINotFound
}

// Start 启动 `aih-go proxy serve --json` 并等待入口信息。
func (manager *Manager) Start(ctx context.Context, request Request) (View, error) {
	manager.mu.Lock()
	if manager.current != nil || manager.starting {
		manager.mu.Unlock()
		return View{}, ErrAlreadyRunning
	}
	selector := strings.TrimSpace(request.Selector)
	if selector == "" || strings.ContainsAny(selector, "\r\n\x00") {
		manager.mu.Unlock()
		return View{}, ErrSelectorInvalid
	}
	peer := strings.TrimSpace(request.Peer)
	peerVia := strings.TrimSpace(request.PeerVia)
	peerAIH := strings.TrimSpace(request.PeerAIH)
	if !validPeerField(peer, 256) || !validPeerField(peerVia, 256) || !validPeerField(peerAIH, 512) {
		manager.mu.Unlock()
		return View{}, ErrPeerInvalid
	}
	if peer == "" && (peerVia != "" || peerAIH != "") {
		manager.mu.Unlock()
		return View{}, ErrPeerInvalid
	}
	if peer == "" && manager.serverURL == "" {
		manager.mu.Unlock()
		return View{}, ErrServerURL
	}
	manager.starting = true
	cliPath := manager.cliPath
	manager.mu.Unlock()

	finishStart := func() {
		manager.mu.Lock()
		manager.starting = false
		manager.mu.Unlock()
	}
	if cliPath == "" {
		resolved, err := LocateCLI()
		if err != nil {
			finishStart()
			return View{}, err
		}
		cliPath = resolved
	}
	args := []string{"proxy", "serve", "--json", "--selector", selector}
	transport := "server"
	if peer != "" {
		transport = "ssh-peer"
		args = append(args, "--peer", peer)
		if peerVia != "" {
			args = append(args, "--peer-via", peerVia)
		}
		if peerAIH != "" {
			args = append(args, "--peer-aih", peerAIH)
		}
	} else {
		args = append(args, "--server", manager.serverURL)
	}
	if request.NoSocks {
		args = append(args, "--no-socks")
	}
	if request.HTTPPort > 0 {
		args = append(args, "--http-port", strconv.Itoa(request.HTTPPort))
	}
	if request.SocksPort > 0 {
		args = append(args, "--socks-port", strconv.Itoa(request.SocksPort))
	}
	if request.Anonymous != nil && !*request.Anonymous {
		args = append(args, "--anonymous=false")
	}
	command := exec.Command(cliPath, args...)
	managementKey := ""
	if manager.managementKey != nil {
		managementKey = strings.TrimSpace(manager.managementKey())
	}
	overrides := map[string]string{"AIH_HOME_DIR": manager.aiHomeDir}
	if managementKey != "" {
		overrides["AIH_SERVER_MANAGEMENT_KEY"] = managementKey
	}
	command.Env = envWithOverrides(overrides)
	stdout, err := command.StdoutPipe()
	if err != nil {
		finishStart()
		return View{}, fmt.Errorf("%w: stdout pipe", ErrStartFailed)
	}
	// JSON 模式不再往 stderr 输出正常信息；失败时只保留末尾诊断，启动错误才有可读原因。
	diagnostics := &tailBuffer{limit: 4096}
	command.Stderr = diagnostics
	if err := command.Start(); err != nil {
		finishStart()
		return View{}, fmt.Errorf("%w: %v", ErrStartFailed, err)
	}
	ready := make(chan readyResult, 1)
	go readReady(stdout, ready)
	manager.mu.Lock()
	current := &session{
		cmd: command,
		view: View{
			Running:   true,
			PID:       command.Process.Pid,
			Selector:  selector,
			StartedAt: time.Now().UnixMilli(),
			Transport: transport,
			Peer:      peer,
			PeerVia:   peerVia,
		},
		exited: make(chan struct{}),
	}
	manager.current = current
	manager.starting = false
	manager.mu.Unlock()
	go func() {
		current.waitErr = command.Wait()
		close(current.exited)
		manager.mu.Lock()
		if manager.current == current {
			manager.current = nil
			if current.waitErr != nil && !current.stopping && current.view.Error == "" {
				current.view.Error = "proxy_serve_cli_exited"
			}
			current.view.Running = false
			// 入口已停止：本机监听已关闭，清掉带租约令牌的 URL，避免在管理面残留无效凭据。
			current.view.HTTPURL = ""
			current.view.SOCKS5URL = ""
			manager.last = current.view
		}
		manager.mu.Unlock()
	}()

	select {
	case result := <-ready:
		if result.err != nil {
			_ = manager.Stop(context.Background())
			return View{}, startFailure(result.err, diagnostics.String(), managementKey)
		}
		manager.mu.Lock()
		current.view.Name = result.view.Name
		current.view.HTTPURL = result.view.HTTPURL
		current.view.SOCKS5URL = result.view.SOCKS5URL
		if result.view.Path != nil {
			current.view.Path = result.view.Path
		}
		view := current.view
		manager.mu.Unlock()
		return view, nil
	case <-current.exited:
		manager.mu.Lock()
		view := current.view
		manager.mu.Unlock()
		if view.Error == "" {
			view.Error = "proxy_serve_cli_exited"
		}
		return View{}, startFailure(fmt.Errorf("%w: %s", ErrStartFailed, view.Error), diagnostics.String(), managementKey)
	case <-time.After(30 * time.Second):
		_ = manager.Stop(context.Background())
		return View{}, ErrStartTimeout
	case <-ctx.Done():
		_ = manager.Stop(context.Background())
		return View{}, ctx.Err()
	}
}

// Stop 停止当前子进程并等待退出；幂等。
func (manager *Manager) Stop(ctx context.Context) error {
	manager.mu.Lock()
	current := manager.current
	if current != nil {
		current.stopping = true
	}
	manager.mu.Unlock()
	if current == nil {
		return nil
	}
	current.stopOnce.Do(func() {
		// Windows 不支持 os.Interrupt；Signal 返回错误时直接 Kill。
		if err := current.cmd.Process.Signal(os.Interrupt); err != nil {
			_ = current.cmd.Process.Kill()
		}
		select {
		case <-current.exited:
		case <-time.After(5 * time.Second):
			_ = current.cmd.Process.Kill()
		case <-ctx.Done():
			_ = current.cmd.Process.Kill()
		}
	})
	select {
	case <-current.exited:
		return nil
	case <-time.After(2 * time.Second):
		return errors.New("proxy_serve_stop_timeout")
	}
}

// Close 停止入口；供 Server 关闭时调用。
func (manager *Manager) Close() error { return manager.Stop(context.Background()) }

// envWithOverrides 先删掉同名旧值再追加，避免子进程读到继承的环境变量而不是本次覆盖。
func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func validPeerField(value string, max int) bool {
	return len(value) <= max && !strings.HasPrefix(value, "-") && !strings.ContainsAny(value, "\r\n\x00")
}

func envWithOverrides(overrides map[string]string) []string {
	environ := os.Environ()
	env := make([]string, 0, len(environ)+len(overrides))
	for _, entry := range environ {
		key, _, _ := strings.Cut(entry, "=")
		if _, replaced := overrides[key]; replaced {
			continue
		}
		env = append(env, entry)
	}
	for key, value := range overrides {
		env = append(env, key+"="+value)
	}
	return env
}

// startFailure 优先用子进程的最后一行诊断替换通用退出码，便于 WebUI 直接显示原因。
func startFailure(base error, diagnostics, managementKey string) error {
	if !errors.Is(base, ErrStartFailed) {
		return base
	}
	reason := sanitizeDiagnostic(diagnostics, managementKey)
	if reason == "" {
		return base
	}
	return fmt.Errorf("%w: %s", ErrStartFailed, reason)
}

var urlUserinfoPattern = regexp.MustCompile(`://[^/\s@]+@`)

func sanitizeDiagnostic(raw, managementKey string) string {
	lines := strings.Split(strings.TrimSpace(raw), "\n")
	reason := ""
	for index := len(lines) - 1; index >= 0; index-- {
		if line := strings.TrimSpace(lines[index]); line != "" {
			reason = line
			break
		}
	}
	if reason == "" {
		return ""
	}
	if managementKey != "" {
		reason = strings.ReplaceAll(reason, managementKey, "***")
	}
	reason = urlUserinfoPattern.ReplaceAllString(reason, "://***@")
	if len(reason) > 400 {
		reason = reason[:400] + "…"
	}
	return reason
}

// tailBuffer 只保留最近 limit 字节，避免子进程 stderr 无限增长。
type tailBuffer struct {
	mu     sync.Mutex
	buffer bytes.Buffer
	limit  int
}

func (tail *tailBuffer) Write(data []byte) (int, error) {
	if tail == nil {
		return len(data), nil
	}
	tail.mu.Lock()
	defer tail.mu.Unlock()
	_, _ = tail.buffer.Write(data)
	if tail.limit > 0 && tail.buffer.Len() > tail.limit {
		raw := tail.buffer.Bytes()
		kept := append([]byte(nil), raw[len(raw)-tail.limit:]...)
		tail.buffer.Reset()
		_, _ = tail.buffer.Write(kept)
	}
	return len(data), nil
}

func (tail *tailBuffer) String() string {
	if tail == nil {
		return ""
	}
	tail.mu.Lock()
	defer tail.mu.Unlock()
	return tail.buffer.String()
}

type readyResult struct {
	view View
	err  error
}

// readReady 读取首行 JSON 入口信息后继续耗尽 stdout，避免子进程阻塞。
func readReady(stdout io.Reader, ready chan<- readyResult) {
	decoder := json.NewDecoder(stdout)
	var payload struct {
		OK             bool          `json:"ok"`
		HTTPURL        string        `json:"httpUrl"`
		SOCKS5URL      string        `json:"socks5Url"`
		Name           string        `json:"name"`
		Error          string        `json:"error"`
		PathMode       string        `json:"pathMode"`
		PathConfidence string        `json:"pathConfidence"`
		PathEvidence   *PathEvidence `json:"pathEvidence"`
	}
	sent := false
	for {
		if err := decoder.Decode(&payload); err != nil {
			if !sent {
				ready <- readyResult{err: ErrStartFailed}
			}
			return
		}
		if sent {
			continue
		}
		sent = true
		if !payload.OK {
			message := strings.TrimSpace(payload.Error)
			if message == "" {
				message = "cli_reported_failure"
			}
			ready <- readyResult{err: fmt.Errorf("%w: %s", ErrStartFailed, message)}
			continue
		}
		view := View{HTTPURL: payload.HTTPURL, SOCKS5URL: payload.SOCKS5URL, Name: payload.Name}
		if payload.PathMode != "" {
			path := &PathEvidence{Mode: payload.PathMode, Confidence: payload.PathConfidence}
			if payload.PathEvidence != nil {
				path.Mode = firstNonEmpty(payload.PathEvidence.Mode, path.Mode)
				path.Confidence = firstNonEmpty(payload.PathEvidence.Confidence, path.Confidence)
				path.Source = payload.PathEvidence.Source
				path.Path = payload.PathEvidence.Path
				path.Transport = payload.PathEvidence.Transport
			}
			view.Path = path
		}
		ready <- readyResult{view: view}
	}
}
