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
	if isNativeVersionArgs(os.Args[1:]) {
		if err := writeNativeCLIVersion(os.Stdout); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, "aih:", err)
			os.Exit(1)
		}
		return
	}
	// 旧 Node 入口会为动作命令注入管理密钥；Go 命令直接读同一份 config:server，
	// 显式环境变量优先，保证迁移后的命令不需要额外的宿主包装。
	// 补全入口是最热的 shell 路径，必须在任何数据库访问之前分流。
	if isCompletionEntry(os.Args[1:]) {
		os.Exit(execute(os.Args[1:], defaultCommandRuntime()))
	}
	ensureManagementKeyEnv()
	// 裸启动（aih <provider>）先按健康度挑一个账号；挑不到时交给 Go 的默认账号解析。
	if rewritten, ok := resolveBareLaunchArgs(os.Args[1:]); ok {
		os.Exit(execute(rewritten, defaultCommandRuntime()))
	}
	os.Exit(execute(os.Args[1:], defaultCommandRuntime()))
}

// isCompletionEntry 判断是否为补全协议的内部入口。这些入口必须在
// ensureManagementKeyEnv / 裸启动解析之前分流：TAB 补全不能先开数据库。
func isCompletionEntry(arguments []string) bool {
	if len(arguments) == 0 {
		return false
	}
	switch arguments[0] {
	case "__complete", "__suggest", "__learn":
		return true
	default:
		return false
	}
}

// execute 执行一次 CLI，并把 SIGINT/SIGTERM 的 shell 退出码透传出去。
//
// NotifyContext 只负责取消；单独留一份信号通道，保证 Ctrl+C/SIGTERM 的退出码
// 不被 context.Canceled 吞成 0/1。
func execute(args []string, runtime commandRuntime) int {
	// Codex takeover is a read/terminate management action. Handle it before
	// resume and provider launch dispatch so it cannot be parsed as prompt text.
	if len(args) >= 2 && args[0] == "codex" && args[1] == "takeover" {
		if err := runCodexTakeover(args[2:], runtime); err != nil {
			_, _ = fmt.Fprintln(runtime.stderr, "aih:", err)
			return 1
		}
		return 0
	}
	// Node 启动链的构件库私有管道：必须在任何数据库/账号解析之前分流。
	if handled, err := runArtifactEnsure(context.Background(), args, runtime); handled {
		if err != nil {
			_, _ = fmt.Fprintln(runtime.stderr, "aih:", err)
			return 1
		}
		return 0
	}
	// summary/usage/export/import/ls/resume 与 server 系列命令在 Go 处理；其余顶层命令仍交回 Node。
	if handled, err := runSummaryAlias(context.Background(), args, runtime); handled {
		if err != nil {
			_, _ = fmt.Fprintln(runtime.stderr, "aih:", err)
			return 1
		}
		return 0
	}
	if handled, err := runUsage(context.Background(), args, runtime); handled {
		if err != nil {
			_, _ = fmt.Fprintln(runtime.stderr, "aih:", err)
			return 1
		}
		return 0
	}
	if handled, err := runRootImport(context.Background(), args, runtime); handled {
		if err != nil {
			_, _ = fmt.Fprintln(runtime.stderr, "aih:", err)
			return 1
		}
		return 0
	}
	if handled, err := runRootExport(context.Background(), args, runtime); handled {
		if err != nil {
			_, _ = fmt.Fprintln(runtime.stderr, "aih:", err)
			return 1
		}
		return 0
	}
	if handled, err := runRootLS(context.Background(), args, runtime); handled {
		if err != nil {
			_, _ = fmt.Fprintln(runtime.stderr, "aih:", err)
			return 1
		}
		return 0
	}
	if handled, err := runResume(context.Background(), args, runtime); handled {
		if err != nil {
			_, _ = fmt.Fprintln(runtime.stderr, "aih:", err)
			return 1
		}
		return 0
	}
	if handled, err := runWorkspaceCommand(context.Background(), args, runtime); handled {
		if err != nil {
			var silent silentExit
			if errors.As(err, &silent) {
				return silent.ExitCode()
			}
			_, _ = fmt.Fprintln(runtime.stderr, "aih:", err)
			return 1
		}
		return 0
	}
	if handled, err := runRemoteCommand(context.Background(), args, runtime); handled {
		if err != nil {
			var silent silentExit
			if errors.As(err, &silent) {
				return silent.ExitCode()
			}
			_, _ = fmt.Fprintln(runtime.stderr, "aih:", err)
			return 1
		}
		return 0
	}
	// server sync-codex、serve、env、profiles、config 与生命周期在 Go 处理；其余 server 子命令仍交回 Node。
	if handled, err := runServerSyncCodex(context.Background(), args, runtime); handled {
		if err != nil {
			_, _ = fmt.Fprintln(runtime.stderr, "aih:", err)
			return 1
		}
		return 0
	}
	if handled, err := runServerServe(context.Background(), args, runtime); handled {
		if err != nil {
			_, _ = fmt.Fprintln(runtime.stderr, "aih:", err)
			return 1
		}
		return 0
	}
	if handled, err := runServerEnv(context.Background(), args, runtime); handled {
		if err != nil {
			var silent silentExit
			if errors.As(err, &silent) {
				return silent.ExitCode()
			}
			_, _ = fmt.Fprintln(runtime.stderr, "aih:", err)
			return 1
		}
		return 0
	}
	if handled, err := runServerProfiles(context.Background(), args, runtime); handled {
		if err != nil {
			_, _ = fmt.Fprintln(runtime.stderr, "aih:", err)
			return 1
		}
		return 0
	}
	if handled, err := runServerConfig(context.Background(), args, runtime); handled {
		if err != nil {
			_, _ = fmt.Fprintln(runtime.stderr, "aih:", err)
			return 1
		}
		return 0
	}
	if handled, err := runServerLifecycle(context.Background(), args, runtime); handled {
		if err != nil {
			var silent silentExit
			if errors.As(err, &silent) {
				return silent.ExitCode()
			}
			_, _ = fmt.Fprintln(runtime.stderr, "aih:", err)
			return 1
		}
		return 0
	}
	// autostart 安装已迁到 Go，注册在通用 server 兜底之前。
	if handled, err := runServerAutostart(context.Background(), args, runtime); handled {
		if err != nil {
			_, _ = fmt.Fprintln(runtime.stderr, "aih:", err)
			return 1
		}
		return 0
	}
	if handled, err := runServerFallback(args, runtime); handled {
		if err != nil {
			var silent silentExit
			if errors.As(err, &silent) {
				return silent.ExitCode()
			}
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
