//go:build !windows

package apps

import (
	"os"
	"os/exec"
	"syscall"
)

func spawnClaudeDesktopDetached(plan claudeDesktopLaunchPlan) error {
	cmd := exec.Command(plan.command, plan.args...)
	cmd.Dir, cmd.Env = plan.cwd, plan.env
	devNull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	defer devNull.Close()
	cmd.Stdin, cmd.Stdout, cmd.Stderr = devNull, devNull, devNull
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	// Reap the directly created child when this process remains alive; exiting
	// the short-lived CLI also leaves an independent detached process.
	go func() { _ = cmd.Wait() }()
	return nil
}
