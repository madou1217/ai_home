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
	// NotifyContext 只负责取消；单独留一份信号通道，保证 Ctrl+C/SIGTERM 的
	// shell 退出码不被 context.Canceled 吞成 0/1。
	signalCh := make(chan os.Signal, 2)
	signal.Notify(signalCh, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signalCh)
	err := run(ctx, os.Args[1:], defaultCommandRuntime())
	select {
	case received := <-signalCh:
		if received == os.Interrupt {
			os.Exit(130)
		}
		os.Exit(143)
	default:
	}
	if err != nil {
		var silent silentExit
		if errors.As(err, &silent) {
			os.Exit(silent.ExitCode())
		}
		_, _ = fmt.Fprintln(os.Stderr, "aih:", err)
		os.Exit(1)
	}
}
