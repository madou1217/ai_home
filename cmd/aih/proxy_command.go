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
func runProxyCommand(ctx context.Context, arguments []string, runtime commandRuntime) error {
	if len(arguments) == 0 || arguments[0] == "help" || arguments[0] == "--help" || arguments[0] == "-h" {
		writeProxyCommandUsage(runtime)
		return nil
	}
	if arguments[0] == "service" {
		return runProxyServiceCommand(ctx, arguments[1:], runtime)
	}
	if arguments[0] != "serve" {
		return errors.New("用法: aih proxy serve [...] 或 aih proxy service <install|uninstall|status>")
	}
	return runProxyServe(arguments[1:], runtime)
}

func writeProxyCommandUsage(runtime commandRuntime) {
	_, _ = fmt.Fprintln(runtime.stdout, "用法: aih proxy serve [--selector auto|pool|ssh:<id>|节点ID] [--server URL | --ssh <connectionId> | --peer <connectionId>] [--no-socks] [--system --system-service <name>] [--system-dry-run] [--json]")
	_, _ = fmt.Fprintln(runtime.stdout, "")
	_, _ = fmt.Fprintln(runtime.stdout, "通过远端 AIH Server 的代理租约，在当前主机建立 loopback HTTP 与 SOCKS5 代理入口。")
	_, _ = fmt.Fprintln(runtime.stdout, "需要 AIH_SERVER_MANAGEMENT_KEY；--server 直达管理面，--ssh 自动建立本地转发。")
	_, _ = fmt.Fprintln(runtime.stdout, "--peer 在远端 AIH 上启动代理入口并经 SSH 转发到本机，不需要远端管理密钥；--peer-via 可指定跳板。")
	_, _ = fmt.Fprintln(runtime.stdout, "--system 显式写入系统 HTTP/HTTPS 代理，退出时恢复；macOS 必须指定 --system-service。")
	_, _ = fmt.Fprintln(runtime.stdout, "命令持续运行，Ctrl+C 释放租约；不会修改系统代理，除非指定 --system。")
}

type proxyServeOptions struct {
	selector          string
	server            string
	ssh               string
	sshVia            string
	sshRemote         string
	listen            string
	peer              string
	peerVia           string
	peerAih           string
	noSocks           bool
	system            bool
	systemService     string
	systemDryRun      bool
	systemForce       bool
	renewInterval     time.Duration
	managementKeyFile string

	tun            bool
	tunInterface   string
	tunAddresses   string
	tunMTU         int
	tunNoAutoRoute bool
	tunStrictRoute bool
	tunStack       string
	tunDNS         string
	tunSingBox     string
	tunLogFile     string
	tunDryRun      bool

	// exitOnStdinEOF 只供 --peer 的远端子进程使用：控制连接关闭时优雅退出并释放租约。
	exitOnStdinEOF bool
	// exitWithParent 由 launchd/systemd 的包装器追加：监督进程消失时优雅退出。
	exitWithParent bool
	json           bool
}

func parseProxyServeOptions(args []string) (proxyServeOptions, error) {
	options := proxyServeOptions{selector: "auto", sshRemote: proxytransport.DefaultRemoteAddress, listen: proxytransport.DefaultListenAddress, peerAih: "aih", renewInterval: 30 * time.Minute, tunMTU: 9000, tunStack: "system", tunDNS: "223.5.5.5"}
	flags := flag.NewFlagSet("proxy serve", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	flags.StringVar(&options.selector, "selector", "auto", "代理选择器：auto、pool、ssh:<connectionId> 或节点 ID")
	flags.StringVar(&options.server, "server", "", "远端 AIH Server 管理面地址；缺省读取 AIH_SERVER_BASE_URL")
	flags.StringVar(&options.ssh, "ssh", "", "用已保存的 SSH 连接建立本地转发（连接 ID）")
	flags.StringVar(&options.sshVia, "ssh-via", "", "可选的 SSH 跳板连接 ID（复用现有 mesh 链路）")
	flags.StringVar(&options.sshRemote, "ssh-remote-address", proxytransport.DefaultRemoteAddress, "SSH 远端 AIH 管理面 loopback 地址")
	flags.StringVar(&options.listen, "listen", proxytransport.DefaultListenAddress, "SSH 本地转发监听地址（仅 loopback）")
	flags.StringVar(&options.peer, "peer", "", "在远端 AIH 上启动代理入口并经 SSH 转发到本机（SSH 连接 ID）")
	flags.StringVar(&options.peerVia, "peer-via", "", "--peer 的可选 SSH 跳板连接 ID（复用现有 mesh 链路）")
	flags.StringVar(&options.peerAih, "peer-aih", "aih", "远端 aih 可执行文件路径（Windows 可传绝对路径）")
	flags.BoolVar(&options.noSocks, "no-socks", false, "不启动本地 SOCKS5 入口，只提供 HTTP 代理")
	flags.BoolVar(&options.system, "system", false, "把入口写入系统 HTTP/HTTPS 代理，退出时恢复")
	flags.StringVar(&options.systemService, "system-service", "", "系统网络服务名（macOS 必填，例如 Wi-Fi）")
	flags.BoolVar(&options.systemDryRun, "system-dry-run", false, "只打印系统代理动作，不实际修改")
	flags.BoolVar(&options.systemForce, "system-force", false, "即使已有系统代理也强制接管（默认不抢占）")
	flags.DurationVar(&options.renewInterval, "renew-interval", 30*time.Minute, "租约续期间隔；0 表示关闭续期")
	flags.StringVar(&options.managementKeyFile, "management-key-file", "", "从 0600 文件读取 Management Key（服务模式使用）")
	flags.BoolVar(&options.tun, "tun", false, "显式创建本地 TUN 并接管系统流量（需要 root/管理员）")
	flags.StringVar(&options.tunInterface, "tun-interface", "", "TUN 接口名；空值由 sing-box 选择")
	flags.StringVar(&options.tunAddresses, "tun-address", "", "TUN 地址 CIDR，逗号分隔；空值使用 172.19.0.1/30")
	flags.IntVar(&options.tunMTU, "tun-mtu", 9000, "TUN MTU")
	flags.BoolVar(&options.tunNoAutoRoute, "tun-no-auto-route", false, "不安装 TUN 路由（只创建接口，不接管流量）")
	flags.BoolVar(&options.tunStrictRoute, "tun-strict-route", false, "启用 sing-box strict_route")
	flags.StringVar(&options.tunStack, "tun-stack", "system", "TUN 栈：system/gvisor/mixed")
	flags.StringVar(&options.tunDNS, "tun-dns", "223.5.5.5", "TUN 直连 DNS 服务器 IP")
	flags.StringVar(&options.tunSingBox, "tun-singbox", "", "sing-box 内核路径；空值自动发现")
	flags.StringVar(&options.tunLogFile, "tun-log-file", "", "TUN 内核日志路径；空值使用 <aiHome>/logs/proxy-tun.log")
	flags.BoolVar(&options.tunDryRun, "tun-dry-run", false, "只生成并校验 TUN 配置，不创建接口、不改路由")
	flags.BoolVar(&options.exitOnStdinEOF, "exit-on-stdin-eof", false, "stdin 关闭时退出（--peer 远端子进程使用）")
	flags.BoolVar(&options.json, "json", false, "以 JSON 输出入口信息")
	// launchd/systemd 的 autostart 会追加该监督器参数：包装器被 SIGKILL 时
	// 子进程要自行发现父进程已消失，走与 Ctrl+C 相同的优雅退出路径。
	flags.BoolVar(&options.exitWithParent, "exit-with-parent", false, "父监督进程退出后优雅关闭并释放租约")
	if err := flags.Parse(args); err != nil {
		return options, err
	}
	if flags.NArg() != 0 {
		return options, errors.New("proxy serve 不接受位置参数")
	}
	options.selector = strings.TrimSpace(options.selector)
	options.server = strings.TrimSpace(options.server)
	options.ssh = strings.TrimSpace(options.ssh)
	options.sshVia = strings.TrimSpace(options.sshVia)
	options.sshRemote = strings.TrimSpace(options.sshRemote)
	options.listen = strings.TrimSpace(options.listen)
	options.peer = strings.TrimSpace(options.peer)
	options.peerVia = strings.TrimSpace(options.peerVia)
	options.peerAih = strings.TrimSpace(options.peerAih)
	options.systemService = strings.TrimSpace(options.systemService)
	options.managementKeyFile = strings.TrimSpace(options.managementKeyFile)
	if options.selector == "" || strings.ContainsAny(options.selector, "\r\n\x00") {
		return options, errors.New("--selector 无效")
	}
	if countNonEmpty(options.server, options.ssh, options.peer) > 1 {
		return options, errors.New("--server、--ssh 与 --peer 只能选择一个")
	}
	if options.server != "" {
		parsed, err := url.Parse(options.server)
		if err != nil || parsed == nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
			return options, errors.New("--server 必须是有效的 HTTP(S) 管理面地址")
		}
	}
	if options.peerVia != "" && options.peer == "" {
		return options, errors.New("--peer-via 需要配合 --peer 使用")
	}
	if options.peerAih == "" {
		return options, errors.New("--peer-aih 不能为空")
	}
	if options.peer == "" && options.peerAih != "aih" {
		return options, errors.New("--peer-aih 需要配合 --peer 使用")
	}
	if options.peer != "" && options.sshVia != "" {
		return options, errors.New("--ssh-via 不适用于 --peer；请使用 --peer-via")
	}
	if options.peer != "" && options.sshRemote != proxytransport.DefaultRemoteAddress {
		return options, errors.New("--ssh-remote-address 不适用于 --peer")
	}
	if options.peer != "" && (options.system || options.tun || options.systemService != "" || options.systemDryRun || options.systemForce || options.tunDryRun) {
		return options, errors.New("--peer 只转发远端入口，不支持在本机执行 --system/--tun")
	}
	if options.peer == "" && options.ssh == "" && (options.sshVia != "" || options.sshRemote != proxytransport.DefaultRemoteAddress || options.listen != proxytransport.DefaultListenAddress) {
		return options, errors.New("--ssh-via/--ssh-remote-address/--listen 需要配合 --ssh 或 --peer 使用")
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
	if options.tunDryRun && !options.tun {
		return options, errors.New("--tun-dry-run 需要配合 --tun 使用")
	}
	if !options.tun && (options.tunInterface != "" || options.tunAddresses != "" || options.tunSingBox != "" || options.tunLogFile != "" || options.tunNoAutoRoute || options.tunStrictRoute || options.tunStack != "system" || options.tunDNS != "223.5.5.5" || options.tunMTU != 9000) {
		return options, errors.New("TUN 相关参数需要配合 --tun 使用")
	}
	return options, nil
}

func countNonEmpty(values ...string) int {
	count := 0
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			count++
		}
	}
	return count
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
	if options.exitWithParent {
		// 包装器被杀时它无法转发信号；由子进程自己发现父进程消失。
		go watchParentProcess(ctx, os.Getppid(), stop)
	}
	if options.exitOnStdinEOF {
		// 对等模式：stdin 来自 SSH 会话；控制连接断开时读端 EOF，按 Ctrl+C 同一路径
		// 取消 ctx，让 defer 释放远端租约并关闭入口，不依赖平台信号。
		go func() {
			buffer := make([]byte, 256)
			for {
				if _, readErr := runtime.stdin.Read(buffer); readErr != nil {
					stop()
					return
				}
			}
		}()
	}
	if options.managementKeyFile != "" {
		key, keyErr := readManagementKeyFile(options.managementKeyFile)
		if keyErr != nil {
			return keyErr
		}
		original := runtime.lookupEnv
		runtime.lookupEnv = func(envKey string) (string, bool) {
			if envKey == "AIH_SERVER_MANAGEMENT_KEY" {
				return key, true
			}
			return original(envKey)
		}
	}
	if options.peer != "" {
		return runProxyServePeer(ctx, options, runtime)
	}

	var transport proxytransport.Transport
	base := options.server
	if options.ssh != "" {
		transport, err = openSSHTransport(ctx, runtime, options.ssh, options.listen, options.sshRemote, options.sshVia)
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
	unit, err := newServeEntryUnit(ctx, runtime, options)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := unit.Close(); closeErr != nil && err == nil {
			err = closeErr
		}
	}()
	lease := unit.lease
	tunDone := unit.tunDone
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
		writeServeEntrySummary(runtime, options, lease)
	}
	// 续期失败时，只有 auto/pool 允许自动换出口并重建整套入口；显式点名的
	// 节点等于用户选定出口，换掉就是静默改变出口 IP。
	rotation := serveRotation(ctx, runtime, options.selector, func(message string) {
		_, _ = fmt.Fprintln(runtime.stderr, message)
	})
	leaseErr := make(chan error, 1)
	if options.renewInterval > 0 {
		go lease.keepAlive(ctx, options.renewInterval, func(renewErr error) {
			select {
			case leaseErr <- renewErr:
			default:
			}
		})
	}
	for {
		select {
		case <-ctx.Done():
			stop()
			return nil
		case <-tunDone:
			return errors.New("TUN 内核已退出，代理入口随之关闭")
		case renewErr := <-leaseErr:
			if rotation == nil || !isLeaseLossError(renewErr) {
				return fmt.Errorf("代理租约续期失败: %w", renewErr)
			}
			_, _ = fmt.Fprintf(runtime.stderr, "[aih] 出口已失效（%v），正在自动切换…\n", renewErr)
			// 先拆旧入口再建新的：同一个常驻服务只能有一个有效入口。
			_ = unit.Close()
			next, name, healErr := rotateServeEntry(ctx, runtime, options, rotation, renewErr.Error())
			if healErr != nil {
				return fmt.Errorf("出口切换失败: %w", healErr)
			}
			unit, lease = next, next.lease
			tunDone = next.tunDone
			if name != "" {
				_, _ = fmt.Fprintf(runtime.stderr, "[aih] 已切换到出口 %s（入口已重建）。\n", name)
			}
			if options.json {
				continue
			}
			writeServeEntrySummary(runtime, options, lease)
			go lease.keepAlive(ctx, options.renewInterval, func(nextErr error) {
				select {
				case leaseErr <- nextErr:
				default:
				}
			})
		}
	}
}

// writeServeEntrySummary 打印当前入口与一次性 export 行。
func writeServeEntrySummary(runtime commandRuntime, options proxyServeOptions, lease *serveLease) {
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
