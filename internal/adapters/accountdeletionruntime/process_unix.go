//go:build !windows && !linux && !darwin

package accountdeletionruntime

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

func processIdentity(ctx context.Context, pid int) (string, error) {
	if runtime.GOOS == "linux" {
		raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
		if err != nil {
			return "", err
		}
		end := strings.LastIndexByte(string(raw), ')')
		if end < 0 {
			return "", errors.New("process_identity_unverifiable")
		}
		fields := strings.Fields(string(raw)[end+1:])
		if len(fields) <= 19 {
			return "", errors.New("process_identity_unverifiable")
		}
		return "linux:" + fields[19], nil
	}
	op, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(op, "ps", "-p", strconv.Itoa(pid), "-o", "lstart=")
	cmd.Env = append(os.Environ(), "LC_ALL=C", "TZ=UTC")
	raw, err := cmd.Output()
	if err != nil {
		return "", err
	}
	value := strings.Join(strings.Fields(string(raw)), " ")
	if value == "" {
		return "", errors.New("process_identity_unverifiable")
	}
	return "unix:" + value, nil
}

func terminateIdentity(ctx context.Context, pid int, expected string) error {
	return errors.New("process_termination_identity_unavailable")
}
