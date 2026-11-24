//go:build windows

package completion

import (
	"os/exec"
	"syscall"
)

// DETACHED_PROCESS 让刷新子进程不继承控制台，也不阻塞补全进程退出。
const detachedProcess = 0x00000008

func detachCompletionProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{CreationFlags: detachedProcess}
}
