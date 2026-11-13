//go:build !windows

package pluginhost

import (
	"os"
	"os/exec"
	"syscall"
)

func configureHostCommand(_ *exec.Cmd) {}

func terminateProcess(proc *os.Process) error {
	if proc == nil {
		return nil
	}
	return proc.Signal(syscall.SIGTERM)
}
