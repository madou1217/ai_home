//go:build !windows

package codexappserverws

import (
	"os"
	"os/exec"
	"syscall"
	"time"
)

func configureDetachedProcess(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func terminateProcessGroup(proc *os.Process, done <-chan struct{}, grace time.Duration) {
	if proc == nil || proc.Pid <= 0 {
		return
	}
	select {
	case <-done:
		return
	default:
	}

	pid := proc.Pid
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	_ = proc.Signal(syscall.SIGTERM)

	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case <-done:
		return
	case <-timer.C:
	}

	_ = syscall.Kill(-pid, syscall.SIGKILL)
	_ = proc.Kill()
}
