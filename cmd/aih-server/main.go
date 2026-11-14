package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"

	"github.com/madou1217/ai_home/internal/runtime/chatruntime/approvaltool"
	"github.com/madou1217/ai_home/internal/runtime/providersessionhook"
)

// main 把操作系统信号转换为 Go Server 的优雅关闭上下文，并把同一个取消动作
// 交给管理端点：Windows 上 `child.kill('SIGTERM')` 实际是 TerminateProcess，
// 宿主只能靠这条进程内路径触发优雅关闭。
func main() {
	// Claude 的权限提示 MCP server 复用本二进制：由 provider 直接拉起，
	// 不经过服务器装配，也不依赖 Node 脚本。
	if len(os.Args) > 1 && os.Args[1] == "__mcp-approve" {
		if err := approvaltool.Run(os.Stdin, os.Stdout, os.Getenv); err != nil {
			_, _ = fmt.Fprintf(os.Stderr, "aih-server __mcp-approve: %v\n", err)
			os.Exit(1)
		}
		return
	}
	// Provider 官方 hook 的发送器：由 provider 直接执行，不经服务器装配，也不需要 Node。
	if len(os.Args) > 1 && os.Args[1] == "__provider-hook" {
		stdin, _ := io.ReadAll(io.LimitReader(os.Stdin, 4<<20))
		result := providersessionhook.Run(providersessionhook.Options{
			Args:   os.Args[2:],
			Stdin:  stdin,
			Getenv: os.Getenv,
		})
		if result.Stderr != "" {
			_, _ = fmt.Fprint(os.Stderr, result.Stderr)
		}
		_, _ = fmt.Fprint(os.Stdout, result.Stdout)
		return
	}
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
