//go:build !windows

package codexappserverws

import (
	"os/exec"
	"syscall"
)

// configureSharedProcess 让共享后端脱离创建者的进程组与会话，避免终端退出时被回收。
func configureSharedProcess(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
