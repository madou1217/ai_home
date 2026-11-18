//go:build darwin || linux

package regularnativefile

import (
	"os"

	"golang.org/x/sys/unix"
)

const platformSupported = true

func openNative(path string) (*os.File, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		unix.Close(fd)
		return nil, ErrInvalid
	}
	return file, nil
}
