//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

// hideChildWindow prevents console helper processes (PowerShell, cmd) from
// flashing a terminal when aih runs from a GUI shortcut or hotkey.
func hideChildWindow(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
