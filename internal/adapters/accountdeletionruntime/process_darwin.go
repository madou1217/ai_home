//go:build darwin

package accountdeletionruntime

import (
	"context"
	"errors"
	"fmt"
	"golang.org/x/sys/unix"
)

func processIdentity(ctx context.Context, pid int) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return "", err
	}
	if info == nil || int(info.Proc.P_pid) != pid {
		return "", errors.New("process_identity_unverifiable")
	}
	return fmt.Sprintf("darwin:%d:%d", info.Proc.P_starttime.Sec, info.Proc.P_starttime.Usec), nil
}

// macOS provides no generation-bound process signal handle. Do not turn a
// lookup-then-kill race into account deletion authority; ask the owner to close.
func terminateIdentity(ctx context.Context, pid int, expected string) error {
	return errors.New("process_owner_close_required")
}
