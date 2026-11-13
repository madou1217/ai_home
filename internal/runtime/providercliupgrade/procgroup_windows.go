//go:build windows

package providercliupgrade

import (
	"os/exec"
	"strconv"
)

func configureVerifyCmdProcessGroup(_ *exec.Cmd) {}

func killVerifyCmdProcessTree(cmd *exec.Cmd) {
	if cmd == nil || cmd.Process == nil || cmd.Process.Pid <= 0 {
		return
	}
	pid := cmd.Process.Pid
	killCmd := exec.Command("taskkill", "/PID", strconv.Itoa(pid), "/T", "/F")
	if err := killCmd.Run(); err != nil {
		_ = cmd.Process.Kill()
	}
}
