//go:build !windows

package serveridentity

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

func processStartID() (string, error) {
	if runtime.GOOS == "linux" {
		raw, err := os.ReadFile("/proc/self/stat")
		if err != nil {
			return "", err
		}
		fields := strings.Fields(string(raw)[strings.LastIndex(string(raw), ")")+1:])
		if len(fields) <= 19 {
			return "", fmt.Errorf("missing process start ticks")
		}
		return "linux:" + fields[19], nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "ps", "-p", strconv.Itoa(os.Getpid()), "-o", "lstart=")
	cmd.Env = append(os.Environ(), "LC_ALL=C", "TZ=UTC")
	raw, err := cmd.Output()
	if err != nil {
		return "", err
	}
	value := strings.Join(strings.Fields(string(raw)), " ")
	if value == "" {
		return "", fmt.Errorf("missing process start time")
	}
	return "unix:" + value, nil
}
