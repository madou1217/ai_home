//go:build linux

package accountdeletionruntime

import (
	"context"
	"errors"
	"golang.org/x/sys/unix"
	"os"
	"strconv"
	"strings"
)

func processIdentity(ctx context.Context, pid int) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
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
func terminateIdentity(ctx context.Context, pid int, expected string) error {
	fd, err := unix.PidfdOpen(pid, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	identity, err := processIdentity(ctx, pid)
	if err != nil {
		return err
	}
	if identity != expected {
		return errors.New("process_identity_changed")
	}
	return unix.PidfdSendSignal(fd, unix.SIGTERM, nil, 0)
}
