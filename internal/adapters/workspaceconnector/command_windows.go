//go:build windows

package workspaceconnector

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

// Windows has no portable process-group kill from this layer; the default
// CommandContext cancel (terminate the direct process) is the documented limit
// of the connector command channel.
func configureCommand(command *exec.Cmd) {}

// terminateCommand ends the direct process only.
func terminateCommand(command *exec.Cmd) error {
	if command == nil || command.Process == nil {
		return nil
	}
	err := command.Process.Kill()
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}

// configureDetached starts the runner detached from the connector console.
func configureDetached(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200}
}

// signalRunner can only terminate the runner process itself on Windows.
func signalRunner(pid int, force bool) error {
	process, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	err = process.Kill()
	if errors.Is(err, os.ErrProcessDone) {
		return nil
	}
	return err
}
