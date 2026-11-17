//go:build linux || darwin

package platform

import (
	"errors"
	"os"
	"syscall"
)

func Lock(file *os.File) error   { return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) }
func Unlock(file *os.File) error { return syscall.Flock(int(file.Fd()), syscall.LOCK_UN) }
func Contended(err error) bool {
	return errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN)
}

func ProcessAlive(pid int) bool { return pid > 0 && syscall.Kill(pid, 0) == nil }
