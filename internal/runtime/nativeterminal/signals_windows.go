//go:build windows

package nativeterminal

import (
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
)

func terminationSignals() []os.Signal { return []os.Signal{os.Interrupt} }
func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(handle)
	var code uint32
	return windows.GetExitCodeProcess(handle, &code) == nil && code == 259
}

// Windows termination uses the private close-request record watched by inner;
// killing a process with TerminateProcess would skip credential reconciliation.
func requestTermination(int) error { return nil }
func signalExit(os.Signal) int     { return 130 }
func processExit(err error) int {
	if err == nil {
		return 0
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode()
	}
	return 1
}
