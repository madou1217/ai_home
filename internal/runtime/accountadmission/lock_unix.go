//go:build !windows

package accountadmission

import (
	"os"
	"syscall"
)

func lock(file *os.File, exclusive bool) error {
	mode := syscall.LOCK_SH
	if exclusive {
		mode = syscall.LOCK_EX
	}
	return syscall.Flock(int(file.Fd()), mode|syscall.LOCK_NB)
}
func unlock(file *os.File) { _ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN) }
