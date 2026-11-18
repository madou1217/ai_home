package codexappserverws

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/codexpreferences"
	"github.com/madou1217/ai_home/internal/runtime/providercli"
)

const (
	// childKillGracePeriod 是关闭阶段从 SIGTERM 升级到 SIGKILL 的等待时长，与 Node 代理保持 500ms 一致。
	childKillGracePeriod = 500 * time.Millisecond
)

var (
	// ErrInvalidBinary 表示无法解析有效的 codex 可执行文件。
	ErrInvalidBinary = errors.New("Codex 可执行文件不可用")
	// ErrEmptyCommand 表示启动子进程时未提供可执行命令路径。
	ErrEmptyCommand = errors.New("Codex 启动命令为空")
)

// ResolveCodexBinary 与所有 Codex CLI 启动路径共用官方 CLI 解析策略。
func ResolveCodexBinary(hostHomeDir string) (string, error) {
	return providercli.ResolveCodexBinary(hostHomeDir)
}

// StartProcessOptions 配置 Codex app-server 子进程启动参数。
type StartProcessOptions struct {
	Dir             string
	WindowsVerbatim bool
	Command         string
	Args            []string
	Env             []string
}

// AppServerProcess 封装基于独立 os.Pipe 管理的 codex app-server --listen stdio:// 子进程，
// 避免 exec.Cmd.Wait 与 stdout/stderr 读取并发冲突，并提供进程组级优雅退场与兜底强杀。
type AppServerProcess struct {
	cmd    *exec.Cmd
	stdin  *os.File
	stdout *os.File
	stderr *os.File

	done      chan struct{}
	closeOnce sync.Once
	groupOnce sync.Once

	waitMu  sync.Mutex
	waitErr error

	pipeMu  sync.Mutex
	pipeErr error
}

// preparedAppServerProcess owns the same command and six pipe handles before
// Start. Both the existing WebSocket launcher and the private stdio runner use
// this owner; preparation never starts a process or a Wait goroutine.
type preparedAppServerProcess struct {
	mu          sync.Mutex
	process     *AppServerProcess
	childEnds   [3]*os.File
	started     bool
	aborted     bool
	checkedOnce sync.Once
	checkedErr  error
}

var errPreparedAppServerState = errors.New("codex_app_server_prepared_state_invalid")

// StartAppServerProcess retains the existing WebSocket/default launch contract.
func StartAppServerProcess(opts StartProcessOptions) (*AppServerProcess, error) {
	prepared, err := prepareAppServerProcess(opts)
	if err != nil {
		return nil, err
	}
	return prepared.start()
}

func prepareAppServerProcess(opts StartProcessOptions) (*preparedAppServerProcess, error) {
	command := strings.TrimSpace(opts.Command)
	if command == "" {
		return nil, ErrEmptyCommand
	}
	args := opts.Args
	if len(args) == 0 {
		args = []string{"app-server", "--listen", "stdio://"}
	}

	for _, entry := range opts.Env {
		if home, ok := strings.CutPrefix(entry, "CODEX_HOME="); ok {
			if err := codexpreferences.CheckHostReady(home); err != nil {
				return nil, err
			}
			// An explicit CODEX_HOME must exist before the official app-server
			// starts. Fresh installs have no native config or credentials yet;
			// create only the directory, after the interrupted-default guard.
			if home != "" {
				if err := os.MkdirAll(home, 0o700); err != nil {
					return nil, fmt.Errorf("初始化 Codex 运行目录失败: %w", err)
				}
			}
			break
		}
	}
	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		_ = stdinR.Close()
		_ = stdinW.Close()
		return nil, err
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		_ = stdinR.Close()
		_ = stdinW.Close()
		_ = stdoutR.Close()
		_ = stdoutW.Close()
		return nil, err
	}

	cmd := exec.Command(command, args...)
	cmd.Dir = opts.Dir
	cmd.Env = opts.Env
	cmd.Stdin = stdinR
	cmd.Stdout = stdoutW
	cmd.Stderr = stderrW
	configureDetachedProcess(cmd)
	configureVerbatimArguments(cmd, args, opts.WindowsVerbatim)

	proc := &AppServerProcess{
		cmd: cmd, stdin: stdinW, stdout: stdoutR, stderr: stderrR,
		done: make(chan struct{}),
	}
	return &preparedAppServerProcess{
		process: proc, childEnds: [3]*os.File{stdinR, stdoutW, stderrW},
	}, nil
}

func (prepared *preparedAppServerProcess) readyLocked() error {
	if prepared.started || prepared.aborted || prepared.process == nil {
		return errPreparedAppServerState
	}
	p := prepared.process
	if p.cmd == nil || p.cmd.Process != nil || p.cmd.Stdin != prepared.childEnds[0] || p.cmd.Stdout != prepared.childEnds[1] || p.cmd.Stderr != prepared.childEnds[2] {
		return errPreparedAppServerState
	}
	for _, file := range []*os.File{p.stdin, p.stdout, p.stderr, prepared.childEnds[0], prepared.childEnds[1], prepared.childEnds[2]} {
		if file == nil {
			return errPreparedAppServerState
		}
		info, err := file.Stat()
		if err != nil || info.Mode()&os.ModeNamedPipe == 0 {
			return errPreparedAppServerState
		}
	}
	return nil
}

func (prepared *preparedAppServerProcess) ready() error {
	if prepared == nil {
		return errPreparedAppServerState
	}
	prepared.mu.Lock()
	defer prepared.mu.Unlock()
	return prepared.readyLocked()
}

func (prepared *preparedAppServerProcess) abortLocked() error {
	if prepared.process == nil {
		return errPreparedAppServerState
	}
	if prepared.started {
		return errPreparedAppServerState
	}
	if !prepared.aborted {
		prepared.aborted = true
		p := prepared.process
		for _, file := range []*os.File{prepared.childEnds[0], p.stdin, p.stdout, prepared.childEnds[1], p.stderr, prepared.childEnds[2]} {
			p.closePipe(file)
		}
	}
	return prepared.process.pipeCloseError()
}

func (prepared *preparedAppServerProcess) start() (*AppServerProcess, error) {
	if prepared == nil {
		return nil, errPreparedAppServerState
	}
	prepared.mu.Lock()
	defer prepared.mu.Unlock()
	// Recheck while holding the same lock as Start/abort; an earlier preflight
	// cannot authorize starting a closed or already-started owner.
	if err := prepared.readyLocked(); err != nil {
		if !prepared.started {
			err = errors.Join(err, prepared.abortLocked())
		}
		return nil, err
	}
	p := prepared.process
	if err := p.cmd.Start(); err != nil {
		return nil, errors.Join(err, prepared.abortLocked())
	}
	prepared.started = true
	// Keep the original immediate parent release, native pipes and process group.
	for _, file := range prepared.childEnds {
		p.closePipe(file)
	}
	go func() {
		waitErr := p.cmd.Wait()
		p.waitMu.Lock()
		p.waitErr = waitErr
		p.waitMu.Unlock()
		p.closeProcessGroup()
		close(p.done)
	}()
	return p, nil
}

// wait observes the one existing cmd.Wait owner; it never creates another one.
// Real Done is required for join. An OS/process-group reclamation failure can
// therefore prevent completion; no detached timeout goroutine hides that fact.
func (prepared *preparedAppServerProcess) wait() error {
	if prepared == nil {
		return errPreparedAppServerState
	}
	prepared.mu.Lock()
	started, p := prepared.started, prepared.process
	prepared.mu.Unlock()
	if !started || p == nil {
		return errPreparedAppServerState
	}
	<-p.Done()
	return p.WaitErr()
}

// closeChecked reports owned-pipe errors and direct-child uncertainty, unlike
// wrapping a void Close with unconditional nil. The existing platform group
// terminator does not report outcomes: even a nil result is NOT group proof.
func (prepared *preparedAppServerProcess) closeChecked() error {
	if prepared == nil {
		return errPreparedAppServerState
	}
	prepared.checkedOnce.Do(func() {
		prepared.mu.Lock()
		if !prepared.started {
			prepared.checkedErr = prepared.abortLocked()
			prepared.mu.Unlock()
			return
		}
		p := prepared.process
		prepared.mu.Unlock()
		p.Close()
		prepared.checkedErr = p.pipeCloseError()
		select {
		case <-p.Done():
		default:
			prepared.checkedErr = errors.Join(prepared.checkedErr, errStdioNativeCleanupUnknown)
		}
	})
	return prepared.checkedErr
}

func (p *AppServerProcess) closePipe(file *os.File) {
	if file == nil {
		return
	}
	if err := file.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
		p.pipeMu.Lock()
		p.pipeErr = errors.Join(p.pipeErr, err)
		p.pipeMu.Unlock()
	}
}

func (p *AppServerProcess) pipeCloseError() error {
	p.pipeMu.Lock()
	defer p.pipeMu.Unlock()
	return p.pipeErr
}

// Stdin 返回子进程标准输入写入端。
func (p *AppServerProcess) Stdin() io.WriteCloser {
	if p == nil {
		return nil
	}
	return p.stdin
}

// Stdout 返回子进程标准输出读取端。
func (p *AppServerProcess) Stdout() io.ReadCloser {
	if p == nil {
		return nil
	}
	return p.stdout
}

// Stderr 返回子进程标准错误读取端。
func (p *AppServerProcess) Stderr() io.ReadCloser {
	if p == nil {
		return nil
	}
	return p.stderr
}

// Done 返回在子进程完全回收后关闭的只读信号通道。
func (p *AppServerProcess) Done() <-chan struct{} {
	if p == nil {
		ch := make(chan struct{})
		close(ch)
		return ch
	}
	return p.done
}

// WaitErr 返回子进程退出后的 wait 错误（仅在 Done 关闭后有意义）。
func (p *AppServerProcess) WaitErr() error {
	if p == nil {
		return nil
	}
	p.waitMu.Lock()
	defer p.waitMu.Unlock()
	return p.waitErr
}

func (p *AppServerProcess) closeProcessGroup() {
	p.groupOnce.Do(func() {
		if p.cmd != nil && p.cmd.Process != nil {
			terminateProcessGroup(p.cmd.Process, p.done, childKillGracePeriod)
		}
	})
}

// Close 关闭 stdin 并终止子进程及所属进程组；可安全多次调用。
func (p *AppServerProcess) Close() {
	if p == nil {
		return
	}
	p.closeOnce.Do(func() {
		if p.stdin != nil {
			p.closePipe(p.stdin)
		}
		p.closeProcessGroup()
		select {
		case <-p.done:
		case <-time.After(200 * time.Millisecond):
		}
		if p.stdout != nil {
			p.closePipe(p.stdout)
		}
		if p.stderr != nil {
			p.closePipe(p.stderr)
		}
	})
}

// WaitForStartup 在短暂窗口内确认子进程未立即秒退，用于升级前判定 502/503。
func (p *AppServerProcess) WaitForStartup(ctx context.Context, probeWindow time.Duration) error {
	if p == nil {
		return ErrEmptyCommand
	}
	if probeWindow <= 0 {
		select {
		case <-p.done:
			return errors.New("codex_app_server_exited_immediately")
		default:
			return nil
		}
	}
	timer := time.NewTimer(probeWindow)
	defer timer.Stop()
	select {
	case <-p.done:
		if err := p.WaitErr(); err != nil {
			return err
		}
		return errors.New("codex_app_server_exited_immediately")
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
