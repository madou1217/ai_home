//go:build windows

package proxyserve

import (
	"os/exec"
	"syscall"
)

// detachProcess gives the proxy child its own process group so closing the
// launching terminal does not terminate the entry used by the app.
func detachProcess(command *exec.Cmd) {
	if command == nil {
		return
	}
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
}
