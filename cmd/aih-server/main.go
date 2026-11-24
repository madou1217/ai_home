package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/accountdeletionmarker"
	"github.com/madou1217/ai_home/internal/runtime/chatruntime/approvaltool"
	"github.com/madou1217/ai_home/internal/runtime/providersessionhook"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshapi"
)

// main 把操作系统信号转换为 Go Server 的优雅关闭上下文，并把同一个取消动作
// 交给管理端点：Windows 上 `child.kill('SIGTERM')` 实际是 TerminateProcess，
// 宿主只能靠这条进程内路径触发优雅关闭。
func main() {
	raiseFileDescriptorLimit()
	for _, argument := range os.Args[1:] {
		if argument == "--exit-with-parent" {
			watchParent()
			break
		}
	}
	if len(os.Args) > 1 && os.Args[1] == "__usage-facts" {
		if err := runUsageFacts(os.Args[2:]); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, "aih usage facts:", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "__distribution-update" {
		if err := runDistributionUpdate(os.Args[2:]); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, "[aih]", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "__distribution-apply" {
		if err := runDistributionApply(os.Args[2:]); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, "[aih]", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "__distribution-install" {
		if err := runDistribution(os.Args[2:]); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, "[aih]", err)
			os.Exit(1)
		}
		return
	}

	if len(os.Args) > 1 && os.Args[1] == "__account-deletion-marker" {
		if err := accountdeletionmarker.Run(os.Getenv("AIH_HOME_DIR"), os.Stdin); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, "aih deletion marker:", err)
			os.Exit(1)
		}
		return
	}

	if len(os.Args) > 1 && os.Args[1] == "__codex-metadata" {
		if err := runCodexMetadata(os.Args[2:]); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, "aih codex metadata:", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "__codex-state-page" {
		if err := runCodexStatePage(os.Args[2:]); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, "aih codex state page:", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "__codex-notifications" {
		if err := runCodexNotifications(os.Args[2:]); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, "aih codex notifications:", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "__codex-rollout-read" {
		if err := runCodexRolloutRead(os.Args[2:]); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, "aih codex rollout:", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "__codex-exec-intent" {
		if err := runCodexExecIntent(os.Args[2:]); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, "aih codex exec intent:", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "__codex-local-app-server" {
		if err := runCodexLocalAppServer(os.Args[2:]); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, "aih local codex:", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "__codex-resume-proxy" {
		if err := runCodexResumeProxy(os.Args[2:]); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, "aih codex resume proxy:", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "__codex-remote-control" {
		if err := runCodexRemoteControl(os.Args[2:]); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, "aih codex remote control:", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "__desktop-translation" {
		if err := runDesktopTranslation(os.Args[2:]); err != nil {
			_, _ = fmt.Fprintln(os.Stderr, "aih desktop:", err)
			os.Exit(1)
		}
		return
	}
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
	// 共享 MCP 桥 daemon：由会话启动路径按需拉起，空闲后自行退出。
	if len(os.Args) > 1 && os.Args[1] == "__mcp-bridge-daemon" {
		flags := flag.NewFlagSet("__mcp-bridge-daemon", flag.ContinueOnError)
		socketPath := flags.String("socket", "", "unix socket path")
		idle := flags.Duration("idle", 5*time.Minute, "idle timeout")
		if err := flags.Parse(os.Args[2:]); err != nil || strings.TrimSpace(*socketPath) == "" {
			_, _ = fmt.Fprintln(os.Stderr, "aih-server __mcp-bridge-daemon: --socket is required")
			os.Exit(2)
		}
		if err := webuisshapi.RunMCPBridgeDaemon(*socketPath, *idle); err != nil {
			_, _ = fmt.Fprintf(os.Stderr, "aih-server __mcp-bridge-daemon: %v\n", err)
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
