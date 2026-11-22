//go:build !windows

package workspaceconnector

import (
	"os/exec"
	"syscall"
)

// configureCommand puts the command in its own process group so a timeout or
// disconnect kills children too, not just the shell.
func configureCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error {
		if command.Process == nil {
			return nil
		}
		return syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
	}
}
