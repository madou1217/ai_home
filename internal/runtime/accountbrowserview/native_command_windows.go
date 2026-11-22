//go:build windows

package accountbrowserview

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// prepareBrowserCommand keeps the native helper and its dotnet build off the
// interactive desktop. Both are console programs; without CREATE_NO_WINDOW the
// OS would allocate a visible console for every browser start.
func prepareBrowserCommand(command *exec.Cmd) {
	if command == nil {
		return
	}
	command.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: windows.CREATE_NO_WINDOW,
	}
}
