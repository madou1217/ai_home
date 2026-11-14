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

// runCLI 是测试可替换的根命令入口；生产路径固定为 run。
var runCLI = run

// main 为 Go CLI 建立可取消进程生命周期并统一输出根错误。
func main() {
	os.Exit(execute(os.Args[1:], defaultCommandRuntime()))
}

// execute 执行一次 CLI，并把 SIGINT/SIGTERM 的 shell 退出码透传出去。
//
// NotifyContext 只负责取消；单独留一份信号通道，保证 Ctrl+C/SIGTERM 的退出码
// 不被 context.Canceled 吞成 0/1。
func execute(args []string, runtime commandRuntime) int {
	ctx, stop := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stop()
	signalCh := make(chan os.Signal, 2)
	signal.Notify(signalCh, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signalCh)

	err := runCLI(ctx, args, runtime)
	select {
	case received := <-signalCh:
		if received == os.Interrupt {
			return 130
		}
		return 143
	default:
	}
	if err != nil {
		var silent silentExit
		if errors.As(err, &silent) {
			return silent.ExitCode()
		}
		_, _ = fmt.Fprintln(os.Stderr, "aih:", err)
		return 1
	}
	return 0
}
