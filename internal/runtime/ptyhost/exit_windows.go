//go:build windows

package ptyhost

import "os"

// signaledExitCode 在 Windows 没有 Unix 的信号退出码语义。
func signaledExitCode(*os.ProcessState) (int, bool) { return 0, false }
