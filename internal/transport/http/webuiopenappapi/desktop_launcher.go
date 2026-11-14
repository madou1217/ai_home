package webuiopenappapi

import (
	"context"
	"path/filepath"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/hostapps"
	"github.com/madou1217/ai_home/internal/runtime/storagepolicy"
)

const desktopStopGracePeriod = 800 * time.Millisecond

func (l *NativeLauncher) executeDesktop(
	ctx context.Context,
	req Request,
	snapshot AccountSnapshot,
) (Result, error) {
	deps := l.deps
	platformKey := normalizePlatformKey(deps.Platform)
	if !isDesktopSupportedForPlatform(deps, req.Provider, platformKey) {
		return Result{
			OK:      false,
			Error:   "desktop_not_supported",
			Message: launchErrorMessage("desktop_not_supported"),
		}, nil
	}
	if req.AccountRef == "" {
		return Result{
			OK:      false,
			Error:   "account_required",
			Message: launchErrorMessage("account_required"),
		}, nil
	}

	profileDir := hostapps.ProfileDir(deps.AIHomeDir, req.Provider, req.AccountRef)
	if profileDir == "" {
		return Result{
			OK:      false,
			Error:   "account_profile_unavailable",
			Message: launchErrorMessage("account_profile_unavailable"),
		}, nil
	}
	userDataDir := hostapps.UserDataDir(deps.AIHomeDir, req.Provider, req.AccountRef)
	appName := hostapps.ApplicationName(req.Provider, req.AccountRef)
	hostHomeDir := resolveAppHomeDir(firstNonEmptyString(req.HostHomeDir, deps.HostHomeDir))

	if req.Action == "close" {
		return closeDesktopInstance(ctx, deps, req, snapshot, profileDir, userDataDir, appName), nil
	}
	return openDesktopInstance(ctx, deps, req, snapshot, profileDir, userDataDir, appName, hostHomeDir, platformKey), nil
}

func isDesktopSupportedForPlatform(deps NativeLauncherDependencies, provider, platformKey string) bool {
	if deps.Catalog == nil {
		return true
	}
	def, ok := deps.Catalog.Get(provider)
	if !ok || !def.Clients.Desktop || def.CLI == nil || def.CLI.DesktopClient == nil {
		return false
	}
	return desktopPlatformFor(def.CLI.DesktopClient, catalogPlatformKey(platformKey)) != nil
}

func catalogPlatformKey(platformKey string) string {
	switch normalizePlatformKey(platformKey) {
	case "darwin":
		return "macos"
	case "windows":
		return "windows"
	default:
		return "linux"
	}
}

func closeDesktopInstance(
	ctx context.Context,
	deps NativeLauncherDependencies,
	req Request,
	snapshot AccountSnapshot,
	profileDir string,
	userDataDir string,
	appName string,
) Result {
	runningPIDs := findMatchingDesktopPIDs(ctx, deps.ProcessScanner, userDataDir, appName, deps.Platform)
	if len(runningPIDs) == 0 {
		afterCloseDesktopProvider(ctx, deps, req, snapshot, profileDir, deps.nowTime())
		return Result{
			OK:     true,
			Status: "not_running",
		}
	}
	killed, _ := deps.Runner.CloseProcessTree(ctx, runningPIDs, desktopStopGracePeriod, deps.sleepFn())
	afterCloseDesktopProvider(ctx, deps, req, snapshot, profileDir, deps.nowTime())
	return Result{
		OK:     true,
		Status: "closed",
		PIDs:   killed,
	}
}

func openDesktopInstance(
	ctx context.Context,
	deps NativeLauncherDependencies,
	req Request,
	snapshot AccountSnapshot,
	profileDir string,
	userDataDir string,
	appName string,
	hostHomeDir string,
	platformKey string,
) Result {
	baseEnv := deps.currentEnviron()
	pctx := newDesktopPrepContext(ctx, deps, req, snapshot, profileDir, userDataDir, appName, hostHomeDir, platformKey, baseEnv)

	runningPIDs := findMatchingDesktopPIDs(ctx, deps.ProcessScanner, userDataDir, appName, deps.Platform)
	if len(runningPIDs) > 0 && pctx.reuseRunningInstance {
		egressWarning := ""
		if deps.Egress != nil {
			res := deps.Egress.Resolve(ctx, req.Provider, req.AccountRef, platformKey)
			if res.OK && res.Bound {
				egressWarning = describeAlreadyRunningWarning("", res)
			}
		}
		return Result{
			OK:            true,
			Status:        "already_running",
			PIDs:          runningPIDs,
			EgressWarning: egressWarning,
		}
	}

	resolvedApp := findInstalledDesktopApp(ctx, deps, req, hostHomeDir)
	if resolvedApp == nil || strings.TrimSpace(resolvedApp.ExecutablePath) == "" {
		return buildDesktopInstallRequiredResult(deps, req.Provider)
	}
	pctx.resolved = *resolvedApp

	// 严格 fail-closed：确认需要启动新实例后解析账号出口，未就绪或失效直接中止。
	egressWarning := ""
	if deps.Egress != nil {
		egressRes := deps.Egress.Resolve(ctx, req.Provider, req.AccountRef, platformKey)
		if !egressRes.OK {
			msg := strings.TrimSpace(egressRes.Message)
			if msg == "" {
				msg = launchErrorMessage(egressRes.Error)
			}
			return Result{
				OK:            false,
				Error:         egressRes.Error,
				EgressError:   egressRes.Reason,
				Reason:        egressRes.Reason,
				Message:       msg,
				EgressWarning: egressRes.Warning,
			}
		}
		pctx.egress = egressRes
		pctx.egressPrepared = true
		egressWarning = egressRes.Warning
	}

	pctx.decorateBaseEnv()
	if err := ensureAccountPrivateUserDataDir(userDataDir); err != nil {
		return Result{
			OK:      false,
			Error:   "launch_failed",
			Message: err.Error(),
		}
	}

	if failRes := pctx.prepareSession(); failRes != nil {
		if len(runningPIDs) > 0 && len(failRes.PIDs) == 0 {
			failRes.PIDs = runningPIDs
		}
		return *failRes
	}

	if len(runningPIDs) > 0 {
		if !pctx.requiresRestart {
			return Result{
				OK:            true,
				Status:        "already_running",
				PIDs:          runningPIDs,
				EgressWarning: describeAlreadyRunningWarning(egressWarning, pctx.egress),
			}
		}
		killed, _ := deps.Runner.CloseProcessTree(ctx, runningPIDs, desktopStopGracePeriod, deps.sleepFn())
		if len(killed) != len(runningPIDs) {
			return Result{
				OK:      false,
				Error:   pctx.restartFailedError,
				PIDs:    runningPIDs,
				PID:     nil,
				Message: launchErrorMessage(pctx.restartFailedError),
			}
		}
	}

	// 启动准备阶段可能会写明文凭据/配置文件；若后续失败或 spawn 异常则回滚。
	snapshotDesktopRollbackPaths(pctx.rollback, req.Provider, profileDir)
	failAfterPrepare := func(res Result) Result {
		pctx.rollback.restore()
		if res.Message == "" && res.Error != "" {
			res.Message = launchErrorMessage(res.Error)
		}
		if res.EgressWarning == "" && egressWarning != "" {
			res.EgressWarning = egressWarning
		}
		return res
	}

	if failRes := pctx.prepareProfile(); failRes != nil {
		return failAfterPrepare(*failRes)
	}
	if err := linkSharedHostDataRoots(req.Provider, profileDir, hostHomeDir, platformKey); err != nil {
		return failAfterPrepare(Result{
			OK:      false,
			Error:   "desktop_data_root_not_shared",
			Reason:  err.Error(),
			Message: launchErrorMessage("desktop_data_root_not_shared"),
		})
	}
	ensureDesktopSharedCaches(deps.AIHomeDir, req.Provider, userDataDir)
	// 物化账号快照回沙箱：保持与 CLI 相同的登录态（失败不覆盖启动，记录提示即可）。
	if matErr := materializeDesktopAuth(ctx, deps.AIHomeDir, hostHomeDir, profileDir, snapshot, pctx.rollback); matErr != nil {
		pctx.warn("materialize desktop auth failed: " + matErr.Error())
	}
	if failRes := pctx.prepareResolvedLaunch(); failRes != nil {
		return failAfterPrepare(*failRes)
	}

	spawnSpec := pctx.resolveSpawnPlan()
	if deps.Egress != nil {
		if denied, reason := deps.Egress.CheckLaunchNetwork(ctx, deps.AIHomeDir, req.Provider, req.AccountRef, spawnSpec.Env, pctx.egress); denied {
			return failAfterPrepare(Result{
				OK:      false,
				Error:   "account_egress_region_denied",
				Reason:  reason,
				Message: launchErrorMessage("account_egress_region_denied"),
			})
		}
	}

	pctx.beforeSpawnHook()
	pid, err := deps.Runner.StartDetached(spawnSpec)
	if err != nil {
		return failAfterPrepare(Result{
			OK:      false,
			Error:   "launch_failed",
			Message: err.Error(),
		})
	}
	if egressWarning != "" && deps.Warn != nil {
		deps.Warn(req.Provider + "/" + req.AccountRef + " " + egressWarning)
	}
	return Result{
		OK:            true,
		Status:        "launched",
		PID:           intPtr(pid),
		Executable:    pctx.resolved.ExecutablePath,
		EgressWarning: egressWarning,
	}
}

func findInstalledDesktopApp(
	ctx context.Context,
	deps NativeLauncherDependencies,
	req Request,
	hostHomeDir string,
) *DesktopAppRecord {
	if deps.DesktopAppFinder != nil {
		if rec := deps.DesktopAppFinder(ctx, req.Provider, hostHomeDir); rec != nil && strings.TrimSpace(rec.ExecutablePath) != "" {
			return rec
		}
	}
	if strings.TrimSpace(req.Executable) != "" {
		exe := strings.TrimSpace(req.Executable)
		bundle := ""
		if strings.HasSuffix(strings.ToLower(exe), ".app") {
			bundle = exe
		} else if idx := strings.Index(exe, ".app/"); idx > 0 {
			bundle = exe[:idx+4]
		}
		return &DesktopAppRecord{
			Provider:       req.Provider,
			ExecutablePath: exe,
			BundlePath:     bundle,
			DisplayPath:    exe,
		}
	}
	return nil
}

func findMatchingDesktopPIDs(
	ctx context.Context,
	scanner ProcessScannerPort,
	userDataDir string,
	appName string,
	platform string,
) []int {
	if scanner == nil {
		return nil
	}
	instances, err := scanner.ListDesktopInstances(ctx)
	if err != nil || len(instances) == 0 {
		return nil
	}
	normTarget := normalizeMatchPath(userDataDir, platform)
	normApp := strings.TrimSpace(appName)
	var raw []int
	for _, inst := range instances {
		matched := false
		if normTarget != "" && strings.TrimSpace(inst.UserDataDir) != "" {
			if normalizeMatchPath(inst.UserDataDir, platform) == normTarget {
				matched = true
			}
		}
		if !matched && normApp != "" && strings.TrimSpace(inst.ApplicationName) != "" {
			if strings.EqualFold(strings.TrimSpace(inst.ApplicationName), normApp) {
				matched = true
			}
		}
		if matched && inst.PID > 0 {
			raw = append(raw, inst.PID)
		}
	}
	return parsePositivePIDs(raw)
}

func normalizeMatchPath(p string, platform string) string {
	cleaned := filepath.Clean(strings.TrimSpace(p))
	if normalizePlatformKey(platform) == "windows" {
		return strings.ToLower(cleaned)
	}
	return cleaned
}

func snapshotDesktopRollbackPaths(rb *fileRollback, provider, profileDir string) {
	if rb == nil || strings.TrimSpace(profileDir) == "" {
		return
	}
	if policy := storagepolicy.Get(provider); policy != nil {
		for _, art := range policy.AuthArtifacts {
			if len(art.Path) > 0 {
				rb.snapshot(filepath.Join(append([]string{profileDir}, art.Path...)...))
			}
		}
	}
	if strings.EqualFold(provider, "codex") {
		rb.snapshot(filepath.Join(profileDir, ".codex", "config.toml"))
	}
}

func buildDesktopInstallRequiredResult(deps NativeLauncherDependencies, provider string) Result {
	norm := strings.ToLower(strings.TrimSpace(provider))
	target := &InstallTarget{
		Provider: norm,
		Kind:     "desktop",
		AppID:    norm + "-desktop",
	}
	var availPtr *bool
	msg := "未检测到 Desktop 应用，请确认后开始安装。"
	if deps.InstallChecker != nil {
		avail := deps.InstallChecker(norm, "desktop", target.AppID)
		availPtr = &avail
		if !avail {
			msg = "当前平台没有可用的自动安装器，请手动安装官方 Desktop 应用后重试。"
		}
	}
	return Result{
		OK:               false,
		Error:            "desktop_not_installed",
		InstallRequired:  true,
		InstallTarget:    target,
		InstallAvailable: availPtr,
		Message:          msg,
	}
}

func intPtr(v int) *int {
	if v <= 0 {
		return nil
	}
	val := v
	return &val
}
