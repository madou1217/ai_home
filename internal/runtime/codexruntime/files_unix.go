//go:build !windows

package codexruntime

import (
	"os"
	"syscall"
)

func lockExclusive(file *os.File) error {
	return syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
}
func unlock(file *os.File)                    { _ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN) }
func replaceFile(source, target string) error { return os.Rename(source, target) }
