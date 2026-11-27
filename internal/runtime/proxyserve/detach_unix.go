//go:build !windows

package proxyserve

import (
	"os/exec"
	"syscall"
)

// detachProcess puts the proxy child in its own session so a terminal closing
// (SIGHUP) or the launching CLI exiting does not take the entry down. The app
// launched by `aih app --proxy us,jp` keeps using this entry after the CLI
// returns.
func detachProcess(command *exec.Cmd) {
	if command == nil {
		return
	}
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
