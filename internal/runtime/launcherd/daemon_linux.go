//go:build linux

package launcherd

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/application/launcher"
)

var restartBackoffs = []time.Duration{
	1 * time.Second,
	5 * time.Second,
	15 * time.Second,
	30 * time.Second,
}

const (
	healthyRunResetWindow = 15 * time.Second
	gracefulShutdownWait  = 2 * time.Second
	maxStdioLineBytes     = 1024 * 1024
)

// HasDesktopSession reports whether a Linux graphical session (X11 or Wayland) is present.
func HasDesktopSession() bool {
	return strings.TrimSpace(os.Getenv("DISPLAY")) != "" ||
		strings.TrimSpace(os.Getenv("WAYLAND_DISPLAY")) != ""
}

// DesktopAvailable reports whether the current host has a desktop session eligible
// for AIH Launch assembly. On Linux this requires DISPLAY or WAYLAND_DISPLAY.
func DesktopAvailable() bool {
	return HasDesktopSession()
}

// WithShutdownSignals wraps ctx to cancel on SIGINT or SIGTERM.
func WithShutdownSignals(ctx context.Context) (context.Context, context.CancelFunc) {
	return signal.NotifyContext(ctx, os.Interrupt, syscall.SIGTERM)
}

// StartDetached pre-builds the GTK4 UI binary and spawns `<exePath> launch ui`
// detached in a new session, logging output to <aiHomeDir>/run/launcher/linux/daemon.log.
func StartDetached(ctx context.Context, exePath string, aiHomeDir string, socketPath string) (int, string, error) {
	if !HasDesktopSession() {
		return 0, "", fmt.Errorf("%w: 未检测到 Linux 桌面会话（DISPLAY 和 WAYLAND_DISPLAY 均为空）", launcher.ErrUnsupported)
	}
	if _, err := Build(ctx, aiHomeDir); err != nil {
		return 0, "", err
	}
	bin := strings.TrimSpace(exePath)
	if bin == "" {
		resolved, err := os.Executable()
		if err != nil {
			return 0, "", fmt.Errorf("无法定位当前 aih 可执行文件: %w", err)
		}
		bin = resolved
	}
	sock := strings.TrimSpace(socketPath)
	if sock == "" {
		sock = DefaultSocketPath()
	}

	logDir := filepath.Join(aiHomeDir, "run", "launcher", "linux")
	if err := os.MkdirAll(logDir, 0o700); err != nil {
		return 0, "", fmt.Errorf("创建启动器日志目录失败: %w", err)
	}
	logPath := filepath.Join(logDir, "daemon.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return 0, "", fmt.Errorf("打开启动器日志文件 %s 失败: %w", logPath, err)
	}
	defer func() { _ = logFile.Close() }()

	cmd := exec.Command(bin, "launch", "ui")
	cmd.Env = replaceEnvVar(os.Environ(), EnvSocketPath, sock)
	cmd.Stdin = nil
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return 0, "", fmt.Errorf("后台启动 %s launch ui 失败: %w", bin, err)
	}
	pid := cmd.Process.Pid
	_ = cmd.Process.Release()

	// Briefly wait for control socket readiness so callers know startup succeeded.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if ProbeSocket(ctx, sock) {
			break
		}
		select {
		case <-ctx.Done():
			return pid, logPath, nil
		case <-time.After(100 * time.Millisecond):
		}
	}
	return pid, logPath, nil
}

// Daemon supervises the embedded Linux GTK4 launcher UI process.
type Daemon struct {
	aiHomeDir  string
	socketPath string
	service    *launcher.Service
	logOutput  io.Writer

	mu       sync.Mutex
	status   Status
	started  bool
	closed   bool
	cancel   context.CancelFunc
	doneCh   chan struct{}
	childCmd *exec.Cmd
	childIn  io.WriteCloser
	writeMu  sync.Mutex
}

// New creates a Linux desktop launcher supervisor.
func New(opts Options) (*Daemon, error) {
	if opts.Service == nil {
		return nil, errors.New("launcherd_service_required")
	}
	home := strings.TrimSpace(opts.AIHomeDir)
	if home == "" {
		return nil, errors.New("launcherd_home_required")
	}
	sock := strings.TrimSpace(opts.SocketPath)
	if sock == "" {
		sock = DefaultSocketPath()
	}
	return &Daemon{
		aiHomeDir:  home,
		socketPath: sock,
		service:    opts.Service,
		logOutput:  opts.LogOutput,
		status: Status{
			Supported: HasDesktopSession(),
			Autostart: AutostartEnabled(),
		},
	}, nil
}

// SocketPath returns the Unix control socket path used by this daemon.
func (d *Daemon) SocketPath() string {
	if d == nil {
		return DefaultSocketPath()
	}
	return d.socketPath
}

// Start launches the GTK4 supervisor asynchronously (non-blocking for Server startup).
// On headless Linux (no DISPLAY/WAYLAND_DISPLAY), Start records supported=false and returns nil.
func (d *Daemon) Start(ctx context.Context) error {
	if d == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if !HasDesktopSession() {
		d.mu.Lock()
		d.status.Supported = false
		d.status.PID = 0
		d.mu.Unlock()
		return nil
	}

	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return errors.New("launcherd_closed")
	}
	if d.started {
		d.mu.Unlock()
		return nil
	}
	runCtx, cancel := context.WithCancel(ctx)
	doneCh := make(chan struct{})
	d.started = true
	d.status.Supported = true
	d.cancel = cancel
	d.doneCh = doneCh
	d.mu.Unlock()

	go func() {
		defer close(doneCh)
		binPath, err := Build(runCtx, d.aiHomeDir)
		if err != nil {
			d.setBuildError(err)
			d.logf("[aih launch] %v\n", err)
			return
		}
		d.setBuilt(binPath)
		d.superviseLoop(runCtx, binPath)
	}()
	return nil
}

// Run builds the GTK4 UI synchronously and runs the supervisor loop in the foreground
// until ctx is canceled or the UI requests quit.
func (d *Daemon) Run(ctx context.Context) error {
	if d == nil {
		return errors.New("launcherd_nil")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if !HasDesktopSession() {
		return fmt.Errorf("%w: 未检测到 Linux 桌面会话（DISPLAY 和 WAYLAND_DISPLAY 均为空）", launcher.ErrUnsupported)
	}

	binPath, err := Build(ctx, d.aiHomeDir)
	if err != nil {
		d.setBuildError(err)
		return err
	}
	d.setBuilt(binPath)
	d.logf("[aih launch] ui binary: %s\n", binPath)
	d.logf("[aih launch] control socket: %s\n", d.socketPath)

	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return errors.New("launcherd_closed")
	}
	runCtx, cancel := context.WithCancel(ctx)
	doneCh := make(chan struct{})
	d.started = true
	d.status.Supported = true
	d.cancel = cancel
	d.doneCh = doneCh
	d.mu.Unlock()

	defer close(doneCh)
	d.superviseLoop(runCtx, binPath)
	return nil
}

// Show asks the running GTK panel to show itself over the control Unix socket.
func (d *Daemon) Show(ctx context.Context) error {
	if d == nil {
		return launcher.ErrUnsupported
	}
	st := d.Status()
	if !st.Supported {
		return fmt.Errorf("%w: 当前 Linux 环境无桌面会话", launcher.ErrUnsupported)
	}
	if !st.Built && st.DesktopError != "" {
		return fmt.Errorf("%w: %s", launcher.ErrUnsupported, st.DesktopError)
	}
	return SendCommand(ctx, d.socketPath, "show")
}

// Toggle toggles the running GTK panel over the control Unix socket.
func (d *Daemon) Toggle(ctx context.Context) error {
	if d == nil {
		return launcher.ErrUnsupported
	}
	return SendCommand(ctx, d.socketPath, "toggle")
}

// Hide hides the running GTK panel over the control Unix socket.
func (d *Daemon) Hide(ctx context.Context) error {
	if d == nil {
		return launcher.ErrUnsupported
	}
	return SendCommand(ctx, d.socketPath, "hide")
}

// Status returns a snapshot of the supervisor and GTK panel runtime state.
func (d *Daemon) Status() Status {
	if d == nil {
		return Status{}
	}
	d.mu.Lock()
	st := d.status
	d.mu.Unlock()
	st.Autostart = AutostartEnabled()
	return st
}

// Close gracefully asks the GTK child to quit and terminates supervision.
func (d *Daemon) Close() error {
	if d == nil {
		return nil
	}
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return nil
	}
	d.closed = true
	cancel := d.cancel
	doneCh := d.doneCh
	cmd := d.childCmd
	d.mu.Unlock()

	// Ask GTK child to exit cleanly first so it can ungrab X11 keys and unlink socket.
	_ = d.writeChildLine("quit")

	if cancel != nil {
		cancel()
	}
	if doneCh != nil {
		select {
		case <-doneCh:
		case <-time.After(gracefulShutdownWait):
			if cmd != nil && cmd.Process != nil {
				_ = cmd.Process.Signal(syscall.SIGKILL)
			}
			select {
			case <-doneCh:
			case <-time.After(500 * time.Millisecond):
			}
		}
	}
	return nil
}

func (d *Daemon) superviseLoop(ctx context.Context, binPath string) {
	backoffIdx := 0
	for {
		if ctx.Err() != nil {
			return
		}
		startTime := time.Now()
		quitRequested, runErr := d.runChildOnce(ctx, binPath)
		if quitRequested || ctx.Err() != nil {
			return
		}
		if time.Since(startTime) >= healthyRunResetWindow {
			backoffIdx = 0
		}
		wait := restartBackoffs[backoffIdx]
		if backoffIdx+1 < len(restartBackoffs) {
			backoffIdx++
		}
		if runErr != nil {
			d.setDesktopError(fmt.Sprintf("GTK 面板退出（%v），%s 后重试", runErr, wait))
			d.logf("[aih launch] child exited: %v; restarting in %s\n", runErr, wait)
		} else {
			d.logf("[aih launch] child exited; restarting in %s\n", wait)
		}

		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}

func (d *Daemon) runChildOnce(ctx context.Context, binPath string) (bool, error) {
	cmd := exec.Command(binPath)
	cmd.Env = buildChildEnv(d.socketPath)

	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		return false, fmt.Errorf("create stdin pipe: %w", err)
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdinPipe.Close()
		return false, fmt.Errorf("create stdout pipe: %w", err)
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		_ = stdinPipe.Close()
		_ = stdoutPipe.Close()
		return false, fmt.Errorf("create stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		_ = stdinPipe.Close()
		return false, fmt.Errorf("start %s: %w", binPath, err)
	}

	d.mu.Lock()
	d.childCmd = cmd
	d.childIn = stdinPipe
	d.status.PID = cmd.Process.Pid
	d.mu.Unlock()

	defer func() {
		d.mu.Lock()
		if d.childCmd == cmd {
			d.childCmd = nil
			d.childIn = nil
			d.status.PID = 0
		}
		d.mu.Unlock()
		_ = stdinPipe.Close()
	}()

	// Stop child gracefully when ctx is canceled.
	stopWatchDone := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = d.writeChildLine("quit")
			_ = stdinPipe.Close()
			if cmd.Process != nil {
				_ = cmd.Process.Signal(syscall.SIGTERM)
			}
		case <-stopWatchDone:
		}
	}()
	defer close(stopWatchDone)

	// Drain stderr and keep the last meaningful line in case the process crashes.
	var lastStderrMu sync.Mutex
	lastStderr := ""
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		scanner := bufio.NewScanner(stderrPipe)
		scanner.Buffer(make([]byte, 4096), 64*1024)
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line != "" {
				lastStderrMu.Lock()
				lastStderr = line
				lastStderrMu.Unlock()
			}
		}
	}()

	quitRequested := d.readChildStdout(ctx, stdoutPipe)

	waitErr := cmd.Wait()
	<-stderrDone
	if quitRequested || ctx.Err() != nil {
		return quitRequested, nil
	}
	if waitErr != nil {
		lastStderrMu.Lock()
		detail := lastStderr
		lastStderrMu.Unlock()
		if detail != "" {
			return false, fmt.Errorf("%w (%s)", waitErr, detail)
		}
		return false, waitErr
	}
	return false, nil
}

func (d *Daemon) readChildStdout(ctx context.Context, stdout io.Reader) bool {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), maxStdioLineBytes)

	var openWG sync.WaitGroup
	defer openWG.Wait()

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		switch {
		case line == "refresh":
			d.handleRefresh(ctx)
		case strings.HasPrefix(line, "open\t"):
			appID := strings.TrimSpace(strings.TrimPrefix(line, "open\t"))
			if appID == "" {
				continue
			}
			openWG.Add(1)
			go func(id string) {
				defer openWG.Done()
				d.handleOpen(ctx, id)
			}(appID)
		case line == "hide":
			// No-op acknowledgment from GTK panel.
		case strings.HasPrefix(line, "status\t"):
			rawB64 := strings.TrimPrefix(line, "status\t")
			msg, err := decodeBase64(rawB64)
			if err != nil {
				continue
			}
			msg = strings.TrimSpace(msg)
			d.setDesktopError(msg)
			if msg != "" {
				d.logf("[aih launch] status: %s\n", msg)
			}
		case line == "quit":
			return true
		}
	}
	return false
}

func (d *Daemon) handleRefresh(ctx context.Context) {
	result, err := d.service.List(ctx, launcher.ListOptions{})
	if err != nil {
		d.logf("[aih launch] refresh catalog failed: %v\n", err)
		_ = d.writeChildLine("END")
		return
	}
	var b strings.Builder
	for _, app := range result.Apps {
		b.WriteString(FormatWireApp(app))
		b.WriteByte('\n')
	}
	b.WriteString("END\n")
	_ = d.writeChildRaw(b.String())
}

func (d *Daemon) handleOpen(ctx context.Context, appID string) {
	if _, err := d.service.Open(ctx, appID); err != nil {
		d.logf("[aih launch] open %s failed: %v\n", appID, err)
		_ = d.writeChildLine("open-error\t" + encodeBase64(err.Error()))
		return
	}
	_ = d.writeChildLine("open-ok\t" + encodeBase64(appID))
}

func (d *Daemon) writeChildLine(line string) error {
	return d.writeChildRaw(line + "\n")
}

func (d *Daemon) writeChildRaw(payload string) error {
	d.mu.Lock()
	in := d.childIn
	d.mu.Unlock()
	if in == nil {
		return errors.New("child_stdin_closed")
	}
	d.writeMu.Lock()
	defer d.writeMu.Unlock()
	_, err := io.WriteString(in, payload)
	return err
}

func (d *Daemon) setBuilt(binPath string) {
	d.mu.Lock()
	d.status.Built = true
	d.status.BinaryPath = binPath
	d.status.DesktopError = ""
	d.mu.Unlock()
}

func (d *Daemon) setBuildError(err error) {
	d.mu.Lock()
	d.status.Built = false
	d.status.DesktopError = err.Error()
	d.mu.Unlock()
}

func (d *Daemon) setDesktopError(msg string) {
	d.mu.Lock()
	d.status.DesktopError = msg
	d.mu.Unlock()
}

func (d *Daemon) logf(format string, args ...any) {
	if d.logOutput == nil {
		return
	}
	_, _ = fmt.Fprintf(d.logOutput, format, args...)
}

func buildChildEnv(socketPath string) []string {
	base := os.Environ()
	out := make([]string, 0, len(base)+2)
	for _, entry := range base {
		if strings.HasPrefix(entry, EnvLauncherMarker+"=") || strings.HasPrefix(entry, EnvSocketPath+"=") {
			continue
		}
		out = append(out, entry)
	}
	out = append(out, EnvLauncherMarker+"=1", EnvSocketPath+"="+socketPath)
	return out
}
