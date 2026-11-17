//go:build windows

package accountdeletionruntime

import (
	"context"
	"fmt"
	"golang.org/x/sys/windows"
)

func processIdentity(ctx context.Context, pid int) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(handle)
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(handle, &created, &exited, &kernel, &user); err != nil {
		return "", err
	}
	return fmt.Sprintf("windows:%d:%d", created.HighDateTime, created.LowDateTime), nil
}

// terminateIdentity keeps one kernel handle through generation verification and
// termination. A PID reused after the handle opens cannot target a new process.
func terminateIdentity(ctx context.Context, pid int, expected string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(handle, &created, &exited, &kernel, &user); err != nil {
		return err
	}
	if fmt.Sprintf("windows:%d:%d", created.HighDateTime, created.LowDateTime) != expected {
		return fmt.Errorf("process_identity_changed")
	}
	return windows.TerminateProcess(handle, 1)
}
