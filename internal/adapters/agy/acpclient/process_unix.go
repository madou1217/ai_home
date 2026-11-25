//go:build !windows

package acpclient

import (
	"os"
	"os/exec"
	"syscall"
)

func configureCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func terminateCommand(command *exec.Cmd) error {
	if command == nil || command.Process == nil {
		return nil
	}
	err := syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
	if err == syscall.ESRCH {
		return nil
	}
	return err
}

func terminalExitStatus(state *os.ProcessState) (*int64, string) {
	if state == nil {
		return nil, ""
	}
	wait, ok := state.Sys().(syscall.WaitStatus)
	if !ok || !wait.Signaled() {
		code := int64(state.ExitCode())
		return &code, ""
	}
	return nil, wait.Signal().String()
}
