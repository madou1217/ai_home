//go:build !windows

package ptyhost

import (
	"io"
	"os"

	"golang.org/x/sys/unix"
)

func inputPumpCanStop(source io.Reader) bool {
	_, ok := source.(*os.File)
	return ok
}

// copyInputUntilStopped forwards terminal input without leaving a blocking
// read behind after the child exits. A plain io.Copy on the caller's tty can
// consume the next shell command forever because closing the child PTY does
// not interrupt the tty read.
func copyInputUntilStopped(destination io.Writer, source io.Reader, stop <-chan struct{}) {
	file, ok := source.(*os.File)
	if !ok || file == nil {
		_, _ = io.Copy(destination, source)
		return
	}
	copyFileInputUntilStopped(destination, file, stop)
}

func copyFileInputUntilStopped(destination io.Writer, source *os.File, stop <-chan struct{}) {
	buffer := make([]byte, 32*1024)
	fd := int(source.Fd())
	for {
		select {
		case <-stop:
			return
		default:
		}
		pollFD := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
		ready, err := unix.Poll(pollFD, 100)
		if err == unix.EINTR {
			continue
		}
		if err != nil || ready == 0 {
			if err != nil {
				return
			}
			continue
		}
		if pollFD[0].Revents&(unix.POLLIN|unix.POLLHUP|unix.POLLERR) == 0 {
			continue
		}
		count, readErr := unix.Read(fd, buffer)
		if count > 0 {
			if _, writeErr := destination.Write(buffer[:count]); writeErr != nil {
				return
			}
		}
		if readErr != nil || count == 0 {
			return
		}
	}
}
