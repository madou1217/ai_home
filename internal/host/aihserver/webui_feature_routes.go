package aihserver

import (
	accountactivityadapter "github.com/madou1217/ai_home/internal/adapters/accountactivity"
	"github.com/madou1217/ai_home/internal/runtime/taskhub"
	"github.com/madou1217/ai_home/internal/transport/http/webuitoolkitenvapi"
)

// webuiFeatureRoutePorts 收拢功能路由需要、但在总装函数里提前构造的本地句柄。
type webuiFeatureRoutePorts struct {
	OpsHub                    *taskhub.Hub
	ToolkitEnvironmentActions *webuitoolkitenvapi.Handler
	ActivityService           *accountactivityadapter.Service
	SSHRoutes                 []webuiRoute
}

// appendWebUIFeatureRoutes 按域装配功能路由。
//
// 从 buildWebUIRoutes 拆出：新增一个功能路由组只改这里，不再触碰
// 路由总装函数和它的静态路由表。
func appendWebUIFeatureRoutes(routes []webuiRoute, dependencies webuiRouteDependencies, ports webuiFeatureRoutePorts) ([]webuiRoute, error) {
	refreshRoutes, err := buildWebUIRefreshRoutes(dependencies)
	if err != nil {
		return nil, err
	}
	routes = append(routes, refreshRoutes...)
	clientKeyRoutes, err := buildWebUIClientKeyRoutes(dependencies)
	if err != nil {
		return nil, err
	}
	routes = append(routes, clientKeyRoutes...)
	accountAuthRoutes, err := buildWebUIAccountAuthRoutes(dependencies)
	if err != nil {
		return nil, err
	}
	routes = append(routes, accountAuthRoutes...)
	accountBrowserRoutes, err := buildWebUIAccountBrowserRoutes(dependencies)
	if err != nil {
		return nil, err
	}
	routes = append(routes, accountBrowserRoutes...)
	accountBrowserLiveRoutes, err := buildWebUIAccountBrowserLiveRoutes(dependencies)
	if err != nil {
		return nil, err
	}
	routes = append(routes, accountBrowserLiveRoutes...)
	// kimi 的套餐统计与桌面端托管登录：路由/上游协议都在 Go，Node 只做透传。
	kimiRoutes, err := buildWebUIKimiRoutes(dependencies)
	if err != nil {
		return nil, err
	}
	routes = append(routes, kimiRoutes...)
	// 会话监听、Provider Hook 事件接收与恢复归档切 Go，不再依赖 Node sessionEventBus。
	sessionsWatchRoutes, err := buildWebUISessionsWatchRoutes(dependencies)
	if err != nil {
		return nil, err
	}
	routes = append(routes, sessionsWatchRoutes...)
	// 项目管理、工作区文件/媒体/信任、Git 状态与工作区模型目录切 Go，不再依赖 Node 本地扫描与回退。
	projectsFSRoutes, err := buildWebUIProjectsFSRoutes(dependencies)
	if err != nil {
		return nil, err
	}
	routes = append(routes, projectsFSRoutes...)
	// OpenAI 模型目录写改删查/监听与上游错误映射组管理切 Go，Node 只做透传。
	modelsRulesRoutes, err := buildWebUIModelsRulesRoutes(dependencies)
	if err != nil {
		return nil, err
	}
	routes = append(routes, modelsRulesRoutes...)
	// AI 翻译与 Image Studio 生图工作台全量切 Go，Node 只做薄代理。
	translationStudioRoutes, err := BuildWebUITranslationStudioRoutesWithOptions(dependencies, TranslationGatewayOptions{
		GatewayHandler: dependencies.TranslationGateway,
		ClientKey:      dependencies.ClientKey,
	})
	if err != nil {
		return nil, err
	}
	routes = append(routes, translationStudioRoutes...)
	// peer / 账号结果 / 活跃任务 / 计划任务 / Codex 重置卡 / 重启全量切 Go。
	opsMiscRoutes, err := buildWebUIOpsMiscRoutesWithPorts(dependencies, webuiOpsMiscPorts{
		Hub:             ports.OpsHub,
		EnvironmentJobs: ports.ToolkitEnvironmentActions.Jobs(),
		ActivityService: ports.ActivityService,
	})
	if err != nil {
		return nil, err
	}
	routes = append(routes, opsMiscRoutes...)
	// GeoIP 资源、出口池、上游地区策略与账号出口分配全量切 Go。
	egressGeoRoutes, err := buildWebUIEgressGeoRoutes(dependencies)
	if err != nil {
		return nil, err
	}
	routes = append(routes, egressGeoRoutes...)
	// 本机代理入口：由核心承接会话生命周期，插件只提供出口引擎能力。
	proxyServeRoutes, err := buildWebUIProxyServeRoutes(dependencies)
	if err != nil {
		return nil, err
	}
	routes = append(routes, proxyServeRoutes...)
	routes = append(routes, ports.SSHRoutes...)
	// SSH 开发机与远程工作区补齐 POST 探测 / 浏览 / 工作区 CRUD 与工作区终端。
	sshExtraRoutes, err := buildWebUISSHExtraRoutesWithPorts(dependencies, webUISSHPorts{
		TerminalHandler: dependencies.TerminalHandler,
	})
	if err != nil {
		return nil, err
	}
	routes = append(routes, sshExtraRoutes...)
	// node-rpc、聊天附件与 legacy 聊天会话全量切 Go。
	nodeRPCChatLegacyRoutes, err := buildWebUINodeRPCChatLegacyRoutes(dependencies)
	if err != nil {
		return nil, err
	}
	routes = append(routes, nodeRPCChatLegacyRoutes...)
	// 价格目录、人工复核队列、社区价格采集与报价合并全量切 Go。
	pricingRoutes, err := buildWebUIPricingRoutes(dependencies)
	if err != nil {
		return nil, err
	}
	routes = append(routes, pricingRoutes...)
	// 插件诊断、调试调用、插件报价刷新与账号插件管理路由统一由 Go pluginhost.Service 承接。
	pluginRoutes, err := buildWebUIPluginRoutesWithHostService(dependencies, dependencies.PluginHostService)
	if err != nil {
		return nil, err
	}
	routes = append(routes, pluginRoutes...)
	// Toolkit 扩展工作台（Edge 代理、Provider 配置、原生资源、订阅聚合）全量切 Go。
	toolkitExtRoutes, err := buildWebUIToolkitExtRoutes(dependencies)
	if err != nil {
		return nil, err
	}
	routes = append(routes, toolkitExtRoutes...)
	// Toolkit 核心能力（镜像测速、代理与连通性、受管工具/服务、客户端终端、应用清单/安装任务）全量切 Go。
	toolkitCoreRoutes, err := buildWebUIToolkitCoreRoutes(dependencies)
	if err != nil {
		return nil, err
	}
	routes = append(routes, toolkitCoreRoutes...)
	codexHooksRoutes, err := buildWebUICodexHooksRoutesWithRuntime(dependencies, dependencies.CodexHooks)
	if err != nil {
		return nil, err
	}
	routes = append(routes, codexHooksRoutes...)
	// Provider CLI 自动升级与窗口激活调度器路由统一由 webui_scheduler_routes 装配。
	schedulerRoutes, err := buildWebUISchedulerRoutesWithPorts(dependencies, webuiSchedulerPorts{
		UpgradeScheduler:   dependencies.UpgradeScheduler,
		WindowScheduler:    dependencies.WindowScheduler,
		SkipSchedulerStart: true,
	})
	if err != nil {
		return nil, err
	}
	routes = append(routes, schedulerRoutes...)
	managementOpsRoutes, err := buildWebUIManagementOpsRoutesWithPorts(dependencies, webuiManagementOpsPorts{
		Metrics:          newManagementMetricsPort(dependencies.MetricsRecorder),
		StartedAt:        dependencies.StartedAt,
		WarmUsageRollups: true,
	})
	if err != nil {
		return nil, err
	}
	routes = append(routes, managementOpsRoutes...)
	routingWeightsRoutes, err := buildWebUIRoutingWeightsRoutes(dependencies)
	if err != nil {
		return nil, err
	}
	routes = append(routes, routingWeightsRoutes...)
	loginJobRoutes, err := buildWebUILoginJobsRoutes(dependencies)
	if err != nil {
		return nil, err
	}
	routes = append(routes, loginJobRoutes...)
	return routes, nil
}
