//go:build !windows

package ptyhost

import (
	"os"
	"syscall"
)

// signaledExitCode 把被信号终止的进程映射成 shell 习惯的 128+signal。
func signaledExitCode(state *os.ProcessState) (int, bool) {
	if state == nil {
		return 0, false
	}
	status, ok := state.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() {
		return 0, false
	}
	return 128 + int(status.Signal()), true
}
