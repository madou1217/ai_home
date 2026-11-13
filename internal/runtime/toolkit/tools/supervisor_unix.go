//go:build !windows

package tools

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

func configureDetachedCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true,
	}
}

func defaultProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func defaultProcessKill(pid int, sig string) bool {
	if pid <= 0 {
		return false
	}
	s := syscall.SIGTERM
	if sig == "SIGKILL" {
		s = syscall.SIGKILL
	}
	return syscall.Kill(pid, s) == nil
}

func processExitStatus(cmd *exec.Cmd, waitErr error) (*int, string) {
	if waitErr == nil {
		z := 0
		return &z, ""
	}
	var exitErr *exec.ExitError
	if errors.As(waitErr, &exitErr) {
		if ws, ok := exitErr.Sys().(syscall.WaitStatus); ok {
			if ws.Signaled() {
				return nil, ws.Signal().String()
			}
			code := ws.ExitStatus()
			return &code, ""
		}
		code := exitErr.ExitCode()
		return &code, ""
	}
	_ = os.ErrProcessDone
	return nil, ""
}
