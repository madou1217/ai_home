//go:build windows

package acpclient

import (
	"os"
	"os/exec"
)

func configureCommand(command *exec.Cmd) {
	command.Cancel = func() error {
		if command.Process == nil {
			return nil
		}
		return command.Process.Kill()
	}
}

func terminateCommand(command *exec.Cmd) error {
	if command == nil || command.Process == nil {
		return nil
	}
	return command.Process.Kill()
}

func terminalExitStatus(state *os.ProcessState) (*int64, string) {
	if state == nil {
		return nil, ""
	}
	code := int64(state.ExitCode())
	return &code, ""
}
