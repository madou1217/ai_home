//go:build windows

package hostexec

import (
	"context"
	"os/exec"
	"strconv"
	"time"
)

func configureCommandProcessGroup(_ *exec.Cmd) {}

func killCommandProcessGroup(command *exec.Cmd) error {
	if command.Process == nil {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, "taskkill", "/PID", strconv.Itoa(command.Process.Pid), "/T", "/F").Run(); err != nil {
		return command.Process.Kill()
	}
	return nil
}
