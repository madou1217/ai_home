//go:build windows

package pluginhost

import (
	"os"
	"os/exec"
	"syscall"
)

func configureHostCommand(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}

func terminateProcess(proc *os.Process) error {
	if proc == nil {
		return nil
	}
	return proc.Kill()
}
