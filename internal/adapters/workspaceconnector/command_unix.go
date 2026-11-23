//go:build !windows

package workspaceconnector

import (
	"errors"
	"os/exec"
	"syscall"
)

// configureCommand puts the command in its own process group so a timeout or
// disconnect kills children too, not just the shell.
func configureCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error {
		return terminateCommand(command)
	}
}

// terminateCommand kills the whole process group. It is used by context
// cancellation and by interrupt_job.
func terminateCommand(command *exec.Cmd) error {
	if command == nil || command.Process == nil {
		return nil
	}
	err := syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}

// configureDetached starts the job runner in its own session so it survives the
// connector process and owns a killable process group.
func configureDetached(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

// signalRunner asks the detached runner to stop (SIGTERM) or kills its whole
// group (SIGKILL) when the runner does not respond.
func signalRunner(pid int, force bool) error {
	signal := syscall.SIGTERM
	if force {
		signal = syscall.SIGKILL
	}
	err := syscall.Kill(-pid, signal)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}
