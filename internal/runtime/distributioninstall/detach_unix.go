//go:build !windows

package distributioninstall

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"syscall"
	"time"
)

func startDetached(cmd *exec.Cmd, home string) error {
	if runtime.GOOS == "linux" {
		// Setsid alone does not leave the daemon's systemd cgroup: stopping the
		// service would kill its own installer. A transient user service owns it.
		args := []string{"--user", "--quiet", "--collect", "--unit", fmt.Sprintf("aih-update-%d", time.Now().UnixNano()), "--property=Type=exec", "--", cmd.Path}
		args = append(args, cmd.Args[1:]...)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		runner := exec.CommandContext(ctx, "systemd-run", args...)
		runner.Env = cmd.Env
		return runner.Run()
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	return cmd.Process.Release()
}
