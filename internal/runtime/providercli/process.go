package providercli

import (
	"context"
	"io"
	"os"
	"os/exec"
)

// processSpec 是操作系统进程适配器的完整输入，不实现格式化以避免环境值进入日志。
type processSpec struct {
	path   string
	args   []string
	env    []string
	stdin  io.Reader
	stdout io.Writer
	stderr io.Writer
}

// processHandle 暴露组合进程生命周期所需的最小能力。
type processHandle interface {
	Wait() error
	Signal(os.Signal) error
	Kill() error
}

// processFactory 隔离 exec.Cmd，便于 Runtime 编排做确定性测试。
type processFactory interface {
	Start(ctx context.Context, spec processSpec) (processHandle, error)
}

// execProcessFactory 是生产环境 os/exec 适配器。
type execProcessFactory struct{}

// Start 直接启动官方 Provider CLI，不经过 shell。
func (execProcessFactory) Start(ctx context.Context, spec processSpec) (processHandle, error) {
	command := exec.CommandContext(ctx, spec.path, spec.args...)
	command.Env = append([]string(nil), spec.env...)
	command.Stdin = spec.stdin
	command.Stdout = spec.stdout
	command.Stderr = spec.stderr
	if err := command.Start(); err != nil {
		return nil, err
	}
	return &execProcess{command: command}, nil
}

// execProcess 把 exec.Cmd 收敛到最小生命周期端口。
type execProcess struct {
	command *exec.Cmd
}

// Wait 等待官方 CLI 退出并返回原始退出错误。
func (process *execProcess) Wait() error {
	return process.command.Wait()
}

// Signal 把优雅终止信号转交给官方 CLI。
func (process *execProcess) Signal(signal os.Signal) error {
	return process.command.Process.Signal(signal)
}

// Kill 在有界优雅关闭失败后强制结束官方 CLI。
func (process *execProcess) Kill() error {
	return process.command.Process.Kill()
}
