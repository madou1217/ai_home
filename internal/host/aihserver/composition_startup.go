package aihserver

import (
	"context"
	"io"
	"log"
	"net/http"

	"github.com/madou1217/ai_home/internal/runtime/providercliupgrade"
	"github.com/madou1217/ai_home/internal/runtime/proxyserve"
	"github.com/madou1217/ai_home/internal/runtime/windowactivation"
)

// webuiStartupRuntimeInputs 是启动路由与守护进程装配所需的最小依赖。
//
// 它只覆盖 newHandlers 中「调度器 → WebUI 路由 → 后台守护」这一段，不持有
// inference：失败由调用方关闭推理运行时。
type webuiStartupRuntimeInputs struct {
	ctx            context.Context
	webuiDeps      *webuiRouteDependencies
	clientKey      func() string
	windowProbeMux *http.ServeMux
	authorizer     interface{ Authorized(*http.Request) bool }
	aiHomeDir      string
}

// webuiStartupRuntime 是启动段的装配结果。
//
// 出错时也返回已构造的部分（调用方按 newHandlers 既有的 defer 顺序关闭），
// 因此调用方应先接住各字段，再处理 error。
type webuiStartupRuntime struct {
	upgradeScheduler    *providercliupgrade.Scheduler
	windowScheduler     *windowactivation.Scheduler
	routes              []webuiRoute
	watchWSCloser       io.Closer
	distributionUpdates io.Closer
	backgroundDaemons   *backgroundDaemonsRuntime
	housekeepingDaemons *HousekeepingDaemons
	// proxyServeManager 只在 WebUI 启停本机入口时拉起子进程；没有入口会话时为空转。
	proxyServeManager *proxyserve.Manager
}

// newWebUIStartupRuntime 装配 WebUI 启动路由与后台守护进程。
//
// 顺序是语义的一部分：升级/窗口调度器必须在 buildWebUIRoutes 之前创建、
// Start 并回填到路由依赖；诊断路由、会话回收/GC 守护、更新检测、后台守护
// 与启动清理随后依次接线。更新检测失败只记录日志，不影响启动。
func newWebUIStartupRuntime(inputs webuiStartupRuntimeInputs) (*webuiStartupRuntime, error) {
	startup := &webuiStartupRuntime{}
	deps := *inputs.webuiDeps
	schedulerPorts := webuiSchedulerPorts{
		ClientKey:    inputs.clientKey,
		LocalHandler: inputs.windowProbeMux,
	}
	startup.upgradeScheduler = NewUpgradeScheduler(deps, schedulerPorts)
	startup.upgradeScheduler.Start(inputs.ctx)
	startup.windowScheduler = NewWindowActivationScheduler(deps, schedulerPorts)
	startup.windowScheduler.Start(inputs.ctx)
	deps.UpgradeScheduler = startup.upgradeScheduler
	deps.WindowScheduler = startup.windowScheduler
	startup.proxyServeManager = proxyserve.NewManager(proxyserve.Options{
		AIHomeDir:     deps.AIHomeDir,
		ServerURL:     deps.SelfBaseURL,
		ManagementKey: deps.ManagementKey,
	})
	deps.ProxyServeManager = startup.proxyServeManager
	*inputs.webuiDeps = deps
	routes, err := buildWebUIRoutes(deps)
	if err != nil {
		return startup, err
	}
	startup.routes = routes
	startup.watchWSCloser = findWebUIWatchWSCloser(routes)
	// 运行时画像：内存/协程/GC 的唯一只读观测口。
	startup.routes = append(startup.routes, webuiRoute{Pattern: "GET " + runtimeDiagnosticsPath, Handler: runtimeDiagnosticsHandler{authorizer: inputs.authorizer}})
	startup.routes = append(startup.routes, webuiRoute{Pattern: "GET " + sessionDiagnosticsPath, Handler: sessionDiagnosticsHandler{authorizer: inputs.authorizer, aiHomeDir: inputs.aiHomeDir}})
	startup.routes = append(startup.routes, webuiRoute{Pattern: "POST " + sessionReclaimPath, Handler: sessionReclaimHandler{authorizer: inputs.authorizer, aiHomeDir: inputs.aiHomeDir}})
	// 后台巡检：按四重证据回收长时间无人使用的持久会话。
	sessionReclaimDaemon{aiHomeDir: inputs.aiHomeDir}.Start(inputs.ctx)
	spaceGCDaemon{aiHomeDir: inputs.aiHomeDir}.Start(inputs.ctx)
	updateRoutes, updateCloser, updateErr := buildDistributionUpdate(inputs.ctx, deps)
	if updateErr != nil {
		log.Printf("AIH 更新检测不可用: %v", updateErr)
	} else {
		startup.distributionUpdates = updateCloser
		startup.routes = append(startup.routes, updateRoutes...)
	}
	backupRoutes, backupErr := buildInstallationBackupRoutes(deps)
	if backupErr != nil {
		log.Printf("运行文件备份不可用: %v", backupErr)
	} else {
		startup.routes = append(startup.routes, backupRoutes...)
	}
	backgroundDaemons, err := startBackgroundDaemons(inputs.ctx, deps)
	startup.backgroundDaemons = backgroundDaemons
	if err != nil {
		return startup, err
	}
	if binder, ok := deps.AccountRuntime.(credentialRejectionRefreshBinder); ok {
		binder.bindCredentialRejectionRefresh(backgroundDaemons.tokenRefresh)
	}
	daemonsRoutes, err := backgroundDaemons.Routes(inputs.authorizer)
	if err != nil {
		return startup, err
	}
	startup.routes = append(startup.routes, daemonsRoutes...)
	// 启动期一次性清理陈旧 runtime projections 与 codex app-server 状态，并拉起远程备份与持久会话清理守护。
	_, _ = runStartupHousekeeping(inputs.ctx, deps)
	housekeepingDaemons, err := startHousekeepingDaemonsWithPorts(inputs.ctx, deps, housekeepingDaemonsPorts{})
	startup.housekeepingDaemons = housekeepingDaemons
	if err != nil {
		return startup, err
	}
	housekeepingRoutes, err := housekeepingDaemons.Routes(inputs.authorizer)
	if err != nil {
		return startup, err
	}
	startup.routes = append(startup.routes, housekeepingRoutes...)
	return startup, nil
}
