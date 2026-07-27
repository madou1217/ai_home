package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

// main 把操作系统信号转换为 Go Server 的优雅关闭上下文。
func main() {
	ctx, stop := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stop()

	if err := run(ctx, os.Args[1:], defaultCommandRuntime()); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "aih-server 启动失败: %v\n", err)
		os.Exit(1)
	}
}
