//go:build windows

package webuiopenappapi

import (
	"context"
	"os"
	"os/exec"
	"os/user"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func lookupOSUserHomeDir() string {
	if current, err := user.Current(); err == nil && strings.TrimSpace(current.HomeDir) != "" {
		return strings.TrimSpace(current.HomeDir)
	}
	return ""
}

func startDetachedOS(spec SpawnSpec) (int, error) {
	cmd := exec.Command(spec.File, spec.Args...)
	if spec.Dir != "" {
		cmd.Dir = spec.Dir
	}
	if len(spec.Env) > 0 {
		cmd.Env = spec.Env
	}
	const detachedProcess = 0x00000008
	const createNewProcessGroup = 0x00000200
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: detachedProcess | createNewProcessGroup,
		HideWindow:    spec.WindowsHide,
	}
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	pid := 0
	if cmd.Process != nil {
		pid = cmd.Process.Pid
		_ = cmd.Process.Release()
	}
	return pid, nil
}

func isProcessAliveOS(pid int) bool {
	if pid <= 0 {
		return false
	}
	proc, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return proc != nil
}

func closeProcessTreeOS(
	ctx context.Context,
	runner CommandRunner,
	pids []int,
	_ time.Duration,
	_ func(context.Context, time.Duration) error,
) ([]int, error) {
	roots := parsePositivePIDs(pids)
	if len(roots) == 0 {
		return []int{}, nil
	}
	for _, pid := range roots {
		if runner != nil {
			_ = runner.Run(ctx, "taskkill", []string{"/PID", strconv.Itoa(pid), "/T", "/F"}, RunOptions{Timeout: 5 * time.Second})
		}
	}
	return roots, nil
}
