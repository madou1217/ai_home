package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/madou1217/ai_home/internal/runtime/chatruntime/approvaltool"
	"github.com/madou1217/ai_home/internal/runtime/providersessionhook"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshapi"
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
	// 远程工作区工具 MCP server：由 Claude/Codex 直接拉起，直接模式自己建 SSH。
	if len(os.Args) > 1 && os.Args[1] == "__mcp-remote-tools" {
		if err := webuisshapi.RunRemoteToolsMCP(os.Stdin, os.Stdout, os.Getenv); err != nil {
			_, _ = fmt.Fprintf(os.Stderr, "aih-server __mcp-remote-tools: %v\n", err)
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

	// 远程工作区原生终端：WebUI 用本二进制启动桌面终端，SSH/重连全在 Go 内完成。
	if len(os.Args) > 1 && os.Args[1] == "__remote-ws" {
		if len(os.Args) < 3 {
			_, _ = fmt.Fprintln(os.Stderr, "aih-server __remote-ws: 缺少工作区 ID")
			os.Exit(1)
		}
		sessionKey := ""
		if len(os.Args) > 3 {
			sessionKey = os.Args[3]
		}
		hostHomeDir := strings.TrimSpace(os.Getenv("HOME"))
		if hostHomeDir == "" {
			if resolved, err := os.UserHomeDir(); err == nil {
				hostHomeDir = resolved
			}
		}
		if err := webuisshapi.RunNativeRemoteWorkspace(ctx, webuisshapi.NativeRemoteOptions{
			AIHomeDir:    os.Getenv("AIH_HOME_DIR"),
			HostHomeDir:  hostHomeDir,
			WorkspaceID:  os.Args[2],
			SessionKey:   sessionKey,
			Stdin:        os.Stdin,
			Stdout:       os.Stdout,
			Stderr:       os.Stderr,
			TerminalSize: webuisshapi.LocalTerminalSize,
			WatchResize:  webuisshapi.WatchLocalTerminalResize,
		}); err != nil {
			_, _ = fmt.Fprintf(os.Stderr, "aih-server __remote-ws: %v\n", err)
			os.Exit(1)
		}
		return
	}

	if err := run(ctx, os.Args[1:], defaultCommandRuntime(cancel)); err != nil {
		_, _ = fmt.Fprintf(os.Stderr, "aih-server 启动失败: %v\n", err)
		os.Exit(1)
	}
}
