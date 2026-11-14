package aihserver

import (
	"context"
	"strings"

	"github.com/madou1217/ai_home/internal/transport/http/webuiopenappapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuipublicalias"
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

	var appLauncher webuiopenappapi.Launcher
	if launcher := webuiopenappapi.NewHostLauncher(webuiopenappapi.HostLauncherOptions{
		BaseURL:       dependencies.NodeBaseURL,
		ManagementKey: dependencies.ManagementKey,
	}); launcher != nil {
		appLauncher = launcher
	}

	handler, err := webuitoolkitcoreapi.NewHandler(webuitoolkitcoreapi.Dependencies{
		Authorizer:             dependencies.Authorizer,
		AIHomeDir:              dependencies.AIHomeDir,
		HostHomeDir:            dependencies.HostHomeDir,
		Catalog:                dependencies.Catalog,
		DefaultAccountResolver: defaultAccountResolver,
		AppLauncher:            appLauncher,
	})
	if err != nil {
		return nil, err
	}

	return []webuiRoute{
		{Pattern: "GET " + webuitoolkitcoreapi.MirrorsPath, Handler: handler},
		// 浏览器数据面：镜像/代理/连通性四条与 Go 管理路径同构，直接前缀重写。
		{Pattern: "GET /v0/webui/toolkit/mirrors", Handler: webuipublicalias.Rewrite("/v0/webui", "/v1/management/webui", handler)},
		{Pattern: "GET /v0/webui/toolkit/tools", Handler: webuipublicalias.Rewrite("/v0/webui", "/v1/management/webui", handler)},
		{Pattern: "GET /v0/webui/toolkit/apps", Handler: webuipublicalias.Rewrite("/v0/webui", "/v1/management/webui", handler)},

		{Pattern: "POST /v0/webui/toolkit/mirrors/set", Handler: webuipublicalias.Rewrite("/v0/webui", "/v1/management/webui", handler)},
		{Pattern: "POST /v0/webui/toolkit/mirrors/ping", Handler: webuipublicalias.Rewrite("/v0/webui", "/v1/management/webui", handler)},
		{Pattern: "GET /v0/webui/toolkit/proxy", Handler: webuipublicalias.Rewrite("/v0/webui", "/v1/management/webui", handler)},
		{Pattern: "POST /v0/webui/toolkit/proxy/set", Handler: webuipublicalias.Rewrite("/v0/webui", "/v1/management/webui", handler)},
		{Pattern: "GET /v0/webui/toolkit/connectivity", Handler: webuipublicalias.Rewrite("/v0/webui", "/v1/management/webui", handler)},

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
		// 浏览器数据面：/v0/webui/app-install* → 管理前缀（同一处理器）。
		{Pattern: "POST /v0/webui/app-install", Handler: webuipublicalias.Rewrite("/v0/webui", "/v1/management/webui", handler)},
		{Pattern: "GET /v0/webui/app-install/jobs", Handler: webuipublicalias.Rewrite("/v0/webui", "/v1/management/webui", handler)},
		{Pattern: "GET /v0/webui/app-install/jobs/{jobId}", Handler: webuipublicalias.Rewrite("/v0/webui", "/v1/management/webui", handler)},
		{Pattern: "POST /v0/webui/app-install/jobs/{jobId}/cancel", Handler: webuipublicalias.Rewrite("/v0/webui", "/v1/management/webui", handler)},
		{Pattern: "GET " + webuitoolkitcoreapi.AppInstallJobsPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitcoreapi.AppInstallJobsWatchPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitcoreapi.AppInstallJobPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitcoreapi.AppInstallJobWatchPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitcoreapi.AppInstallJobCancelPath, Handler: handler},
	}, nil
}
