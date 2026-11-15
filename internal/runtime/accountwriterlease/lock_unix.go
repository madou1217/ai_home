//go:build !windows

package accountwriterlease

import (
	"os"
	"syscall"
)

func lock(file *os.File) error { return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB) }
func unlock(file *os.File)     { _ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN) }
