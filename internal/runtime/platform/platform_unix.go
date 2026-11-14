//go:build !windows

// Package platform 收口 Unix/Windows 有差异的宿主能力探测。
package platform

import (
	"os"
	"syscall"
)

// IsExecutable 判断路径是否是可执行文件。
func IsExecutable(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	if err := syscall.Access(path, 1 /* X_OK */); err == nil {
		return true
	}
	return info.Mode().Perm()&0o111 != 0
}

// IsWritable 判断路径当前用户是否可写。
func IsWritable(path string) bool {
	if path == "" {
		return false
	}
	return syscall.Access(path, 2 /* W_OK */) == nil
}

// Terminate 请求进程退出（Unix 用 SIGTERM）。
func Terminate(pid int) error {
	if pid <= 0 {
		return nil
	}
	return syscall.Kill(pid, syscall.SIGTERM)
}

// FileIdentity 返回文件的 dev/inode；无法取得时返回 0,0。
func FileIdentity(info os.FileInfo) (uint64, uint64) {
	if info == nil {
		return 0, 0
	}
	if stat, ok := info.Sys().(*syscall.Stat_t); ok && stat != nil {
		return uint64(stat.Dev), stat.Ino
	}
	return 0, 0
}

// ProcessState 返回 (存活, 可判定)；ESRCH 是确定的「已退出」。
func ProcessState(pid int) (bool, bool) {
	if pid <= 0 {
		return false, false
	}
	err := syscall.Kill(pid, 0)
	if err == nil || err == syscall.EPERM {
		return true, true
	}
	if err == syscall.ESRCH {
		return false, true
	}
	return false, false
}

// ProcessAlive 判断 pid 对应进程是否存活（EPERM 视为存活）。
func ProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}
