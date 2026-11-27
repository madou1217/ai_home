//go:build darwin || linux

package appsessions

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func listProcesses(ctx context.Context) ([]Process, error) {
	command := exec.CommandContext(ctx, "ps", "-axww", "-o", "pid=,etime=,command=")
	command.Env = append(command.Environ(), "LC_ALL=C")
	output, err := command.Output()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	lines := strings.Split(string(output), "\n")
	processes := make([]Process, 0, len(lines))
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		pid, err := strconv.Atoi(fields[0])
		if err != nil || pid <= 0 {
			continue
		}
		elapsed, err := parseElapsed(fields[1])
		if err != nil {
			continue
		}
		processes = append(processes, Process{
			PID:       pid,
			Command:   strings.Join(fields[2:], " "),
			StartedAt: now.Add(-elapsed),
		})
	}
	return processes, nil
}

// parseElapsed parses ps etime: [[dd-]hh:]mm:ss.
func parseElapsed(value string) (time.Duration, error) {
	days := 0
	if index := strings.IndexByte(value, '-'); index >= 0 {
		parsed, err := strconv.Atoi(value[:index])
		if err != nil {
			return 0, err
		}
		days = parsed
		value = value[index+1:]
	}
	parts := strings.Split(value, ":")
	var hours, minutes, seconds int
	switch len(parts) {
	case 3:
		parsed, err := strconv.Atoi(parts[0])
		if err != nil {
			return 0, err
		}
		hours = parsed
		parts = parts[1:]
		fallthrough
	case 2:
		parsed, err := strconv.Atoi(parts[0])
		if err != nil {
			return 0, err
		}
		minutes = parsed
		parsed, err = strconv.Atoi(parts[1])
		if err != nil {
			return 0, err
		}
		seconds = parsed
	default:
		return 0, fmt.Errorf("invalid etime %q", value)
	}
	return time.Duration(days)*24*time.Hour +
		time.Duration(hours)*time.Hour +
		time.Duration(minutes)*time.Minute +
		time.Duration(seconds)*time.Second, nil
}

func terminateProcesses(ctx context.Context, pids []int) ([]int, error) {
	var signalled []int
	for _, pid := range pids {
		if pid <= 0 || pid == 1 {
			continue
		}
		if err := syscall.Kill(pid, syscall.SIGTERM); err == nil {
			signalled = append(signalled, pid)
		}
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		alive := false
		for _, pid := range signalled {
			if syscall.Kill(pid, 0) == nil {
				alive = true
				break
			}
		}
		if !alive {
			break
		}
		select {
		case <-ctx.Done():
			return signalled, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	for _, pid := range signalled {
		if syscall.Kill(pid, 0) == nil {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
	return signalled, nil
}
