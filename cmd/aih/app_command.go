package main

// `aih app`：列出本机应用并按需只给本次启动的实例挂代理。
//
// 应用清单与 alt+space 工作台（`application/launcher` + `appcatalog`）同源：
// 扫描、去重、别名、排序与图标都由工作台目录提供，CLI / TAB 补全 / WebUI
// 不再各自维护候选。代理只影响本次启动的进程：Chromium 系用
// --proxy-server + 独立 profile，其它应用注入代理环境变量（尽力而为）。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/launcher"
	"github.com/madou1217/ai_home/internal/adapters/launcherstore"
	"github.com/madou1217/ai_home/internal/runtime/appcatalog"
	"github.com/madou1217/ai_home/internal/runtime/applaunch"
	"github.com/madou1217/ai_home/internal/runtime/appsessions"
)

type appOptions struct {
	proxy    bool
	proxyURL string
	list     bool
	status   bool
	refresh  bool
	json     bool
	query    string
}

func runAppCommand(ctx context.Context, args []string, runtime commandRuntime) error {
	options := appOptions{}
	var positional []string
	for index := 0; index < len(args); index++ {
		arg := args[index]
		switch {
		case arg == "--proxy":
			options.proxy = true
		case arg == "--list":
			options.list = true
		case arg == "--status":
			options.status = true
		case arg == "--refresh":
			options.refresh = true
		case arg == "--json":
			options.json = true
		case strings.HasPrefix(arg, "--proxy-url="):
			options.proxyURL = strings.TrimPrefix(arg, "--proxy-url=")
		case arg == "--proxy-url" && index+1 < len(args):
			index++
			options.proxyURL = args[index]
		case arg == "-h" || arg == "--help":
			_, _ = fmt.Fprintln(runtime.stdout, "用法: aih app [<应用名或前缀>] [--proxy] [--proxy-url <url>] [--list] [--status] [--refresh] [--json]")
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

	homeDir, err := resolveLauncherAIHomeDir(runtime)
	if err != nil {
		return err
	}
	if options.list || options.query != "" {
		store, err := launcherstore.New(homeDir)
		if err != nil {
			return err
		}
		catalog := appcatalog.NewWithOptions(appcatalog.Options{CachePath: appcatalog.CachePath(homeDir)})
		service, err := launcher.NewService(catalog, applaunch.New(), store, time.Now)
		if err != nil {
			return err
		}
		result, err := service.List(ctx, launcher.ListOptions{
			Query:   options.query,
			Refresh: options.refresh,
			Limit:   launcher.DefaultLimit,
		})
		if err != nil {
			return err
		}
		if options.list {
			printApps(runtime, result, options.json)
			return nil
		}
		app, resolveErr := launcher.ResolveQuery(result.Apps, options.query)
		if resolveErr != nil {
			if errors.Is(resolveErr, launcher.ErrQueryAmbiguous) || len(result.Apps) > 0 {
				printAppMatches(runtime, result.Apps)
				_, _ = fmt.Fprintln(runtime.stderr, "[aih] 匹配不唯一或过于宽泛，请写得更具体")
				return cliExitCode{code: 1}
			}
			return fmt.Errorf("没有匹配「%s」的本机应用；用 aih app --list 查看", options.query)
		}
		return launchAppWithRecord(ctx, runtime, homeDir, app, options)
	}

	// 无参数：应用看台（通过 aih app 启动过的实例）。
	if options.json {
		state := &appDeskState{marked: map[string]bool{}}
		state.refresh(ctx, appsessions.New(homeDir), homeDir)
		renderAppDeskJSON(runtime.stdout, state, homeDir)
		return nil
	}
	return runAppDashboard(ctx, runtime, homeDir, options.status)
}

// launchAppWithRecord starts one independent instance and records it for the desk.
func launchAppWithRecord(ctx context.Context, runtime commandRuntime, homeDir string, app launcher.App, options appOptions) error {
	proxyURL := ""
	if options.proxy {
		proxyURL = options.proxyURL
		if proxyURL == "" {
			proxyURL = applaunch.DefaultProxyURL(homeDir)
		}
	}
	profileDir := applaunch.ProfileDir(app, proxyURL, homeDir)
	mode, err := applaunch.New().OpenWithProxy(ctx, app, applaunch.ProxyOptions{
		URL:         proxyURL,
		AIHomeDir:   homeDir,
		ProfileDir:  profileDir,
		Independent: true,
	})
	if err != nil {
		return err
	}
	store := appsessions.New(homeDir)
	if _, recordErr := store.Add(ctx, appsessions.NewInstance(
		app,
		appsessions.ExecutableFor(app),
		profileDir,
		proxyURL,
		string(mode),
	)); recordErr != nil {
		_, _ = fmt.Fprintf(runtime.stderr, "[aih] 未能记录本次启动: %v\n", recordErr)
	}

	if options.json {
		payload, _ := json.MarshalIndent(map[string]any{
			"ok":         true,
			"app":        app,
			"proxyUrl":   proxyURL,
			"proxyMode":  mode,
			"proxyLabel": mode.Label(),
		}, "", "  ")
		_, _ = fmt.Fprintln(runtime.stdout, string(payload))
		return nil
	}
	if proxyURL == "" {
		_, _ = fmt.Fprintf(runtime.stdout, "已启动 %s（独立实例，未挂代理）\n", app.Name)
		return nil
	}
	_, _ = fmt.Fprintf(runtime.stdout, "已启动 %s（独立实例，代理 %s，%s）\n", app.Name, proxyURL, mode.Label())
	if mode == applaunch.ProxyModeEnvironment {
		_, _ = fmt.Fprintln(runtime.stderr, "[aih] 该应用通过环境变量读取代理；若它不读取 HTTP(S)_PROXY，代理不会生效")
	}
	return nil
}

func printApps(runtime commandRuntime, result launcher.ListResult, asJSON bool) {
	if asJSON {
		payload, _ := json.MarshalIndent(map[string]any{
			"ok":          true,
			"platform":    result.Platform,
			"generatedAt": result.GeneratedAt,
			"apps":        result.Apps,
		}, "", "  ")
		_, _ = fmt.Fprintln(runtime.stdout, string(payload))
		return
	}
	if len(result.Apps) == 0 {
		_, _ = fmt.Fprintln(runtime.stdout, "(没有找到应用)")
		return
	}
	for _, app := range result.Apps {
		mode := applaunch.ProxyModeFor(app)
		_, _ = fmt.Fprintf(runtime.stdout, "%-32s %-10s %-16s %s\n", app.Name, app.Kind, mode.Label(), app.Path)
	}
	if result.Truncated {
		_, _ = fmt.Fprintf(runtime.stdout, "(已截断到 %d 个应用)\n", len(result.Apps))
	}
}

func printAppMatches(runtime commandRuntime, apps []launcher.App) {
	for index, app := range apps {
		if index >= 20 {
			break
		}
		_, _ = fmt.Fprintf(runtime.stdout, "%-32s %s\n", app.Name, app.Path)
	}
}
