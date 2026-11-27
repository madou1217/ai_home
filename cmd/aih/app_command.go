package main

// `aih app`：列出本机应用并按需只给本次启动的实例挂代理。
//
// 代理不写系统设置，也不复用已有实例：macOS 用 `open -n`，Chromium 系浏览器
// 再附加 --proxy-server 与独立 user-data-dir；普通应用用 --env 注入代理环境
// 变量。这样同一应用可以同时开一个带代理、一个不带代理的实例。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/appcatalog"
)

type appOptions struct {
	proxy    bool
	proxyURL string
	list     bool
	json     bool
	query    string
}

func runAppCommand(_ context.Context, args []string, runtime commandRuntime) error {
	options := appOptions{}
	var positional []string
	for index := 0; index < len(args); index++ {
		arg := args[index]
		switch {
		case arg == "--proxy":
			options.proxy = true
		case arg == "--list":
			options.list = true
		case arg == "--json":
			options.json = true
		case strings.HasPrefix(arg, "--proxy-url="):
			options.proxyURL = strings.TrimPrefix(arg, "--proxy-url=")
		case arg == "--proxy-url" && index+1 < len(args):
			index++
			options.proxyURL = args[index]
		case arg == "-h" || arg == "--help":
			_, _ = fmt.Fprintln(runtime.stdout, "用法: aih app [<应用名或前缀>] [--proxy] [--proxy-url <url>] [--list] [--json]")
			return nil
		case strings.HasPrefix(arg, "-"):
			return fmt.Errorf("未知参数: %s", arg)
		default:
			positional = append(positional, arg)
		}
	}
	options.query = strings.TrimSpace(strings.Join(positional, " "))
	options.proxyURL = strings.TrimSpace(options.proxyURL)
	if options.proxyURL != "" {
		options.proxy = true
	}

	apps, err := appcatalog.List()
	if err != nil {
		return err
	}
	if options.list || options.query == "" {
		printApps(runtime, apps, options.json)
		return nil
	}

	app, resolveErr := appcatalog.Resolve(options.query)
	if resolveErr != nil {
		if errors.Is(resolveErr, appcatalog.ErrAmbiguous) {
			printAppMatches(runtime, apps, options.query)
			_, _ = fmt.Fprintf(runtime.stderr, "[aih] 匹配到多个应用，请写得更具体\n")
			return cliExitCode{code: 1}
		}
		return resolveErr
	}

	proxyURL := ""
	if options.proxy {
		proxyURL = options.proxyURL
		if proxyURL == "" {
			proxyURL = appcatalog.DefaultProxyURL()
		}
		if proxyURL == "" {
			return errors.New("没有可用的本机代理入口；先运行 aih proxy serve")
		}
	}
	if err := appcatalog.Launch(app, appcatalog.LaunchOptions{ProxyURL: proxyURL}); err != nil {
		return err
	}
	if options.json {
		payload, _ := json.MarshalIndent(map[string]any{
			"ok":       true,
			"app":      app,
			"proxyUrl": proxyURL,
		}, "", "  ")
		_, _ = fmt.Fprintln(runtime.stdout, string(payload))
		return nil
	}
	if proxyURL == "" {
		_, _ = fmt.Fprintf(runtime.stdout, "已启动 %s（未挂代理）\n", app.Name)
	} else {
		_, _ = fmt.Fprintf(runtime.stdout, "已启动 %s（独立实例，代理 %s）\n", app.Name, proxyURL)
	}
	return nil
}

func printApps(runtime commandRuntime, apps []appcatalog.App, asJSON bool) {
	if asJSON {
		payload, _ := json.MarshalIndent(map[string]any{"ok": true, "apps": apps}, "", "  ")
		_, _ = fmt.Fprintln(runtime.stdout, string(payload))
		return
	}
	for _, app := range apps {
		label := app.Name
		if app.Chromium {
			label += "  [浏览器]"
		}
		_, _ = fmt.Fprintf(runtime.stdout, "%-32s %s\n", label, app.Path)
	}
}

func printAppMatches(runtime commandRuntime, apps []appcatalog.App, query string) {
	lower := strings.ToLower(strings.TrimSpace(query))
	for _, app := range apps {
		if strings.Contains(strings.ToLower(app.Name), lower) {
			_, _ = fmt.Fprintf(runtime.stdout, "%-32s %s\n", app.Name, app.Path)
		}
	}
}

