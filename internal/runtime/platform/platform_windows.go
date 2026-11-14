//go:build windows

package platform

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// IsExecutable 判断路径是否是可执行文件：Windows 按 PATHEXT 常见后缀判断。
func IsExecutable(path string) bool {
	if path == "" {
		return false
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	switch strings.ToLower(filepath.Ext(path)) {
	case ".exe", ".cmd", ".bat", ".com", ".ps1":
		return true
	}
	return false
}

// IsWritable 判断路径是否可写：文件/目录带只读属性即视为不可写。
func IsWritable(path string) bool {
	if path == "" {
		return false
	}
	attributes, err := windows.GetFileAttributes(windows.StringToUTF16Ptr(path))
	if err != nil {
		return false
	}
	return attributes&windows.FILE_ATTRIBUTE_READONLY == 0
}

// Terminate 终止进程（Windows 没有 SIGTERM，直接 TerminateProcess）。
func Terminate(pid int) error {
	if pid <= 0 {
		return nil
	}
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	return windows.TerminateProcess(handle, 1)
}

// FileIdentity 在 Windows 上没有 dev/inode；调用方回退到路径身份。
func FileIdentity(os.FileInfo) (uint64, uint64) {
	return 0, 0
}

// stillActive 与 Windows STILL_ACTIVE 一致。
const stillActive = 259

// ProcessState 返回 (存活, 可判定)。
func ProcessState(pid int) (bool, bool) {
	if pid <= 0 {
		return false, false
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return false, true
		}
		return false, false
	}
	defer windows.CloseHandle(handle)
	var code uint32
	if err := windows.GetExitCodeProcess(handle, &code); err != nil {
		return false, false
	}
	return code == stillActive, true
}

// ProcessAlive 判断 pid 对应进程是否存活。
func ProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(handle)
	var code uint32
	if err := windows.GetExitCodeProcess(handle, &code); err != nil {
		return false
	}
	return code == stillActive
}
