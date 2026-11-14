//go:build !windows

package nativeterminal

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

func terminationSignals() []os.Signal {
	return []os.Signal{os.Interrupt, syscall.SIGTERM, syscall.SIGHUP}
}
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
func requestTermination(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) }
func signalExit(signal os.Signal) int {
	if value, ok := signal.(syscall.Signal); ok {
		return 128 + int(value)
	}
	return 1
}
func processExit(err error) int {
	if err == nil {
		return 0
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		if status, ok := exit.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			return 128 + int(status.Signal())
		}
		return exit.ExitCode()
	}
	return 1
}
