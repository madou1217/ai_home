package aihserver

import (
	"fmt"

	runtimegeo "github.com/madou1217/ai_home/internal/runtime/geo"
	"github.com/madou1217/ai_home/internal/transport/http/webuiegresspoolapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiegressupstreamsapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuigeoresourcesapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuipublicalias"
)

// buildWebUIEgressGeoRoutes 装配 GeoIP 数据资源、出口池、上游地区策略及账号出口分配全部 Go WebUI 路由。
func buildWebUIEgressGeoRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil {
		return nil, nil
	}

	geoManager := runtimegeo.NewJobManager(runtimegeo.JobManagerOptions{
		AIHomeDir: dependencies.AIHomeDir,
		HomeDir:   dependencies.HostHomeDir,
	})
	geoHandler, err := webuigeoresourcesapi.NewHandler(webuigeoresourcesapi.Dependencies{
		Authorizer: dependencies.Authorizer,
		Manager:    geoManager,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 GeoIP 资源接口失败: %w", err)
	}

	egressManager := dependencies.EgressManager
	if egressManager == nil {
		// 管理面不能静默新建第二个池实例：它没有 Catalog/EnginePlugins，也未 Start，
		// 语义与主实例不同。缺装配时直接失败，由组合根修复。
		return nil, fmt.Errorf("出口管理器未装配，拒绝创建第二个池实例")
	}

	poolHandler, err := webuiegresspoolapi.NewHandler(webuiegresspoolapi.Dependencies{
		Authorizer: dependencies.Authorizer,
		Manager:    egressManager,
	})
	if err != nil {
		return nil, fmt.Errorf("创建出口池接口失败: %w", err)
	}

	upstreamsHandler, err := webuiegressupstreamsapi.NewHandler(webuiegressupstreamsapi.Dependencies{
		Authorizer: dependencies.Authorizer,
		Manager:    egressManager,
	})
	if err != nil {
		return nil, fmt.Errorf("创建出口上游策略接口失败: %w", err)
	}

	return []webuiRoute{
		// GeoIP 数据资源与异步下载/删除作业 + SSE
		// 浏览器同构别名由 router 统一派生，这里只声明管理路径。
		{Pattern: "GET " + webuigeoresourcesapi.Path, Handler: geoHandler},
		{Pattern: "GET " + webuigeoresourcesapi.JobsPath, Handler: geoHandler},
		{Pattern: "POST " + webuigeoresourcesapi.JobsPath, Handler: geoHandler},
		{Pattern: "GET " + webuigeoresourcesapi.JobPath, Handler: geoHandler},
		{Pattern: "GET " + webuigeoresourcesapi.JobWatchPath, Handler: geoHandler},
		{Pattern: "POST " + webuigeoresourcesapi.JobCancelPath, Handler: geoHandler},

		// 出口池面板数据面、分页/ETag 与节点/策略操作
		{Pattern: "GET " + webuiegresspoolapi.Path, Handler: poolHandler},
		{Pattern: "POST " + webuiegresspoolapi.StartPath, Handler: poolHandler},
		{Pattern: "POST " + webuiegresspoolapi.StopPath, Handler: poolHandler},
		{Pattern: "POST " + webuiegresspoolapi.ProbePath, Handler: poolHandler},
		{Pattern: "GET " + webuiegresspoolapi.PolicyPath, Handler: poolHandler},
		{Pattern: "POST " + webuiegresspoolapi.PolicyPath, Handler: poolHandler},
		{Pattern: "POST " + webuiegresspoolapi.PolicyClearDisabledPath, Handler: poolHandler},
		{Pattern: "POST " + webuiegresspoolapi.NodeActionPath, Handler: poolHandler},
		{Pattern: "GET " + webuiegresspoolapi.GroupsPath, Handler: poolHandler},
		{Pattern: "GET " + webuiegresspoolapi.PoolsPath, Handler: poolHandler},
		{Pattern: "GET " + webuiegresspoolapi.PoolItemPath, Handler: poolHandler},
		{Pattern: "GET " + webuiegresspoolapi.NodeItemPath, Handler: poolHandler},
		{Pattern: "GET " + webuiegresspoolapi.EvidencePath, Handler: poolHandler},

		// 上游地区策略、网络位置刷新、上游探测、SSE 监听及账号级出口池分配
		{Pattern: "GET " + webuiegressupstreamsapi.UpstreamsPath, Handler: upstreamsHandler},
		{Pattern: "GET " + webuiegressupstreamsapi.UpstreamsPath + "/diagnostics", Handler: upstreamsHandler},
		{Pattern: "GET " + webuiegressupstreamsapi.UpstreamsPath + "/strategies", Handler: upstreamsHandler},
		{Pattern: "GET " + webuiegressupstreamsapi.UpstreamsPath + "/routing", Handler: upstreamsHandler},
		{Pattern: "PUT " + webuiegressupstreamsapi.UpstreamsPath + "/routing", Handler: upstreamsHandler},
		{Pattern: "POST " + webuiegressupstreamsapi.UpstreamsPath + "/routing", Handler: upstreamsHandler},
		{Pattern: "POST " + webuiegressupstreamsapi.UpstreamsPath + "/routing/test", Handler: upstreamsHandler},
		{Pattern: "GET " + webuiegressupstreamsapi.UpstreamsWatchPath, Handler: upstreamsHandler},
		{Pattern: "POST " + webuiegressupstreamsapi.NetworkRefreshPath, Handler: upstreamsHandler},
		{Pattern: "PUT " + webuiegressupstreamsapi.UpstreamItemPath, Handler: upstreamsHandler},
		{Pattern: "POST " + webuiegressupstreamsapi.UpstreamProbePath, Handler: upstreamsHandler},
		{Pattern: "POST " + webuiegressupstreamsapi.UpstreamProbeAccountPath, Handler: upstreamsHandler},
		{Pattern: "POST " + webuiegressupstreamsapi.UpstreamEvidenceResetPath, Handler: upstreamsHandler},
		{Pattern: "GET " + webuiegressupstreamsapi.AccountRuntimePath, Handler: upstreamsHandler},
		{Pattern: "PUT " + webuiegressupstreamsapi.AccountAssignmentPath, Handler: upstreamsHandler},
		// 浏览器数据面：账号出口池运行时/分配（路径少一级 egress 段）。
		{Pattern: "GET /v0/webui/accounts/{provider}/{accountRef}/egress-runtime", Handler: webuipublicalias.Rewrite("/v0/webui/accounts", "/v1/management/webui/egress/accounts", upstreamsHandler)},
		{Pattern: "PUT /v0/webui/accounts/{provider}/{accountRef}/egress-assignment", Handler: webuipublicalias.Rewrite("/v0/webui/accounts", "/v1/management/webui/egress/accounts", upstreamsHandler)},
	}, nil
}
