//go:build darwin || linux

package boundedinput

import (
	"context"
	"errors"
	"io"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

func readPlatform(ctx context.Context, input *os.File, max int64) (raw []byte, err error) {
	original, err := input.SyscallConn()
	if err != nil {
		return nil, err
	}
	fd, flags := -1, 0
	var setupErr error
	err = original.Control(func(inherited uintptr) {
		flags, setupErr = unix.FcntlInt(inherited, unix.F_GETFL, 0)
		if setupErr != nil {
			return
		}
		fd, setupErr = unix.FcntlInt(inherited, unix.F_DUPFD_CLOEXEC, 0)
	})
	if err != nil || setupErr != nil {
		return nil, errors.Join(err, setupErr)
	}
	if err := unix.SetNonblock(fd, true); err != nil {
		_ = unix.Close(fd)
		return nil, err
	}
	owned := os.NewFile(uintptr(fd), "bounded-input")
	defer func() {
		// The duplicate shares status flags with the original. Restore only after
		// synchronous read and its cancellation callback have both finished.
		_, restoreErr := unix.FcntlInt(uintptr(fd), unix.F_SETFL, flags)
		err = errors.Join(err, restoreErr, owned.Close())
	}()
	deadline, _ := ctx.Deadline()
	if err := owned.SetReadDeadline(deadline); err != nil {
		return nil, ErrUnsupportedInput
	}
	done := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		_ = owned.SetReadDeadline(time.Now())
		close(done)
	})
	raw, err = io.ReadAll(io.LimitReader(owned, max+1))
	if !stop() {
		<-done
	}
	return raw, err
}
