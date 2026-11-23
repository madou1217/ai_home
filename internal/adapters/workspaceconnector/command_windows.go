//go:build windows

package workspaceconnector

import (
	"errors"
	"os"
	"os/exec"
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
