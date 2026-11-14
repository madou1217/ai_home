package desktopbuild

import (
	"context"
	"fmt"
	"os/exec"
	"time"
)

// Tools can be chatty on failure; keep at most one MiB and never echo the environment.
type boundedOutput struct{ data []byte }

func (out *boundedOutput) Write(data []byte) (int, error) {
	n := len(data)
	remaining := (1 << 20) - len(out.data)
	if remaining > 0 {
		out.data = append(out.data, data[:min(len(data), remaining)]...)
	}
	return n, nil
}

func runTool(ctx context.Context, timeout time.Duration, dir string, env []string, name string, args ...string) ([]byte, error) {
	childCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(childCtx, name, args...)
	command.Dir = dir
	if env != nil {
		command.Env = env
	}
	command.WaitDelay = 2 * time.Second
	var output boundedOutput
	command.Stdout, command.Stderr = &output, &output
	err := command.Run()
	if childCtx.Err() != nil {
		return output.data, childCtx.Err()
	}
	if err != nil {
		return output.data, fmt.Errorf("desktop_build_tool_failed (%s): %w: %.2048s", name, err, output.data)
	}
	return output.data, nil
}
