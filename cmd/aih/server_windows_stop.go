package main

import (
	"context"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/autostart"
)

// windowsStopService 按进程停止受管服务：任务计划程序的 /End 只结束任务记录，
// aih-server 子进程常继续存活，必须按运行态里的 pid 结束进程树。
// 非 Windows 平台 windowsServicePID/windowsKillPID/windowsWaitPIDGone 是空实现，
// 因此这里的“按进程结束”退化为普通服务管理器停止。
func windowsStopService(ctx context.Context, options autostart.Options) {
	if pid := windowsServicePID(options.Home); pid > 0 {
		windowsKillPID(pid)
		_ = windowsWaitPIDGone(pid, 15*time.Second)
	}
	_ = autostart.Stop(ctx, options)
}
