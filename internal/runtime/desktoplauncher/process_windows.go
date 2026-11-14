//go:build windows

package desktoplauncher

import (
	"os/exec"
	"syscall"
)

func prepareProcess(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
func terminateProcess(cmd *exec.Cmd, _ bool) {
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
