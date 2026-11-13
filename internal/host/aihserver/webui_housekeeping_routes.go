package aihserver

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/runtime/housekeeping"
	"github.com/madou1217/ai_home/internal/runtime/persistent"
	"github.com/madou1217/ai_home/internal/runtime/remotebackup"
	"github.com/madou1217/ai_home/internal/transport/http/webuihousekeepingapi"
)

// HousekeepingLogger 接收启动清理与后台守护的运行日志。
type HousekeepingLogger interface {
	Info(message string)
	Warn(message string)
}

type defaultHousekeepingLogger struct{}

func (defaultHousekeepingLogger) Info(message string) {
	if strings.TrimSpace(message) != "" {
		log.Printf("[housekeeping] %s", message)
	}
}

func (defaultHousekeepingLogger) Warn(message string) {
	if strings.TrimSpace(message) != "" {
		log.Printf("[housekeeping][warn] %s", message)
	}
}

// StartupHousekeepingSummary 汇总 Go Core 启动期一次性清理的结果与非致命告警。
type StartupHousekeepingSummary struct {
	Projections    housekeeping.PruneSummary `json:"projections"`
	AppServers     housekeeping.PruneSummary `json:"appServers"`
	ProjectionsErr error                     `json:"-"`
	AppServersErr  error                     `json:"-"`
}

type startupHousekeepingPorts struct {
	Accounts    housekeeping.RegisteredAccountsReader
	Reconciler  housekeeping.ResourceReconciler
	Invalidator housekeeping.EndpointInvalidator
	Logger      HousekeepingLogger
}

type housekeepingDaemonsPorts struct {
	Context      context.Context
	Exporter     remotebackup.AccountExporter
	RunBackup    remotebackup.RunBackupFunc
	TickInterval time.Duration
	StartupDelay *time.Duration
	Collector    persistent.SessionCollector
	Closer       persistent.SessionCloser
	PruneSockets func(ctx context.Context) (persistent.SocketPruneSummary, error)
	JanitorEvery time.Duration
	Logger       HousekeepingLogger
	Now          func() time.Time
	DisableStart bool
}

// HousekeepingDaemons 统一托管 Go 远程备份调度器与持久会话空闲清理器的生命周期。
type HousekeepingDaemons struct {
	scheduler *remotebackup.Scheduler
	janitor   *persistent.Janitor
	closeOnce sync.Once
}

// runStartupHousekeeping 在 Go Core 启动时执行一次陈旧运行时投影与 codex app-server 状态清理；
// 任何非致命告警仅记录不阻断服务启动。
func runStartupHousekeeping(
	ctx context.Context,
	deps webuiRouteDependencies,
) (StartupHousekeepingSummary, error) {
	return runStartupHousekeepingWithPorts(ctx, deps, startupHousekeepingPorts{})
}

func runStartupHousekeepingWithPorts(
	ctx context.Context,
	deps webuiRouteDependencies,
	ports startupHousekeepingPorts,
) (StartupHousekeepingSummary, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	logger := ports.Logger
	if logger == nil {
		logger = defaultHousekeepingLogger{}
	}

	var summary StartupHousekeepingSummary
	aiHomeDir := strings.TrimSpace(deps.AIHomeDir)
	if aiHomeDir == "" {
		err := errors.New("aiHomeDir 为空，跳过启动 housekeeping")
		summary.ProjectionsErr = err
		summary.AppServersErr = err
		logger.Warn(err.Error())
		return summary, nil
	}

	accountsReader := ports.Accounts
	if accountsReader == nil {
		if deps.Store == nil {
			err := errors.New("账号存储为空，跳过启动 housekeeping（fail-closed）")
			summary.ProjectionsErr = err
			summary.AppServersErr = err
			logger.Warn(err.Error())
			return summary, nil
		}
		accountsReader = housekeeping.SQLiteRegisteredAccountsReader{Store: deps.Store}
	}

	reconciler := ports.Reconciler
	if reconciler == nil {
		hostHomeDir := strings.TrimSpace(deps.HostHomeDir)
		if hostHomeDir == "" {
			hostHomeDir, _ = os.UserHomeDir()
		}
		reconciler = housekeeping.DeletionProjectionReconciler{
			AIHomeDir:   aiHomeDir,
			HostHomeDir: hostHomeDir,
		}
	}

	projSummary, projErr := housekeeping.PruneStaleRuntimeProjections(ctx, housekeeping.ProjectionPruneOptions{
		AIHomeDir:  aiHomeDir,
		Catalog:    deps.Catalog,
		Accounts:   accountsReader,
		Reconciler: reconciler,
	})
	summary.Projections = projSummary
	summary.ProjectionsErr = projErr
	if projErr != nil {
		logger.Warn(fmt.Sprintf("启动清理陈旧 runtime projections 告警: %v", projErr))
	} else if projSummary.Removed > 0 || projSummary.Failed > 0 {
		logger.Info(fmt.Sprintf(
			"启动清理 runtime projections 完成: removed=%d kept=%d failed=%d",
			projSummary.Removed, projSummary.Kept, projSummary.Failed,
		))
	}

	invalidator := ports.Invalidator
	if invalidator == nil {
		invalidator = housekeeping.OSCodexEndpointInvalidator{}
	}
	appSummary, appErr := housekeeping.PruneStaleCodexAppServerStates(ctx, housekeeping.CodexAppServerPruneOptions{
		AIHomeDir:   aiHomeDir,
		Accounts:    accountsReader,
		Invalidator: invalidator,
	})
	summary.AppServers = appSummary
	summary.AppServersErr = appErr
	if appErr != nil {
		logger.Warn(fmt.Sprintf("启动清理陈旧 codex app-server 状态告警: %v", appErr))
	} else if appSummary.Removed > 0 || appSummary.Failed > 0 {
		logger.Info(fmt.Sprintf(
			"启动清理 codex app-server 状态完成: removed=%d kept=%d failed=%d",
			appSummary.Removed, appSummary.Kept, appSummary.Failed,
		))
	}

	return summary, nil
}

// startHousekeepingDaemons 创建并启动远程备份调度器与持久会话后台清理器。
func startHousekeepingDaemons(deps webuiRouteDependencies) (*HousekeepingDaemons, error) {
	return startHousekeepingDaemonsWithPorts(context.Background(), deps, housekeepingDaemonsPorts{})
}

func startHousekeepingDaemonsWithPorts(
	ctx context.Context,
	deps webuiRouteDependencies,
	ports housekeepingDaemonsPorts,
) (*HousekeepingDaemons, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	logger := ports.Logger
	if logger == nil {
		logger = defaultHousekeepingLogger{}
	}

	aiHomeDir := strings.TrimSpace(deps.AIHomeDir)
	if aiHomeDir == "" {
		return nil, errors.New("startHousekeepingDaemons: AIHomeDir 不能为空")
	}
	absAIHomeDir, err := filepath.Abs(aiHomeDir)
	if err != nil {
		return nil, fmt.Errorf("startHousekeepingDaemons: 解析 AIHomeDir 失败: %w", err)
	}

	exporter := ports.Exporter
	if exporter == nil && ports.RunBackup == nil {
		if deps.Store == nil {
			return nil, errors.New("startHousekeepingDaemons: Store 不能为空")
		}
		exporter = remotebackup.SQLiteAccountExporter{
			Store:   deps.Store,
			Catalog: deps.Catalog,
		}
	}

	scheduler := remotebackup.NewScheduler(remotebackup.SchedulerOptions{
		Service: remotebackup.ServiceOptions{
			AIHomeDir: absAIHomeDir,
			Exporter:  exporter,
			Now:       ports.Now,
			HomeDir:   deps.HostHomeDir,
			Logger:    logger,
		},
		RunBackup:    ports.RunBackup,
		TickInterval: ports.TickInterval,
		StartupDelay: ports.StartupDelay,
		Now:          ports.Now,
		Logger:       logger,
	})

	collector := ports.Collector
	closer := ports.Closer
	if collector == nil || closer == nil {
		reg, regErr := persistent.NewRegistry(filepath.Join(absAIHomeDir, "run"))
		if regErr != nil {
			return nil, fmt.Errorf("startHousekeepingDaemons: 初始化持久会话注册表失败: %w", regErr)
		}
		sessionStore := &persistent.TmuxSessionStore{
			AIHomeDir: absAIHomeDir,
			Registry:  reg,
			Catalog:   deps.Catalog,
			Scopes:    sqliteScopeProvider{store: deps.Store},
		}
		if collector == nil {
			collector = sessionStore
		}
		if closer == nil {
			closer = sessionStore
		}
	}

	janitor := persistent.NewJanitor(persistent.JanitorOptions{
		Collector:    collector,
		Closer:       closer,
		PruneSockets: ports.PruneSockets,
		Interval:     ports.JanitorEvery,
		Now:          ports.Now,
		Logger:       logger,
	})

	if !ports.DisableStart {
		scheduler.Start(ctx)
		janitor.Start(ctx)
	}

	return &HousekeepingDaemons{
		scheduler: scheduler,
		janitor:   janitor,
	}, nil
}

// buildWebUIHousekeepingRoutes 挂载远程备份状态/触发与持久会话清理 HTTP 管理路由。
func buildWebUIHousekeepingRoutes(deps webuiRouteDependencies, existing ...*HousekeepingDaemons) ([]webuiRoute, error) {
	if deps.Authorizer == nil {
		return nil, nil
	}
	var daemons *HousekeepingDaemons
	if len(existing) > 0 && existing[0] != nil {
		daemons = existing[0]
	} else {
		var err error
		daemons, err = startHousekeepingDaemons(deps)
		if err != nil {
			return nil, err
		}
	}
	return daemons.Routes(deps.Authorizer)
}

// Routes 返回挂载了统一 Bearer 鉴权的备份与持久会话清理路由列表。
func (d *HousekeepingDaemons) Routes(authorizer webuihousekeepingapi.Authorizer) ([]webuiRoute, error) {
	if d == nil {
		return nil, errors.New("HousekeepingDaemons 为 nil")
	}
	handler, err := webuihousekeepingapi.NewHandler(webuihousekeepingapi.Dependencies{
		Authorizer: authorizer,
		Backup:     d.scheduler,
		Janitor:    d.janitor,
	})
	if err != nil {
		return nil, fmt.Errorf("创建 housekeeping HTTP 接口失败: %w", err)
	}
	return []webuiRoute{
		{Pattern: "GET " + webuihousekeepingapi.BackupStatusPath, Handler: handler},
		{Pattern: "POST " + webuihousekeepingapi.BackupTriggerPath, Handler: handler},
		{Pattern: "POST " + webuihousekeepingapi.JanitorRunPath, Handler: handler},
	}, nil
}

// TriggerBackup 在账号生命周期事件发生时提交一次去抖远程备份请求。
func (d *HousekeepingDaemons) TriggerBackup(reason string) bool {
	if d == nil || d.scheduler == nil {
		return false
	}
	return d.scheduler.Trigger(reason)
}

// Scheduler 返回底层远程备份调度器，便于集成测试或状态检查。
func (d *HousekeepingDaemons) Scheduler() *remotebackup.Scheduler {
	if d == nil {
		return nil
	}
	return d.scheduler
}

// Janitor 返回底层持久会话后台清理器。
func (d *HousekeepingDaemons) Janitor() *persistent.Janitor {
	if d == nil {
		return nil
	}
	return d.janitor
}

// Close 实现 io.Closer，停机时安全停止远程备份调度器与持久会话清理器。
func (d *HousekeepingDaemons) Close() error {
	if d == nil {
		return nil
	}
	d.closeOnce.Do(func() {
		if d.scheduler != nil {
			d.scheduler.Stop()
		}
		if d.janitor != nil {
			d.janitor.Stop()
		}
	})
	return nil
}

type sqliteScopeProvider struct {
	store *sqliteaccount.Store
}

func (p sqliteScopeProvider) ListProviderAccountRefs(ctx context.Context, provider string) ([]string, error) {
	if p.store == nil {
		return nil, nil
	}
	target := strings.ToLower(strings.TrimSpace(provider))
	if target == "" {
		return nil, nil
	}
	var refs []string
	var afterRef accountcore.AccountRef
	for {
		query, err := accountapp.NewOverviewQuery(afterRef, accountapp.MaxOverviewLimit)
		if err != nil {
			return nil, err
		}
		overviews, err := p.store.ListAccountOverviews(ctx, query)
		if err != nil {
			return nil, err
		}
		for _, ov := range overviews {
			if strings.EqualFold(ov.Account().ProviderID(), target) {
				refs = append(refs, ov.Account().Ref().String())
			}
		}
		if len(overviews) < accountapp.MaxOverviewLimit {
			break
		}
		afterRef = overviews[len(overviews)-1].Account().Ref()
	}
	return refs, nil
}
