package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

// main 为 Go CLI 建立可取消进程生命周期并统一输出根错误。
func main() {
	ctx, stop := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stop()
	if err := run(ctx, os.Args[1:], defaultCommandRuntime()); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "aih:", err)
		os.Exit(1)
	}
}
