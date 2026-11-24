//go:build !windows

package completion

import (
	"os/exec"
	"syscall"
)

// detachCompletionProcess 让刷新子进程脱离当前 shell 的进程组：
// TAB 补全进程退出后，子进程仍能把 --help 的结果写进缓存。
func detachCompletionProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
