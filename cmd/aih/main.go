package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"
)

// silentExit 是前台 TUI 透传退出码的窄合同：不打印 aih 自身错误，只保留子进程退出码。
type silentExit interface {
	ExitCode() int
	SilentExit()
}

// main 为 Go CLI 建立可取消进程生命周期并统一输出根错误。
func main() {
	ctx, stop := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stop()
	if err := run(ctx, os.Args[1:], defaultCommandRuntime()); err != nil {
		var silent silentExit
		if errors.As(err, &silent) {
			os.Exit(silent.ExitCode())
		}
		_, _ = fmt.Fprintln(os.Stderr, "aih:", err)
		os.Exit(1)
	}
}
