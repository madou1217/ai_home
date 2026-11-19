//go:build windows

package codexappserverws

import (
	"os/exec"
	"syscall"
)

const createNewProcessGroup = 0x00000200

// configureSharedProcess 让共享后端不随创建者控制台关闭而退出。
func configureSharedProcess(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNewProcessGroup}
}
