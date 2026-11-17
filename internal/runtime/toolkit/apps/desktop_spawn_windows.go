//go:build windows

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
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: 0x00000008 | 0x00000200, HideWindow: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
