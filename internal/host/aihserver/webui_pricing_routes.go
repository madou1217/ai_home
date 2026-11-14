package aihserver

import (
	"context"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/pluginhost"
	"github.com/madou1217/ai_home/internal/runtime/pricingcatalog"
	"github.com/madou1217/ai_home/internal/transport/http/webuipricingapi"
)

const pricingHTTPTimeout = 20 * time.Second

// webuiPricingPorts 允许组合根或测试注入自定义定价服务与 HTTP 客户端。
type webuiPricingPorts struct {
	Service                *pricingcatalog.Service
	HTTPClient             pricingcatalog.HTTPClient
	Now                    func() time.Time
	CollectPluginSnapshots func(ctx context.Context, timeoutMs int) []pricingcatalog.PluginSnapshotInput
}

// newPricingSnapshotCollector 构造基于 Go pluginhost.Service 的 pricing.catalog 快照采集回调。
func newPricingSnapshotCollector(
	hostService *pluginhost.Service,
) func(ctx context.Context, timeoutMs int) []pricingcatalog.PluginSnapshotInput {
	if hostService == nil {
		return nil
	}
	return func(ctx context.Context, timeoutMs int) []pricingcatalog.PluginSnapshotInput {
		var timeout time.Duration
		if timeoutMs > 0 {
			timeout = time.Duration(timeoutMs) * time.Millisecond
		}
		return hostService.CollectPricingSnapshots(ctx, timeout)
	}
}

// buildWebUIPricingRoutes 装配价格目录、复核队列、社区价格采集与报价合并的全部 WebUI 路由：
//   - GET  /v1/management/webui/pricing/sources
//   - GET  /v1/management/webui/pricing/reviews
//   - GET  /v1/management/webui/pricing/status
//   - POST /v1/management/webui/pricing/refresh
//   - POST /v1/management/webui/pricing/approve
//   - POST /v1/management/webui/pricing/reject
//   - POST /v1/management/webui/pricing/merge-quotes
func buildWebUIPricingRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	return buildWebUIPricingRoutesWithPorts(dependencies, webuiPricingPorts{})
}

func buildWebUIPricingRoutesWithPorts(
	dependencies webuiRouteDependencies,
	ports webuiPricingPorts,
) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil {
		return nil, nil
	}

	service := ports.Service
	if service == nil {
		service = dependencies.PricingService
	}
	if service == nil {
		aiHome := strings.TrimSpace(dependencies.AIHomeDir)
		hostHome := strings.TrimSpace(dependencies.HostHomeDir)
		if aiHome == "" && hostHome != "" {
			aiHome = filepath.Join(hostHome, ".ai_home")
		}
		store, err := pricingcatalog.NewStore(aiHome)
		if err != nil {
			return nil, fmt.Errorf("创建价格目录存储失败: %w", err)
		}
		httpClient := ports.HTTPClient
		if httpClient == nil {
			httpClient = &http.Client{Timeout: pricingHTTPTimeout}
		}
		service, err = pricingcatalog.NewService(pricingcatalog.ServiceDependencies{
			Store:      store,
			HTTPClient: httpClient,
			Now:        ports.Now,
		})
		if err != nil {
			return nil, fmt.Errorf("创建价格目录服务失败: %w", err)
		}
	}

	collectPluginSnapshots := ports.CollectPluginSnapshots
	if collectPluginSnapshots == nil {
		collectPluginSnapshots = newPricingSnapshotCollector(dependencies.PluginHostService)
	}
	handler, err := webuipricingapi.NewHandler(webuipricingapi.Dependencies{
		Authorizer:             dependencies.Authorizer,
		Service:                service,
		CollectPluginSnapshots: collectPluginSnapshots,
	})
	if err != nil {
		return nil, fmt.Errorf("创建价格管理接口失败: %w", err)
	}

	return []webuiRoute{
		{Pattern: "GET " + webuipricingapi.SourcesPath, Handler: handler},
		{Pattern: "GET " + webuipricingapi.ReviewsPath, Handler: handler},
		{Pattern: "GET " + webuipricingapi.StatusPath, Handler: handler},
		{Pattern: "POST " + webuipricingapi.RefreshPath, Handler: handler},
		{Pattern: "POST " + webuipricingapi.ApprovePath, Handler: handler},
		{Pattern: "POST " + webuipricingapi.RejectPath, Handler: handler},
		{Pattern: "POST " + webuipricingapi.MergeQuotesPath, Handler: handler},
	}, nil
}
