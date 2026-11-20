//go:build !windows

package main

import (
	"time"
)

// 非 Windows 平台由服务管理器负责进程生命周期，这里的 Windows 专用钩子是空实现。
func windowsServicePID(string) int               { return 0 }
func windowsKillPID(int)                         {}
func windowsWaitPIDGone(int, time.Duration) bool { return true }
