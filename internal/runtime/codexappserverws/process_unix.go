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

func terminateProcessGroup(proc *os.Process, _ <-chan struct{}, grace time.Duration) {
	if proc == nil || proc.Pid <= 0 {
		return
	}
	// This group was created exclusively for the child. Its leader can exit
	// before inherited pipes/grandchildren do; leader Done is not group Done.
	pid := proc.Pid
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	_ = proc.Signal(syscall.SIGTERM)

	deadline := time.NewTimer(grace)
	defer deadline.Stop()
	poll := time.NewTicker(10 * time.Millisecond)
	defer poll.Stop()
	for {
		if err := syscall.Kill(-pid, 0); err == syscall.ESRCH {
			return
		}
		select {
		case <-poll.C:
		case <-deadline.C:
			_ = syscall.Kill(-pid, syscall.SIGKILL)
			_ = proc.Kill()
			return
		}
	}
}

func configureVerbatimArguments(_ *exec.Cmd, _ []string, _ bool) {}
