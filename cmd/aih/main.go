package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/madou1217/ai_home/internal/runtime/nativeterminal"
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
	// 交给 Node 入口的动词必须在构造 runtime 之前分流：
	// runtime 会持有账号写入租约等进程级资源，先构造再 exec 会让 Node 侧阻塞。
	if delegateToNode(os.Args[1:]) {
		os.Exit(0)
	}
	os.Exit(execute(os.Args[1:], defaultCommandRuntime()))
}

// execute 执行一次 CLI，并把 SIGINT/SIGTERM 的 shell 退出码透传出去。
//
// NotifyContext 只负责取消；单独留一份信号通道，保证 Ctrl+C/SIGTERM 的退出码
// 不被 context.Canceled 吞成 0/1。
func execute(args []string, runtime commandRuntime) int {
	// server config 与生命周期在 Go 处理；其余 server 子命令仍交回 Node。
	if handled, err := runServerConfig(context.Background(), args, runtime); handled {
		if err != nil {
			_, _ = fmt.Fprintln(runtime.stderr, "aih:", err)
			return 1
		}
		return 0
	}
	if handled, err := runServerLifecycle(context.Background(), args, runtime); handled {
		if err != nil {
			_, _ = fmt.Fprintln(runtime.stderr, "aih:", err)
			return 1
		}
		return 0
	}
	// autostart 安装已迁到 Go，先于 Node 兜底处理，避免安装路径依赖 ai-home.js。
	if handled, err := runServerAutostart(context.Background(), args, runtime); handled {
		if err != nil {
			_, _ = fmt.Fprintln(runtime.stderr, "aih:", err)
			return 1
		}
		return 0
	}
	// Native terminal supervision owns its own signal/capture/drain order. Keep
	// this adapter thin and leave provider dispatch in the shared runCLI entry.
	if len(args) > 0 && args[0] == nativeterminal.Command {
		return nativeterminal.Execute(args[1:], nativeterminal.Runtime{
			Stdin: runtime.stdin, Stdout: runtime.stdout, Stderr: runtime.stderr,
			RunCLI: func(ctx context.Context, arguments []string) error { return runCLI(ctx, arguments, runtime) },
		})
	}
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
