package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

// main 把操作系统信号转换为 Go Server 的优雅关闭上下文，并把同一个取消动作
// 交给管理端点：Windows 上 `child.kill('SIGTERM')` 实际是 TerminateProcess，
// 宿主只能靠这条进程内路径触发优雅关闭。
func main() {
	signalCtx, stop := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stop()
	ctx, cancel := context.WithCancel(signalCtx)
	defer cancel()

	if err := run(ctx, os.Args[1:], defaultCommandRuntime(cancel)); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "aih-server 启动失败: %v\n", err)
		os.Exit(1)
	}
}
