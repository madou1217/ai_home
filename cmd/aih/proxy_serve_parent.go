package main

import (
	"context"
	"os"
	"time"
)

// watchParentProcess 在顶层监督进程消失后取消代理上下文。
//
// launchd/systemd 的 kickstart -k 只向登记的包装器发信号（SIGKILL 无法转发），
// 子进程会被遗留并继续续租。包装器启动子进程时会追加 --exit-with-parent；
// 这里按秒核对父进程是否变化（被收养后 ppid 变成 1 或新的监护进程），
// 变化即走与 Ctrl+C 相同的取消路径，让 defer 释放租约并清理入口文件。
func watchParentProcess(ctx context.Context, parent int, cancel context.CancelFunc) {
	if parent <= 1 {
		return
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if os.Getppid() != parent {
				cancel()
				return
			}
		}
	}
}
