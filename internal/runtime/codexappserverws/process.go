package codexappserverws

import (
	"context"
	"errors"
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
}

// StartAppServerProcess 启动子进程并独立回收退出状态。
func StartAppServerProcess(opts StartProcessOptions) (*AppServerProcess, error) {
	command := strings.TrimSpace(opts.Command)
	if command == "" {
		return nil, ErrEmptyCommand
	}
	args := opts.Args
	if len(args) == 0 {
		args = []string{"app-server", "--listen", "stdio://"}
	}

	for _, entry := range opts.Env {
		if strings.HasPrefix(entry, "CODEX_HOME=") {
			if err := codexpreferences.CheckHostReady(strings.TrimPrefix(entry, "CODEX_HOME=")); err != nil {
				return nil, err
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

	if err := cmd.Start(); err != nil {
		_ = stdinR.Close()
		_ = stdinW.Close()
		_ = stdoutR.Close()
		_ = stdoutW.Close()
		_ = stderrR.Close()
		_ = stderrW.Close()
		return nil, err
	}

	// 父进程立即释放子进程端句柄，确保子进程退出后 stdout/stderr 准确收到 EOF。
	_ = stdinR.Close()
	_ = stdoutW.Close()
	_ = stderrW.Close()

	proc := &AppServerProcess{
		cmd:    cmd,
		stdin:  stdinW,
		stdout: stdoutR,
		stderr: stderrR,
		done:   make(chan struct{}),
	}

	go func() {
		waitErr := cmd.Wait()
		proc.waitMu.Lock()
		proc.waitErr = waitErr
		proc.waitMu.Unlock()
		// Reclaim the exclusively created process group immediately after its
		// leader exits. Later Close calls cannot signal a potentially reused PID.
		proc.closeProcessGroup()
		close(proc.done)
	}()

	return proc, nil
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
			_ = p.stdin.Close()
		}
		p.closeProcessGroup()
		select {
		case <-p.done:
		case <-time.After(200 * time.Millisecond):
		}
		if p.stdout != nil {
			_ = p.stdout.Close()
		}
		if p.stderr != nil {
			_ = p.stderr.Close()
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
