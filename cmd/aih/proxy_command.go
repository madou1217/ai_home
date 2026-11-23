package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/proxytransport"
)

// runProxyCommand 把远端 AIH 出口租约变成本机代理入口。
//
// 传输层（SSH/未来 connector）与出口层分开；本命令只负责租约、本地入口和
// 可选的系统代理写入，不自动修改系统配置，除非显式 --system。
func runProxyCommand(_ context.Context, arguments []string, runtime commandRuntime) error {
	if len(arguments) == 0 || arguments[0] == "help" || arguments[0] == "--help" || arguments[0] == "-h" {
		writeProxyCommandUsage(runtime)
		return nil
	}
	if arguments[0] != "serve" {
		return errors.New("用法: aih proxy serve [--selector auto|pool|ssh:<id>|节点ID] [--server URL | --ssh <connectionId>] [--no-socks] [--system --system-service <name>] [--json]")
	}
	return runProxyServe(arguments[1:], runtime)
}

func writeProxyCommandUsage(runtime commandRuntime) {
	_, _ = fmt.Fprintln(runtime.stdout, "用法: aih proxy serve [--selector auto|pool|ssh:<id>|节点ID] [--server URL | --ssh <connectionId>] [--no-socks] [--system --system-service <name>] [--system-dry-run] [--json]")
	_, _ = fmt.Fprintln(runtime.stdout, "")
	_, _ = fmt.Fprintln(runtime.stdout, "通过远端 AIH Server 的代理租约，在当前主机建立 loopback HTTP 与 SOCKS5 代理入口。")
	_, _ = fmt.Fprintln(runtime.stdout, "需要 AIH_SERVER_MANAGEMENT_KEY；--server 直达管理面，--ssh 自动建立本地转发。")
	_, _ = fmt.Fprintln(runtime.stdout, "--system 显式写入系统 HTTP/HTTPS 代理，退出时恢复；macOS 必须指定 --system-service。")
	_, _ = fmt.Fprintln(runtime.stdout, "命令持续运行，Ctrl+C 释放租约；不会修改系统代理，除非指定 --system。")
}

type proxyServeOptions struct {
	selector      string
	server        string
	ssh           string
	sshRemote     string
	listen        string
	noSocks       bool
	system        bool
	systemService string
	systemDryRun  bool
	renewInterval time.Duration
	json          bool
}

func parseProxyServeOptions(args []string) (proxyServeOptions, error) {
	options := proxyServeOptions{selector: "auto", sshRemote: proxytransport.DefaultRemoteAddress, listen: proxytransport.DefaultListenAddress, renewInterval: 30 * time.Minute}
	flags := flag.NewFlagSet("proxy serve", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	flags.StringVar(&options.selector, "selector", "auto", "代理选择器：auto、pool、ssh:<connectionId> 或节点 ID")
	flags.StringVar(&options.server, "server", "", "远端 AIH Server 管理面地址；缺省读取 AIH_SERVER_BASE_URL")
	flags.StringVar(&options.ssh, "ssh", "", "用已保存的 SSH 连接建立本地转发（连接 ID）")
	flags.StringVar(&options.sshRemote, "ssh-remote-address", proxytransport.DefaultRemoteAddress, "SSH 远端 AIH 管理面 loopback 地址")
	flags.StringVar(&options.listen, "listen", proxytransport.DefaultListenAddress, "SSH 本地转发监听地址（仅 loopback）")
	flags.BoolVar(&options.noSocks, "no-socks", false, "不启动本地 SOCKS5 入口，只提供 HTTP 代理")
	flags.BoolVar(&options.system, "system", false, "把入口写入系统 HTTP/HTTPS 代理，退出时恢复")
	flags.StringVar(&options.systemService, "system-service", "", "系统网络服务名（macOS 必填，例如 Wi-Fi）")
	flags.BoolVar(&options.systemDryRun, "system-dry-run", false, "只打印系统代理动作，不实际修改")
	flags.DurationVar(&options.renewInterval, "renew-interval", 30*time.Minute, "租约续期间隔；0 表示关闭续期")
	flags.BoolVar(&options.json, "json", false, "以 JSON 输出入口信息")
	if err := flags.Parse(args); err != nil {
		return options, err
	}
	if flags.NArg() != 0 {
		return options, errors.New("proxy serve 不接受位置参数")
	}
	options.selector = strings.TrimSpace(options.selector)
	options.server = strings.TrimSpace(options.server)
	options.ssh = strings.TrimSpace(options.ssh)
	options.sshRemote = strings.TrimSpace(options.sshRemote)
	options.listen = strings.TrimSpace(options.listen)
	options.systemService = strings.TrimSpace(options.systemService)
	if options.selector == "" || strings.ContainsAny(options.selector, "\r\n\x00") {
		return options, errors.New("--selector 无效")
	}
	if options.server != "" && options.ssh != "" {
		return options, errors.New("--server 与 --ssh 只能选择一个")
	}
	if options.server != "" {
		parsed, err := url.Parse(options.server)
		if err != nil || parsed == nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return options, errors.New("--server 必须是有效的 HTTP(S) 管理面地址")
		}
	}
	if options.ssh == "" && (options.sshRemote != proxytransport.DefaultRemoteAddress || options.listen != proxytransport.DefaultListenAddress) {
		return options, errors.New("--ssh-remote-address/--listen 需要配合 --ssh 使用")
	}
	if options.systemDryRun && !options.system {
		return options, errors.New("--system-dry-run 需要配合 --system 使用")
	}
	if options.systemService != "" && !options.system {
		return options, errors.New("--system-service 需要配合 --system 使用")
	}
	if options.renewInterval < 0 {
		return options, errors.New("--renew-interval 不能为负数")
	}
	return options, nil
}

func runProxyServe(args []string, runtime commandRuntime) (err error) {
	options, err := parseProxyServeOptions(args)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var transport proxytransport.Transport
	base := options.server
	if options.ssh != "" {
		transport, err = openSSHTransport(ctx, runtime, options.ssh, options.listen, options.sshRemote)
		if err != nil {
			return err
		}
		defer func() { _ = transport.Close() }()
		base = transport.BaseURL()
	}
	if base != "" {
		original := runtime.lookupEnv
		runtime.lookupEnv = func(key string) (string, bool) {
			if key == "AIH_SERVER_BASE_URL" {
				return base, true
			}
			return original(key)
		}
	}
	lease, err := acquireServeLease(ctx, runtime, options.selector, !options.noSocks)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := lease.Close(); closeErr != nil && err == nil {
			err = closeErr
		}
	}()
	if options.system {
		systemAddress, ingressErr := lease.startSystemIngress(ctx)
		if ingressErr != nil {
			return ingressErr
		}
		restore, applyErr := applySystemProxy(ctx, runtime, systemAddress, options.systemService, options.systemDryRun)
		if applyErr != nil {
			return applyErr
		}
		if restore != nil {
			defer restore()
		}
	}
	if options.json {
		encoded, marshalErr := json.MarshalIndent(map[string]any{
			"ok":            true,
			"httpUrl":       lease.httpURL,
			"socks5Url":     lease.socksURL,
			"name":          lease.name,
			"selector":      options.selector,
			"systemProxy":   options.system,
			"systemService": options.systemService,
		}, "", "  ")
		if marshalErr != nil {
			return marshalErr
		}
		_, _ = fmt.Fprintln(runtime.stdout, string(encoded))
	} else {
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] HTTP 代理入口：%s\n", lease.httpURL)
		if lease.socksURL != "" {
			_, _ = fmt.Fprintf(runtime.stdout, "[aih] SOCKS5 代理入口：%s\n", lease.socksURL)
		}
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] 出口：%s\n", lease.name)
		allProxy := lease.httpURL
		if lease.socksURL != "" {
			allProxy = lease.socksURL
		}
		_, _ = fmt.Fprintf(runtime.stdout, "export HTTP_PROXY='%s' HTTPS_PROXY='%s' ALL_PROXY='%s'\n", lease.httpURL, lease.httpURL, allProxy)
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] 按 Ctrl+C 结束并释放租约。")
	}
	leaseErr := make(chan error, 1)
	if options.renewInterval > 0 {
		go lease.keepAlive(ctx, options.renewInterval, func(renewErr error) {
			select {
			case leaseErr <- renewErr:
			default:
			}
		})
	}
	select {
	case <-ctx.Done():
	case renewErr := <-leaseErr:
		return fmt.Errorf("代理租约续期失败: %w", renewErr)
	}
	stop()
	return nil
}
