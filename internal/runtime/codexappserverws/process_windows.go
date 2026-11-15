//go:build windows

package codexappserverws

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func configureDetachedProcess(cmd *exec.Cmd) {
	if cmd == nil {
		return
	}
	const createNoWindow = 0x08000000
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: createNoWindow,
	}
}

func terminateProcessGroup(proc *os.Process, _ <-chan struct{}, _ time.Duration) {
	if proc == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	kill := exec.CommandContext(ctx, "taskkill", "/PID", strconv.Itoa(proc.Pid), "/T", "/F")
	kill.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = kill.Run()
	_ = proc.Kill()
}

func configureVerbatimArguments(cmd *exec.Cmd, args []string, verbatim bool) {
	if !verbatim {
		return
	}
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	}
	cmd.SysProcAttr.CmdLine = syscall.EscapeArg(cmd.Path) + " " + strings.Join(args, " ")
}
