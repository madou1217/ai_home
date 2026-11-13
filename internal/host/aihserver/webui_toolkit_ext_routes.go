package aihserver

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/edgeproxy"
	"github.com/madou1217/ai_home/internal/runtime/nativeresources"
	"github.com/madou1217/ai_home/internal/runtime/providerconfigs"
	"github.com/madou1217/ai_home/internal/runtime/subaggregator"
	"github.com/madou1217/ai_home/internal/transport/http/webuitoolkitextapi"
)

// buildWebUIToolkitExtRoutes 装配 Toolkit 扩展四项管理能力对应的全部 Go WebUI 路由：
//   - 本机边缘入口转发：/v1/management/webui/toolkit/edge*
//   - Provider 配置文件工作台：/v1/management/webui/toolkit/provider-configs*
//   - 原生资源探测与生命周期：/v1/management/webui/toolkit/native-resources
//   - 订阅聚合器、同步进度 SSE 与本机中转：/v1/management/webui/toolkit/subscription-aggregator*
func buildWebUIToolkitExtRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil {
		return nil, nil
	}

	aiHome := strings.TrimSpace(dependencies.AIHomeDir)
	hostHome := strings.TrimSpace(dependencies.HostHomeDir)
	if hostHome == "" {
		if resolvedHome, homeErr := os.UserHomeDir(); homeErr == nil {
			hostHome = resolvedHome
		}
	}
	if aiHome == "" && hostHome != "" {
		aiHome = filepath.Join(hostHome, ".ai_home")
	}

	catalog := dependencies.Catalog
	if catalog == nil {
		built, err := providers.NewCatalog(providers.BuiltinManifest())
		if err != nil {
			return nil, fmt.Errorf("初始化 Toolkit 扩展 Provider 目录失败: %w", err)
		}
		catalog = built
	}

	edgeSvc := edgeproxy.NewService()
	providerConfigSvc := providerconfigs.NewService(catalog, hostHome, aiHome)

	var nativeResourceSvc *nativeresources.Service
	if aiHome != "" && hostHome != "" {
		svc, err := nativeresources.NewService(nativeresources.Config{
			AIHomeDir:   aiHome,
			HostHomeDir: hostHome,
			Catalog:     catalog,
		})
		if err != nil {
			return nil, fmt.Errorf("创建原生资源管理服务失败: %w", err)
		}
		nativeResourceSvc = svc
	}

	var subAggSvc *subaggregator.Service
	if aiHome != "" {
		subAggSvc = subaggregator.NewService(aiHome, subaggregator.ServiceOptions{
			HostHomeDir: hostHome,
		})
	}

	handler, err := webuitoolkitextapi.NewHandler(webuitoolkitextapi.Dependencies{
		Authorizer:      dependencies.Authorizer,
		Edge:            edgeSvc,
		ProviderConfigs: providerConfigSvc,
		NativeResources: nativeResourceSvc,
		SubAggregator:   subAggSvc,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 Toolkit 扩展 WebUI 接口失败: %w", err)
	}

	return []webuiRoute{
		// 边缘代理（frp / nginx / caddy）
		{Pattern: "GET " + webuitoolkitextapi.EdgePath, Handler: handler},
		{Pattern: "GET " + webuitoolkitextapi.EdgePlanPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitextapi.EdgeApplyPath, Handler: handler},

		// Provider 配置文件工作台
		{Pattern: "GET " + webuitoolkitextapi.ProviderConfigsPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitextapi.ProviderConfigFilePath, Handler: handler},
		{Pattern: "PUT " + webuitoolkitextapi.ProviderConfigFilePath, Handler: handler},
		{Pattern: "POST " + webuitoolkitextapi.ProviderConfigValidatePath, Handler: handler},
		{Pattern: "GET " + webuitoolkitextapi.ProviderConfigHistoryPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitextapi.ProviderConfigHistoryEntryPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitextapi.ProviderConfigHistoryRestorePath, Handler: handler},
		{Pattern: "GET " + webuitoolkitextapi.ProviderConfigExportPath, Handler: handler},

		// 原生资源探测与生命周期操作
		{Pattern: "GET " + webuitoolkitextapi.NativeResourcesPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitextapi.NativeResourcesPath, Handler: handler},

		// 订阅聚合器管理面与同步进度 SSE
		{Pattern: "GET " + webuitoolkitextapi.SubAggregatorPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitextapi.SubAggregatorLocalClientsPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitextapi.SubAggregatorLocalSourcesPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitextapi.SubAggregatorLocalSourcesImportPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitextapi.SubAggregatorSourcesSyncWatchPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitextapi.SubAggregatorRelayPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitextapi.SubAggregatorProfilesPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitextapi.SubAggregatorProfileNodesPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitextapi.SubAggregatorProfileTestRoutePath, Handler: handler},
		{Pattern: "POST " + webuitoolkitextapi.SubAggregatorProbePath, Handler: handler},
		{Pattern: "POST " + webuitoolkitextapi.SubAggregatorNodesParsePath, Handler: handler},
		{Pattern: "GET " + webuitoolkitextapi.SubAggregatorNodesPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitextapi.SubAggregatorNodesChainPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitextapi.SubAggregatorSourcesPreviewPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitextapi.SubAggregatorSourcesPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitextapi.SubAggregatorSourcesSyncPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitextapi.SubAggregatorProfileTokenPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitextapi.SubAggregatorProfilePreviewPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitextapi.SubAggregatorProfileImportLinksPath, Handler: handler},
		{Pattern: "DELETE " + webuitoolkitextapi.SubAggregatorProfileItemPath, Handler: handler},
		{Pattern: "GET " + webuitoolkitextapi.SubAggregatorSourceNodesPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitextapi.SubAggregatorSourceLatencyPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitextapi.SubAggregatorSourceSyncPath, Handler: handler},
		{Pattern: "POST " + webuitoolkitextapi.SubAggregatorSourceEnabledPath, Handler: handler},
		{Pattern: "DELETE " + webuitoolkitextapi.SubAggregatorSourceItemPath, Handler: handler},
	}, nil
}
