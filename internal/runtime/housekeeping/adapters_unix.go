//go:build !windows

package housekeeping

import (
	"os/exec"
	"syscall"
)

func configureHiddenWindow(_ *exec.Cmd) {}

func terminatePID(pid int) error {
	return syscall.Kill(pid, syscall.SIGTERM)
}
