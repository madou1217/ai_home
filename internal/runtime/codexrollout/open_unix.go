//go:build !windows

package codexrollout

import (
	"os"

	"golang.org/x/sys/unix"
)

// O_NONBLOCK prevents a concurrent regular-file→FIFO replacement from hanging
// the history reader between its path check and descriptor verification.
func openHistoryFile(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(fd), path), nil
}
