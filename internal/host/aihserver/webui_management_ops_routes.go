package aihserver

import (
	"context"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/managementops"
	"github.com/madou1217/ai_home/internal/transport/http/webuimanagementapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiopenaimodelswriteapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuipublicalias"
	"github.com/madou1217/ai_home/internal/transport/http/webuiserverrestartapi"
)

// webuiManagementOpsPorts 允许组合根或测试注入实时指标、模型刷新器、重启桥或共享 UsageStore。
type webuiManagementOpsPorts struct {
	Service      *managementops.ManagementService
	UsageStore   *managementops.UsageStore
	AccountRows  managementops.AccountRowPort
	Metrics      managementops.MetricsSnapshotPort
	ModelCatalog managementops.ModelCatalogPort
	Restarter    managementops.ServerRestarterPort
	// RestartCommandResolver 覆盖平台服务管理器的重启命令探测；测试用它稳定制造无服务场景。
	RestartCommandResolver func() (string, []string, error)
	Host                   string
	Port                   int
	APIKeyConfigured       bool
	ProviderMode           string
	Strategy               string
	Now                    func() time.Time
	StartedAt              time.Time
}

type modelCatalogRefresherAdapter struct {
	refresher webuiopenaimodelswriteapi.Refresher
}

func (a modelCatalogRefresherAdapter) RefreshModels(ctx context.Context) (managementops.ModelRefreshOutcome, error) {
	if a.refresher == nil {
		return managementops.ModelRefreshOutcome{}, nil
	}
	res, err := a.refresher.Refresh(ctx)
	if err != nil {
		return managementops.ModelRefreshOutcome{
			UpdatedAtMS: res.UpdatedAtMS,
			FirstError:  err.Error(),
			Source:      "error",
		}, err
	}
	return managementops.ModelRefreshOutcome{
		UpdatedAtMS:     res.UpdatedAtMS,
		ScannedAccounts: res.Accounts,
		Sources:         res.Sources,
		Source:          res.Source,
		FirstError:      res.FirstError,
	}, nil
}

type serverRestarterAdapter struct {
	restarter webuiserverrestartapi.Restarter
	now       func() time.Time
}

func (a serverRestarterAdapter) RestartServer(ctx context.Context) (managementops.RestartResponse, error) {
	if a.restarter == nil {
		return managementops.RestartResponse{}, managementops.ErrRestartUnavailable
	}
	nowFn := a.now
	if nowFn == nil {
		nowFn = time.Now
	}
	createdAt := nowFn().UnixMilli()
	outcome, err := a.restarter.Restart(ctx, webuiserverrestartapi.RestartJob{
		ID:        fmt.Sprintf("mgmt-restart-%d", createdAt),
		Status:    "queued",
		CreatedAt: createdAt,
	})
	if err != nil {
		return managementops.RestartResponse{}, err
	}
	if outcome.Pending {
		return managementops.RestartResponse{
			OK: true, Action: "restart", PID: outcome.PID,
			// The worker is armed, not proof the server was stopped or its successor started.
			Stopped:       managementops.RestartStoppedStatus{Reason: "restart_pending"},
			AppliedConfig: outcome.AppliedConfig,
		}, nil
	}
	return managementops.RestartResponse{
		OK:            true,
		Action:        "restart",
		Running:       outcome.PID > 0,
		PID:           outcome.PID,
		Started:       outcome.PID > 0,
		AppliedConfig: outcome.AppliedConfig,
	}, nil
}

// buildWebUIManagementOpsRoutes 装配管理面核心监控、状态索引写同步、实时 SSE 与本地用量/扫描/看板查询路由。
func buildWebUIManagementOpsRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	return buildWebUIManagementOpsRoutesWithPorts(dependencies, webuiManagementOpsPorts{})
}

func buildWebUIManagementOpsRoutesWithPorts(
	dependencies webuiRouteDependencies,
	ports webuiManagementOpsPorts,
) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil {
		return nil, nil
	}
	nowFn := ports.Now
	if nowFn == nil {
		nowFn = time.Now
	}

	aiHome := strings.TrimSpace(dependencies.AIHomeDir)
	hostHome := strings.TrimSpace(dependencies.HostHomeDir)
	if aiHome == "" && hostHome != "" {
		aiHome = filepath.Join(hostHome, ".ai_home")
	}

	svc := ports.Service
	if svc == nil {
		usageStore := ports.UsageStore
		if usageStore == nil && aiHome != "" {
			dbPath, err := appstate.DatabasePath(aiHome)
			if err != nil {
				return nil, fmt.Errorf("解析管理用量数据库路径失败: %w", err)
			}
			opened, err := managementops.NewUsageStore(context.Background(), dbPath, catalogProviderIDs(dependencies.Catalog), nowFn)
			if err != nil {
				return nil, fmt.Errorf("打开管理用量数据库失败: %w", err)
			}
			usageStore = opened
		}

		modelCatalog := ports.ModelCatalog
		if modelCatalog == nil && dependencies.Store != nil && dependencies.ModelRefresher != nil {
			if refresher := newWebUIModelCatalogRefresher(dependencies.Store, dependencies.ModelRefresher, nowFn); refresher != nil {
				modelCatalog = modelCatalogRefresherAdapter{refresher: refresher}
			}
		}

		restarter := ports.Restarter
		if restarter == nil {
			if nativeRestarter := webuiserverrestartapi.NewNativeRestarter(webuiserverrestartapi.NativeRestarterOptions{
				AIHomeDir:       aiHome,
				ResolveCommand:  ports.RestartCommandResolver,
				RequestShutdown: dependencies.RequestShutdown,
			}); nativeRestarter != nil {
				restarter = serverRestarterAdapter{restarter: nativeRestarter, now: nowFn}
			}
		}

		startedAt := ports.StartedAt
		if startedAt.IsZero() {
			startedAt = nowFn()
		}

		svc = managementops.NewManagementService(managementops.ManagementOptions{
			AIHomeDir:        aiHome,
			HostHomeDir:      hostHome,
			Catalog:          dependencies.Catalog,
			Store:            dependencies.Store,
			AccountRuntime:   dependencies.AccountRuntime,
			AccountRows:      ports.AccountRows,
			Metrics:          ports.Metrics,
			ModelCatalog:     modelCatalog,
			Restarter:        restarter,
			UsageStore:       usageStore,
			Host:             ports.Host,
			Port:             ports.Port,
			APIKeyConfigured: ports.APIKeyConfigured || dependencies.ManagementKey != nil,
			ProviderMode:     ports.ProviderMode,
			Strategy:         ports.Strategy,
			Now:              nowFn,
			StartedAt:        startedAt,
		})
	}

	handler, err := webuimanagementapi.NewHandler(webuimanagementapi.Dependencies{
		Authorizer: dependencies.Authorizer,
		Service:    svc,
		Now:        nowFn,
	})
	if err != nil {
		return nil, fmt.Errorf("创建管理面聚合接口失败: %w", err)
	}

	return []webuiRoute{
		{Pattern: "GET " + webuimanagementapi.UIPath, Handler: handler},
		{Pattern: "GET " + webuimanagementapi.StatusPath, Handler: handler},
		{Pattern: "GET " + webuimanagementapi.MetricsPath, Handler: handler},
		{Pattern: "GET " + webuimanagementapi.ModelsPath, Handler: handler},
		{Pattern: "GET " + webuimanagementapi.AccountsPath, Handler: handler},
		{Pattern: "GET " + webuimanagementapi.WatchPath, Handler: handler},
		{Pattern: "POST " + webuimanagementapi.WatchSnapshotPath, Handler: handler},
		{Pattern: "POST " + webuimanagementapi.ReloadPath, Handler: handler},
		{Pattern: "POST " + webuimanagementapi.CooldownClearPath, Handler: handler},
		{Pattern: "POST " + webuimanagementapi.RestartPath, Handler: handler},
		// Preserve the Node public restart contract when the native server runs without Node.
		{Pattern: "POST " + webuimanagementapi.PublicPrefix + "/restart", Handler: handler},
		{Pattern: "POST " + webuimanagementapi.StateIndexOperationalStatusPath, Handler: handler},
		{Pattern: "POST " + webuimanagementapi.StateIndexRuntimeStatePath, Handler: handler},
		{Pattern: "POST " + webuimanagementapi.StateIndexUpsertPath, Handler: handler},
		{Pattern: "POST " + webuimanagementapi.StateIndexPruneMissingPath, Handler: handler},
		{Pattern: "GET " + webuimanagementapi.UsagePath, Handler: handler},
		{Pattern: "GET " + webuimanagementapi.UsageStatsPath, Handler: handler},
		{Pattern: "GET " + webuimanagementapi.UsageDashboardPath, Handler: handler},
		{Pattern: "GET " + webuimanagementapi.UsageModelsPath, Handler: handler},
		{Pattern: "GET " + webuimanagementapi.UsageSessionsPath, Handler: handler},
		{Pattern: "GET " + webuimanagementapi.UsageRequestsPath, Handler: handler},
		{Pattern: "GET " + webuimanagementapi.UsageBreakdownPath, Handler: handler},
		{Pattern: "GET " + webuimanagementapi.UsageSessionDetailPath, Handler: handler},
		{Pattern: "GET " + webuimanagementapi.UsageScanPath, Handler: handler},
		{Pattern: "POST " + webuimanagementapi.UsageScanPath, Handler: handler},
		{Pattern: "GET " + webuimanagementapi.UsageScanWatchPath, Handler: handler},
		{Pattern: "POST " + webuimanagementapi.UsageDashboardQueryPath, Handler: handler},
		{Pattern: "GET " + webuimanagementapi.UsageDashboardQueryWatchPath, Handler: handler},
		{Pattern: "GET " + webuimanagementapi.UsageDashboardQueryMemberPattern, Handler: handler},
		{Pattern: "DELETE " + webuimanagementapi.UsageDashboardQueryMemberPattern, Handler: handler},
		// 浏览器正式面：/v0/webui/management/* 直接由 Go 应答，通过前缀重写复用
		// 同一份处理器；Node 不再保留这份管理面实现。
		{Pattern: "/v0/webui/management", Handler: publicManagementHandler(handler)},
		{Pattern: "/v0/webui/management/", Handler: publicManagementHandler(handler)},
	}, nil
}

// publicManagementHandler 把浏览器前缀 /v0/webui/management 重写到 Go 管理面前缀。
func publicManagementHandler(handler http.Handler) http.Handler {
	return webuipublicalias.Rewrite("/v0/webui/management", webuimanagementapi.BasePath, handler)
}

func catalogProviderIDs(catalog *providers.Catalog) []string {
	if catalog == nil {
		return nil
	}
	list := catalog.List()
	ids := make([]string, 0, len(list))
	for _, item := range list {
		if id := strings.TrimSpace(item.ID); id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}

// managementMetricsAdapter 把 Host 的 metricsRecorder 适配为 managementops 指标端口。
type managementMetricsAdapter struct {
	recorder *metricsRecorder
}

func newManagementMetricsPort(recorder *metricsRecorder) managementops.MetricsSnapshotPort {
	if recorder == nil {
		return nil
	}
	return managementMetricsAdapter{recorder: recorder}
}

func (a managementMetricsAdapter) SnapshotMetrics() managementops.MetricsResponse {
	if a.recorder == nil {
		return managementops.MetricsResponse{}
	}
	snap := a.recorder.Snapshot()
	return managementops.MetricsResponse{
		OK:            true,
		TotalRequests: snap.TotalRequests,
		TotalSuccess:  snap.TotalSuccess,
		TotalFailures: snap.TotalFailures,
		TotalTimeouts: snap.TotalTimeouts,
		SuccessRate:   snap.SuccessRate,
		TimeoutRate:   snap.TimeoutRate,
		RouteCounts:   snap.RouteCounts,
	}
}

func (a managementMetricsAdapter) SnapshotSessionAffinity() map[string]int {
	return nil
}
