//go:build !windows

package webuiserverrestartapi

import (
	"os/exec"
	"syscall"
)

func configureDetachedCmd(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setsid: true,
	}
}
