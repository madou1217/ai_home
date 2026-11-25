//go:build !linux

package swapctl

import "runtime"

// Status 在非 Linux 平台固定为不支持：macOS 的交换由系统动态管理，
// Windows 没有可手动调整的交换文件语义。WebUI 据此隐藏入口。
func (manager *Manager) Status() Status {
	reason := "当前系统不支持手动设置交换空间"
	switch runtime.GOOS {
	case "darwin":
		reason = "macOS 的交换空间由系统动态管理，不支持手动设置"
	case "windows":
		reason = "Windows 不支持设置交换文件"
	}
	return Status{Supported: false, Reason: reason}
}

func (manager *Manager) Apply(sizeMB int) (Status, error) {
	return Status{Supported: false, Reason: "当前系统不支持手动设置交换空间"}, errUnsupported
}

func (manager *Manager) Remove() (Status, error) {
	return Status{Supported: false, Reason: "当前系统不支持手动设置交换空间"}, errUnsupported
}

type unsupportedError struct{}

func (unsupportedError) Error() string { return "swap_unsupported" }

var errUnsupported = unsupportedError{}
