//go:build windows

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
	const createNoWindow = 0x08000000
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
}

func terminateProcessGroup(proc *os.Process, done <-chan struct{}, _ time.Duration) {
	if proc == nil {
		return
	}
	select {
	case <-done:
		return
	default:
	}
	_ = proc.Kill()
}
