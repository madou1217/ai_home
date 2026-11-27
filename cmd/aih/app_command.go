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
	"os"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/launcher"
	"github.com/madou1217/ai_home/internal/adapters/launcherstore"
	"github.com/madou1217/ai_home/internal/runtime/appcatalog"
	"github.com/madou1217/ai_home/internal/runtime/applaunch"
	"github.com/madou1217/ai_home/internal/runtime/appproxyregion"
	"github.com/madou1217/ai_home/internal/runtime/appproxyserve"
	"github.com/madou1217/ai_home/internal/runtime/appsessions"
	"github.com/madou1217/ai_home/internal/runtime/proxyserve"
)

type appOptions struct {
	proxy         bool
	proxyURL      string
	proxySelector string
	list          bool
	history       bool
	status        bool
	refresh       bool
	json          bool
	query         string
}

func runAppCommand(ctx context.Context, args []string, runtime commandRuntime) error {
	options := appOptions{}
	var positional []string
	for index := 0; index < len(args); index++ {
		arg := args[index]
		switch {
		case arg == "--proxy":
			options.proxy = true
			if index+1 < len(args) && !strings.HasPrefix(args[index+1], "-") {
				index++
				options.proxySelector = args[index]
			}
		case strings.HasPrefix(arg, "--proxy="):
			options.proxy = true
			options.proxySelector = strings.TrimPrefix(arg, "--proxy=")
		case arg == "--proxy-selector" && index+1 < len(args):
			index++
			options.proxySelector = args[index]
		case strings.HasPrefix(arg, "--proxy-selector="):
			options.proxySelector = strings.TrimPrefix(arg, "--proxy-selector=")
		case arg == "--list":
			options.list = true
		case arg == "--history":
			options.history = true
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
			_, _ = fmt.Fprintln(runtime.stdout, "用法: aih app [<应用名或前缀>] [--proxy[=<选择器|地区范围>]] [--proxy-url <url>] [--list] [--history] [--status] [--refresh] [--json]")
			_, _ = fmt.Fprintln(runtime.stdout, "  --proxy 裸旗标走本机 6152；带值启动独立临时入口：")
			_, _ = fmt.Fprintln(runtime.stdout, "    地区范围 us,sg / jp / us,jp,exclude:cn；或节点 ID、节点名、auto、pool。")
			_, _ = fmt.Fprintln(runtime.stdout, "  无参数：运行中的实例看台；--history 查看已结束的历史。")
			return nil
		case strings.HasPrefix(arg, "-"):
			return fmt.Errorf("未知参数: %s", arg)
		default:
			positional = append(positional, arg)
		}
	}
	options.query = strings.TrimSpace(strings.Join(positional, " "))
	options.proxyURL = strings.TrimSpace(options.proxyURL)
	options.proxySelector = strings.TrimSpace(options.proxySelector)
	if options.proxyURL != "" {
		options.proxy = true
	}
	if options.proxySelector != "" {
		options.proxy = true
	}
	if options.proxyURL != "" && options.proxySelector != "" {
		return fmt.Errorf("--proxy 选择器与 --proxy-url 只能指定一个")
	}
	if strings.ContainsAny(options.proxySelector, "\r\n\x00") {
		return fmt.Errorf("--proxy 选择器无效")
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

	if options.history && options.query != "" {
		return fmt.Errorf("--history 不能与应用名一起使用")
	}
	// 无参数：应用看台（通过 aih app 启动过的实例）。
	if options.history {
		history, err := appsessions.New(homeDir).History(ctx)
		if err != nil {
			return err
		}
		history = appproxyregion.Enrich(ctx, history, homeDir)
		renderAppHistory(runtime.stdout, history, options.json)
		return nil
	}
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
	entry := appproxyserve.Entry{}
	var provider *appproxyserve.Provider
	if options.proxy {
		switch {
		case options.proxySelector != "":
			// 节点/地区选择需要独占上游：为本次启动拉起一个随机端口的临时入口，
			// 不复用 6152（常驻入口的 selector 固定，多个 App 会互相改出口）。
			key, _ := runtime.lookupEnv("AIH_SERVER_MANAGEMENT_KEY")
			executable, execErr := os.Executable()
			if execErr != nil {
				return fmt.Errorf("无法定位 aih 可执行文件: %w", execErr)
			}
			provider = appproxyserve.New(proxyserve.Options{
				AIHomeDir:     homeDir,
				ServerURL:     resolveManagementBaseURL(runtime),
				ManagementKey: func() string { return key },
				CLIPath:       executable,
			})
			ensured, ensureErr := provider.Ensure(ctx, options.proxySelector)
			if ensureErr != nil {
				return fmt.Errorf("无法为「%s」启动临时入口: %w", options.proxySelector, ensureErr)
			}
			entry = ensured
			proxyURL = entry.URL
		case options.proxyURL != "":
			proxyURL = options.proxyURL
		default:
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
		if provider != nil {
			provider.Stop(options.proxySelector)
		}
		return err
	}
	store := appsessions.New(homeDir)
	instance := appsessions.NewInstance(
		app,
		appsessions.ExecutableFor(app),
		profileDir,
		proxyURL,
		string(mode),
	)
	if entry.Selector != "" {
		instance.ProxySelector = entry.Selector
		instance.ProxyPID = entry.PID
		instance.ProxyCountry = entry.Country
		instance.ProxyCity = entry.CityCode
		instance.ProxyRegion = entry.Region
	} else {
		instance.ProxyCountry, instance.ProxyCity, instance.ProxyRegion = appproxyregion.Resolve(ctx, homeDir, proxyURL)
	}
	if _, recordErr := store.Add(ctx, instance); recordErr != nil {
		_, _ = fmt.Fprintf(runtime.stderr, "[aih] 未能记录本次启动: %v\n", recordErr)
	}

	if options.json {
		payload, _ := json.MarshalIndent(map[string]any{
			"ok":            true,
			"app":           app,
			"proxyUrl":      proxyURL,
			"proxyMode":     mode,
			"proxyLabel":    mode.Label(),
			"proxySelector": entry.Selector,
			"proxyRegion":   entry.Region,
			"proxyPid":      entry.PID,
		}, "", "  ")
		_, _ = fmt.Fprintln(runtime.stdout, string(payload))
		return nil
	}
	if proxyURL == "" {
		_, _ = fmt.Fprintf(runtime.stdout, "已启动 %s（独立实例，未挂代理）\n", app.Name)
		return nil
	}
	if entry.Selector != "" {
		region := entry.Region
		if region == "" {
			region = "地区待解析"
		}
		_, _ = fmt.Fprintf(runtime.stdout, "已启动 %s（独立实例，选择器 %s · %s，代理 %s，%s）\n", app.Name, entry.Selector, region, proxyURL, mode.Label())
	} else {
		_, _ = fmt.Fprintf(runtime.stdout, "已启动 %s（独立实例，代理 %s，%s）\n", app.Name, proxyURL, mode.Label())
	}
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
