package aihserver

import (
	"context"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/apps"
	"github.com/madou1217/ai_home/internal/transport/http/webuiopenappapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuitoolkitcoreapi"
)

// buildWebUIToolkitCoreRoutes 装配 WebUI 工具箱核心能力（镜像测速、代理与连通性、
// 受管工具及服务控制、客户端终端、应用清单/配置/Hook/打开及统一安装任务）路由。
func buildWebUIToolkitCoreRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil {
		return nil, nil
	}

	var defaultAccountResolver webuitoolkitcoreapi.DefaultAccountResolver
	if dependencies.ProviderDefaults != nil {
		defaults := dependencies.ProviderDefaults
		defaultAccountResolver = func(ctx context.Context, provider string) string {
			pd, err := defaults.Get(ctx, provider)
			if err != nil {
				return ""
			}
			return strings.TrimSpace(pd.AccountRef().String())
		}
	}

	// 工具箱的 app-open 与账号页共用同一个 Go 原生启动器，不经过 Node。
	var appLauncher webuiopenappapi.Launcher = newWebUIOpenAppLauncher(dependencies)

	// 安装/更新代理复用管理面同一套候选：CLI 通过 HTTP 管理 API 取租约，
	// WebUI 作业在本进程取租约，二者最终都落到 updateproxy.Environment。
	var installProxyResolver apps.InstallProxyResolver
	if dependencies.ProxyRuntime != nil {
		proxyRuntime := dependencies.ProxyRuntime
		installProxyResolver = func(ctx context.Context, selector string) (apps.InstallProxyLease, error) {
			view, err := proxyRuntime.Acquire(ctx, selector)
			if err != nil {
				return apps.InstallProxyLease{}, err
			}
			id := view.ID
			return apps.InstallProxyLease{
				URL:  view.ProxyURL,
				Name: view.Name,
				Release: func() {
					proxyRuntime.Release(id)
				},
			}, nil
		}
	}

	handler, err := webuitoolkitcoreapi.NewHandler(webuitoolkitcoreapi.Dependencies{
		Authorizer:             dependencies.Authorizer,
		AIHomeDir:              dependencies.AIHomeDir,
		HostHomeDir:            dependencies.HostHomeDir,
		Catalog:                dependencies.Catalog,
		DefaultAccountResolver: defaultAccountResolver,
		AppLauncher:            appLauncher,
		InstallProxyResolver:   installProxyResolver,
	})
	if err != nil {
		return nil, err
	}

	return []webuiRoute{
		// 浏览器数据面由 router 的 mountPublicManagementAliases 统一生成，
		// 这里只声明管理路径，避免两份路由表漂移。
		{Pattern: "GET " + webuitoolkitcoreapi.MirrorsPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitcoreapi.MirrorsSetPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitcoreapi.MirrorsPingPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitcoreapi.ProxyPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitcoreapi.ProxySetPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitcoreapi.ConnectivityPath, Handler: handler},

		{Pattern: "GET " + webuitoolkitcoreapi.ToolsPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitcoreapi.ToolsPlanPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitcoreapi.ToolsExecutePath, Handler: handler},
		{Pattern: "GET " + webuitoolkitcoreapi.ToolsJobsPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitcoreapi.ToolsJobsWatchPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitcoreapi.ToolsSubtreePath, Handler: handler},
		{Pattern: "POST " + webuitoolkitcoreapi.ToolsSubtreePath, Handler: handler},
		{Pattern: "PUT " + webuitoolkitcoreapi.ToolsSubtreePath, Handler: handler},

		{Pattern: "GET " + webuitoolkitcoreapi.TerminalsRootPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitcoreapi.ToolkitTerminalsPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitcoreapi.TerminalsPlanPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitcoreapi.TerminalsExecutePath, Handler: handler},
		{Pattern: "POST " + webuitoolkitcoreapi.TerminalsOpenPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitcoreapi.TerminalsJobsWatchPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitcoreapi.TerminalsJobPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitcoreapi.TerminalsJobWatchPath, Handler: handler},

		{Pattern: "GET " + webuitoolkitcoreapi.AppsPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitcoreapi.AppConfigPath, Handler: handler},
		{Pattern: "PUT " + webuitoolkitcoreapi.AppConfigPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitcoreapi.AppCheckUpdatePath, Handler: handler},
		{Pattern: "POST " + webuitoolkitcoreapi.AppOpenPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitcoreapi.AppsInstallPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitcoreapi.AppsPlanPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitcoreapi.AppsHooksPath, Handler: handler},

		{Pattern: "POST " + webuitoolkitcoreapi.AppInstallPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitcoreapi.AppInstallJobsPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitcoreapi.AppInstallJobsWatchPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitcoreapi.AppInstallJobPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitcoreapi.AppInstallJobWatchPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitcoreapi.AppInstallJobCancelPath, Handler: handler},
	}, nil
}
