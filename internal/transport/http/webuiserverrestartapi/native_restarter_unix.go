//go:build !windows

package webuiserverrestartapi

import (
	"context"
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

// restartPlatform leaves the existing launchd/systemd path unchanged.
func (r *NativeRestarter) restartPlatform(context.Context, RestartJob) (RestartOutcome, bool, error) {
	return RestartOutcome{}, false, nil
}
