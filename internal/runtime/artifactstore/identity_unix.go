//go:build !windows

package artifactstore

import (
	"os"
	"syscall"
)

func identityForPath(path string) (string, string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return "", "", &os.PathError{Op: "identity", Path: path, Err: syscall.EINVAL}
	}
	return uint64String(uint64(stat.Dev)), uint64String(uint64(stat.Ino)), nil
}

func statfsFree(directory string) (int64, bool) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(directory, &stat); err != nil {
		return 0, false
	}
	return int64(stat.Bavail) * int64(stat.Bsize), true
}
