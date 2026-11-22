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
)

// runProxyCommand 提供把远端 AIH 出口租约变成当前主机本地代理入口的命令。
//
// 传输层不属于本命令：Server 可以经 SSH 本地转发、内网或网络连接器到达；
// 本命令只负责管理面租约与 loopback HTTP 入口，便于系统代理/任意应用复用。
func runProxyCommand(ctx context.Context, arguments []string, runtime commandRuntime) error {
	if len(arguments) == 0 || arguments[0] == "help" || arguments[0] == "--help" || arguments[0] == "-h" {
		writeProxyCommandUsage(runtime)
		return nil
	}
	if arguments[0] != "serve" {
		return errors.New("用法: aih proxy serve [--selector auto|pool|ssh:<id>|节点ID] [--server URL] [--json]")
	}
	return runProxyServe(ctx, arguments[1:], runtime)
}

func writeProxyCommandUsage(runtime commandRuntime) {
	_, _ = fmt.Fprintln(runtime.stdout, "用法: aih proxy serve [--selector auto|pool|ssh:<id>|节点ID] [--server URL | --ssh <connectionId>] [--json]")
	_, _ = fmt.Fprintln(runtime.stdout, "")
	_, _ = fmt.Fprintln(runtime.stdout, "通过远端 AIH Server 的代理租约，在当前主机建立 127.0.0.1 HTTP 代理入口。")
	_, _ = fmt.Fprintln(runtime.stdout, "需要 AIH_SERVER_MANAGEMENT_KEY；--server 未指定时使用 AIH_SERVER_BASE_URL。")
	_, _ = fmt.Fprintln(runtime.stdout, "--ssh 使用本机已保存的 SSH 连接自动建立本地转发；--server 则直接连接可达的管理面。")
	_, _ = fmt.Fprintln(runtime.stdout, "命令持续运行，Ctrl+C 释放租约；不会自动修改系统代理。")
}

type proxyServeOptions struct {
	selector  string
	server    string
	ssh       string
	sshRemote string
	listen    string
	json      bool
}

func parseProxyServeOptions(args []string) (proxyServeOptions, error) {
	options := proxyServeOptions{selector: "auto", sshRemote: "127.0.0.1:9527", listen: "127.0.0.1:0"}
	flags := flag.NewFlagSet("proxy serve", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	flags.StringVar(&options.selector, "selector", "auto", "代理选择器：auto、pool、ssh:<connectionId> 或节点 ID")
	flags.StringVar(&options.server, "server", "", "远端 AIH Server 管理面地址；缺省读取 AIH_SERVER_BASE_URL")
	flags.StringVar(&options.ssh, "ssh", "", "用已保存的 SSH 连接建立本地转发（连接 ID）")
	flags.StringVar(&options.sshRemote, "ssh-remote-address", "127.0.0.1:9527", "SSH 远端 AIH 管理面 loopback 地址")
	flags.StringVar(&options.listen, "listen", "127.0.0.1:0", "SSH 本地转发监听地址（仅 loopback）")
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
	if options.ssh == "" && (options.sshRemote != "127.0.0.1:9527" || options.listen != "127.0.0.1:0") {
		return options, errors.New("--ssh-remote-address/--listen 需要配合 --ssh 使用")
	}
	return options, nil
}

func runProxyServe(parent context.Context, args []string, runtime commandRuntime) (err error) {
	options, err := parseProxyServeOptions(args)
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if parent == nil {
		parent = context.Background()
	}
	ctx, stop := signal.NotifyContext(parent, os.Interrupt, syscall.SIGTERM)
	defer stop()
	if options.server != "" || options.ssh != "" {
		base := options.server
		if options.ssh != "" {
			forward, forwardErr := openSSHLocalForward(ctx, runtime, options.ssh, options.listen, options.sshRemote)
			if forwardErr != nil {
				return forwardErr
			}
			defer func() { _ = forward.Close() }()
			base = forward.URL()
		}
		original := runtime.lookupEnv
		runtime.lookupEnv = func(key string) (string, bool) {
			if key == "AIH_SERVER_BASE_URL" {
				return base, true
			}
			return original(key)
		}
	}
	lease, err := acquireProviderProxy(ctx, runtime, options.selector)
	if err != nil {
		return err
	}
	defer func() {
		if closeErr := lease.Close(); closeErr != nil && err == nil {
			err = closeErr
		}
	}()
	if options.json {
		encoded, marshalErr := json.MarshalIndent(map[string]any{
			"ok": true, "url": lease.URL, "name": lease.Name, "selector": options.selector,
		}, "", "  ")
		if marshalErr != nil {
			return marshalErr
		}
		_, _ = fmt.Fprintln(runtime.stdout, string(encoded))
	} else {
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] 代理入口已就绪：%s\n", lease.URL)
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] 出口：%s\n", lease.Name)
		_, _ = fmt.Fprintf(runtime.stdout, "export HTTP_PROXY='%s' HTTPS_PROXY='%s' ALL_PROXY='%s'\n", lease.URL, lease.URL, lease.URL)
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] 按 Ctrl+C 结束并释放租约。")
	}
	<-ctx.Done()
	stop()
	return nil
}
