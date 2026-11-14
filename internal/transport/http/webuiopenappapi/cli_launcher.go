package webuiopenappapi

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/nativeterminal"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/terminals"
)

const (
	cliStopGracePeriod = desktopStopGracePeriod
)

func (l *NativeLauncher) executeCLI(
	ctx context.Context,
	req Request,
	snapshot AccountSnapshot,
	hasAccount bool,
) (Result, error) {
	deps := l.deps
	harness := strings.ToLower(strings.TrimSpace(req.Harness))
	if harness == "" {
		harness = strings.ToLower(strings.TrimSpace(req.Provider))
	}

	if req.Action == "close" {
		if strings.TrimSpace(req.AccountRef) == "" {
			return closeCLITerminals(ctx, deps, harness, req.AccountRef), nil
		}
		// Go-owned panes must settle capture before legacy process-tree shutdown.
		// Keep the old scanner path for existing Node-created windows.
		native, closeErr := nativeterminal.CloseAccount(ctx, deps.AIHomeDir, harness, req.AccountRef)
		if closeErr != nil {
			return Result{OK: false, Error: "native_terminal_close_incomplete", Message: "原生会话退出清理未完成，已保留恢复记录；未强杀其他账号进程。", PIDs: native.PIDs}, nil
		}
		legacy := closeCLITerminalsAfterNative(ctx, deps, harness, req.AccountRef, native.PIDs)
		if native.Matched > 0 && legacy.OK {
			legacy.Status = "closed"
			legacy.PIDs = append(native.PIDs, legacy.PIDs...)
		}
		return legacy, nil
	}
	return openCLITerminal(ctx, deps, req, harness, snapshot, hasAccount), nil
}

func closeCLITerminals(
	ctx context.Context,
	deps NativeLauncherDependencies,
	harness string,
	accountRef string,
) Result {
	return closeCLITerminalsAfterNative(ctx, deps, harness, accountRef, nil)
}

// Close only legacy instances. Native families require a successful trusted
// registry close, independent of whether List skipped a damaged/missing record.
func closeCLITerminalsAfterNative(
	ctx context.Context, deps NativeLauncherDependencies, harness, accountRef string,
	settledNativePIDs []int,
) Result {
	if strings.TrimSpace(accountRef) == "" {
		return Result{
			OK:      false,
			Error:   "account_required",
			Message: launchErrorMessage("account_required"),
		}
	}
	if deps.ProcessScanner == nil {
		return Result{OK: false, Error: "native_terminal_state_unavailable", Message: "无法核对原生会话进程归属；未执行旧进程强制关闭。"}
	}
	instances, err := deps.ProcessScanner.ListCLIInstances(ctx)
	if err != nil {
		return Result{OK: false, Error: "native_terminal_state_unavailable", Message: "无法核对原生会话进程归属；未执行旧进程强制关闭。"}
	}
	settled := make(map[int]bool, len(settledNativePIDs))
	for _, pid := range settledNativePIDs {
		if pid > 0 {
			settled[pid] = true
		}
	}
	protected := make(map[int]bool)
	for _, inst := range instances {
		if !inst.NativeOwned {
			continue
		}
		protected[inst.PID] = true
		if inst.RootPID > 0 {
			protected[inst.RootPID] = true
		}
		if strings.EqualFold(strings.TrimSpace(inst.Provider), harness) && strings.TrimSpace(inst.AccountRef) == strings.TrimSpace(accountRef) && !settled[inst.PID] && !settled[inst.RootPID] {
			return Result{OK: false, Error: "native_terminal_registry_untrusted", Message: "存在原生会话进程，但缺少已完成可信关闭的记录；未强杀该会话及其子进程。", PIDs: []int{}}
		}
	}
	platformKey := normalizePlatformKey(deps.Platform)
	var pids []int
	seen := make(map[int]struct{})
	for _, inst := range instances {
		if inst.NativeOwned || protected[inst.PID] || protected[inst.RootPID] {
			continue
		}
		if !strings.EqualFold(strings.TrimSpace(inst.Provider), harness) {
			continue
		}
		if strings.TrimSpace(inst.AccountRef) != strings.TrimSpace(accountRef) {
			continue
		}
		pid := inst.PID
		if platformKey == "windows" && inst.RootPID > 0 {
			pid = inst.RootPID
		}
		if pid <= 0 {
			continue
		}
		if _, dup := seen[pid]; dup {
			continue
		}
		seen[pid] = struct{}{}
		pids = append(pids, pid)
	}
	if len(pids) == 0 {
		return Result{OK: true, Status: "not_running", PIDs: []int{}}
	}
	if platformKey != "windows" {
		// POSIX 先从子进程侧开始终止，避免留下孤儿终端树。
		for i, j := 0, len(pids)-1; i < j; i, j = i+1, j-1 {
			pids[i], pids[j] = pids[j], pids[i]
		}
	}
	killed, _ := deps.Runner.CloseProcessTree(ctx, pids, cliStopGracePeriod, deps.sleepFn())
	return Result{
		OK:     true,
		Status: "closed",
		PIDs:   killed,
	}
}

func openCLITerminal(
	ctx context.Context,
	deps NativeLauncherDependencies,
	req Request,
	harness string,
	snapshot AccountSnapshot,
	hasAccount bool,
) Result {
	platformKey := normalizePlatformKey(deps.Platform)
	hostHomeDir := resolveAppHomeDir(firstNonEmptyString(req.HostHomeDir, deps.HostHomeDir))
	environ := deps.currentEnviron()

	targetID := ""
	if hasAccount {
		if req.CrossProvider {
			if strings.TrimSpace(req.AccountRef) == "" {
				return Result{
					OK:      false,
					Error:   "account_not_found",
					Message: launchErrorMessage("account_not_found"),
				}
			}
			targetID = strings.TrimSpace(req.AccountRef)
		} else {
			if snapshot.CLIAccountID <= 0 {
				return Result{
					OK:      false,
					Error:   "account_not_found",
					Message: launchErrorMessage("account_not_found"),
				}
			}
			targetID = strconv.FormatInt(snapshot.CLIAccountID, 10)
		}
	}

	modelName := strings.TrimSpace(req.Model)
	if modelName != "" && req.CrossProvider {
		resolvedModel, failRes := resolveCrossProviderModelAlias(ctx, deps.ModelAliases, req.Provider, modelName)
		if failRes != nil {
			return *failRes
		}
		modelName = resolvedModel
	}

	workdir := normalizeCLIWorkdir(req.Workdir, hostHomeDir, environ)
	if workdir != "" && !isExistingDirectory(workdir) {
		return Result{
			OK:      false,
			Error:   "workdir_not_found",
			Message: launchErrorMessage("workdir_not_found"),
		}
	}

	transport := strings.ToLower(strings.TrimSpace(req.Transport))
	if transport == "" {
		transport = "native"
	}
	cliPath := strings.TrimSpace(req.Executable)
	if transport != "webui" {
		if cliPath == "" && deps.CLIBinaryFinder != nil {
			cliPath = strings.TrimSpace(deps.CLIBinaryFinder(ctx, harness, req.BinaryName, hostHomeDir))
		}
		if cliPath == "" {
			return buildCLIInstallRequiredResult(deps, req, harness)
		}
	}

	// 严格 fail-closed：检查账号出口，拒绝无效/失效出口或受限地区启动 CLI。
	var egressRes EgressResolution
	if deps.Egress != nil && hasAccount {
		egressRes = deps.Egress.Resolve(ctx, req.Provider, req.AccountRef, platformKey)
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
		if denied, reason := deps.Egress.CheckLaunchNetwork(ctx, deps.AIHomeDir, req.Provider, req.AccountRef, environ, egressRes); denied {
			return Result{
				OK:      false,
				Error:   "account_egress_region_denied",
				Reason:  reason,
				Message: launchErrorMessage("account_egress_region_denied"),
			}
		}
	}

	terminalID := strings.ToLower(strings.TrimSpace(req.TerminalID))
	if terminalID == "" {
		terminalID = terminals.DefaultTerminalID
	}
	title := buildCLITitle(harness, targetID, modelName, hasAccount)
	termEnv := buildCLIEnv(environ, deps.AIHomeDir, req.Provider, req.AccountRef, egressRes)

	if transport == "webui" {
		if deps.WebUITerminalOpener == nil {
			return Result{
				OK:      false,
				Error:   "web_terminal_unavailable",
				Message: launchErrorMessage("web_terminal_unavailable"),
			}
		}
		launchFile := cliPath
		var launchArgs []string
		if hasAccount {
			if webUICLIIsGoOwned(req, harness) {
				var failure *Result
				launchArgs, termEnv, failure = prepareGoCLIInvocation(ctx, deps, req, snapshot, harness, modelName, hostHomeDir, termEnv)
				if failure != nil {
					return *failure
				}
				var resolveErr error
				launchFile, resolveErr = resolveGoCLIExecutable(deps, environ)
				if resolveErr != nil {
					return Result{OK: false, Error: "aih_cli_unavailable", Message: resolveErr.Error()}
				}
			} else {
				// 明确保留未迁域，不是 Go 错误回退：旧 Node 支持更广的身份
				// Provider 与 external harness，必须保留其 accountRef 启动合同。
				launchFile = findNodeExecutable(environ, platformKey)
				cliEntry := "bin/ai-home.js"
				if strings.TrimSpace(deps.RepoRoot) != "" {
					cliEntry = filepath.Join(deps.RepoRoot, "bin", "ai-home.js")
				}
				launchArgs = []string{cliEntry, harness, targetID}
				if modelName != "" {
					launchArgs = append(launchArgs, "--model", modelName)
				}
			}
		} else {
			if cliPath == "" && deps.CLIBinaryFinder != nil {
				cliPath = strings.TrimSpace(deps.CLIBinaryFinder(ctx, harness, req.BinaryName, hostHomeDir))
			}
			if cliPath == "" {
				return buildCLIInstallRequiredResult(deps, req, harness)
			}
			launchFile = cliPath
		}
		openRes, err := deps.WebUITerminalOpener(ctx, WebUITerminalOpenRequest{
			SessionKey: req.SessionKey,
			Cwd:        workdir,
			File:       launchFile,
			Args:       launchArgs,
			Env:        termEnv,
			Persistent: true,
		})
		if err != nil {
			return Result{
				OK:      false,
				Error:   "web_terminal_open_failed",
				Reason:  err.Error(),
				Message: err.Error(),
			}
		}
		status := "launched"
		if openRes.Reused {
			status = "already_running"
		}
		sessionKey := strings.TrimSpace(openRes.SessionKey)
		if sessionKey == "" {
			sessionKey = req.SessionKey
		}
		return Result{
			OK:            true,
			Status:        status,
			TerminalID:    terminalID,
			SessionKey:    sessionKey,
			LaunchMode:    "webui-pty",
			Executable:    cliPath,
			EgressWarning: egressRes.Warning,
		}
	}

	// Native uses the same capability ownership boundary as WebUI. The lifecycle
	// wrapper owns tmux, titles and cleanup; unsupported/unmigrated combinations
	// keep the existing Node path rather than losing features.
	var command string
	if hasAccount && webUICLIIsGoOwned(req, harness) {
		args, nativeEnv, failure := prepareGoCLIInvocation(ctx, deps, req, snapshot, harness, modelName, hostHomeDir, termEnv)
		if failure != nil {
			return *failure
		}
		binary, err := resolveGoCLIExecutable(deps, environ)
		if err != nil {
			return Result{OK: false, Error: "aih_cli_unavailable", Message: err.Error()}
		}
		cwd := workdir
		if cwd == "" {
			cwd, _ = os.Getwd()
		}
		lifecycleArgs := nativeterminal.Arguments(deps.AIHomeDir, nativeterminal.Spec{
			Provider: harness, IdentityProvider: req.Provider, AccountRef: req.AccountRef,
			CLIAccountID: snapshot.CLIAccountID, CWD: cwd, Model: modelName, Args: args,
		})
		parts := []string{quoteShellToken(binary, platformKey)}
		for _, arg := range lifecycleArgs {
			parts = append(parts, quoteShellToken(arg, platformKey))
		}
		command = strings.Join(parts, " ")
		termEnv = nativeEnv
	} else {
		nodeExe := findNodeExecutable(environ, platformKey)
		cliEntry := "bin/ai-home.js"
		if strings.TrimSpace(deps.RepoRoot) != "" {
			cliEntry = filepath.Join(deps.RepoRoot, "bin", "ai-home.js")
		}
		command = buildNativeCLICommand(nodeExe, cliEntry, harness, targetID, modelName, cliPath, workdir, req.AccountRef, deps.AIHomeDir, hasAccount, platformKey)
	}

	spec := terminals.ResolveClientTerminalLaunch(terminalID, command, title, terminals.Options{
		Platform:    terminalsPlatform(platformKey),
		HostHomeDir: hostHomeDir,
		Env:         envSliceToStringMap(environ),
	})
	if spec == nil {
		return Result{
			OK:      false,
			Error:   "terminal_not_found",
			Message: launchErrorMessage("terminal_not_found"),
		}
	}

	winHide := false
	if spec.WindowsHide != nil {
		winHide = *spec.WindowsHide
	}
	pid, err := deps.Runner.StartDetached(SpawnSpec{
		File:        spec.File,
		Args:        spec.Args,
		Dir:         workdir,
		Env:         termEnv,
		WindowsHide: winHide,
	})
	if err != nil {
		return Result{
			OK:      false,
			Error:   "terminal_launch_failed",
			Reason:  err.Error(),
			Message: err.Error(),
		}
	}
	if egressRes.Warning != "" && deps.Warn != nil {
		deps.Warn(req.Provider + "/" + req.AccountRef + " " + egressRes.Warning)
	}
	resolvedTermID := strings.TrimSpace(spec.TerminalID)
	if resolvedTermID == "" {
		resolvedTermID = terminalID
	}
	return Result{
		OK:            true,
		Status:        "launched",
		PID:           intPtr(pid),
		TerminalID:    resolvedTermID,
		Executable:    cliPath,
		EgressWarning: egressRes.Warning,
	}
}

func resolveCrossProviderModelAlias(
	ctx context.Context,
	aliasesPort ModelAliasPort,
	provider string,
	requested string,
) (string, *Result) {
	if aliasesPort == nil {
		return requested, nil
	}
	records, err := aliasesPort.ListAliases(ctx)
	if err != nil {
		return "", &Result{
			OK:      false,
			Error:   "model_alias_lookup_failed",
			Reason:  err.Error(),
			Message: launchErrorMessage("model_alias_lookup_failed"),
		}
	}
	normReq := strings.ToLower(strings.TrimSpace(requested))
	normProvider := strings.ToLower(strings.TrimSpace(provider))
	var providerMatch *int
	var globalMatch *int
	for i := range records {
		rec := records[i]
		// Enabled 是 *bool：nil 表示默认启用（与 modelaliaswebui 一致）。
		if rec.Enabled != nil && !*rec.Enabled {
			continue
		}
		if strings.ToLower(strings.TrimSpace(rec.Alias)) != normReq {
			continue
		}
		recProv := strings.ToLower(strings.TrimSpace(rec.Provider))
		if recProv == normProvider && providerMatch == nil {
			idx := i
			providerMatch = &idx
		} else if (recProv == "" || recProv == "auto") && globalMatch == nil {
			idx := i
			globalMatch = &idx
		}
	}
	chosen := providerMatch
	if chosen == nil {
		chosen = globalMatch
	}
	if chosen == nil {
		return requested, nil
	}
	rec := records[*chosen]
	targetProv := strings.ToLower(strings.TrimSpace(rec.ResolvedTargetProvider()))
	if targetProv != "" && targetProv != "auto" && targetProv != normProvider {
		return "", &Result{
			OK:      false,
			Error:   "model_alias_target_provider_mismatch",
			Reason:  fmt.Sprintf("alias %s targets %s, but the pinned account is %s", rec.Alias, targetProv, normProvider),
			Message: launchErrorMessage("model_alias_target_provider_mismatch"),
		}
	}
	if target := strings.TrimSpace(rec.Target); target != "" {
		return target, nil
	}
	return requested, nil
}

func normalizeCLIWorkdir(raw, hostHomeDir string, environ []string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if trimmed == "~" || strings.HasPrefix(trimmed, "~/") || strings.HasPrefix(trimmed, "~\\") {
		home := strings.TrimSpace(hostHomeDir)
		if home == "" {
			home = firstEnvValue(envSliceToMap(environ), "HOME", "USERPROFILE")
		}
		if home == "" {
			return trimmed
		}
		if trimmed == "~" {
			return home
		}
		return filepath.Join(home, trimmed[2:])
	}
	return trimmed
}

func isExistingDirectory(candidate string) bool {
	info, err := os.Stat(strings.TrimSpace(candidate))
	return err == nil && info.IsDir()
}

func buildCLIInstallRequiredResult(deps NativeLauncherDependencies, req Request, harness string) Result {
	installProvider := strings.TrimSpace(harness)
	if installProvider == "" {
		installProvider = strings.TrimSpace(req.Provider)
	}
	appID := strings.TrimSpace(req.ManagedAppID)
	if appID == "" {
		appID = installProvider
	}
	target := &InstallTarget{
		Provider: installProvider,
		Kind:     "cli",
		AppID:    appID,
	}
	var availPtr *bool
	msg := "未检测到原生 CLI，请确认后开始安装。"
	if deps.InstallChecker != nil {
		avail := deps.InstallChecker(installProvider, "cli", target.AppID)
		availPtr = &avail
		if !avail {
			msg = "当前 Provider 没有可用的自动安装器，请手动安装原生 CLI 后重试。"
		}
	}
	return Result{
		OK:               false,
		Error:            "cli_not_installed",
		InstallRequired:  true,
		InstallTarget:    target,
		InstallAvailable: availPtr,
		Message:          msg,
	}
}

func buildCLIEnv(environ []string, aiHomeDir, provider, accountRef string, egress EgressResolution) []string {
	m := envSliceToMap(environ)
	setEnvKey(m, "AIH_ACCOUNT_APP", "1")
	if strings.TrimSpace(accountRef) != "" {
		setEnvKey(m, "AIH_PROVIDER_ACCOUNT_REF", strings.TrimSpace(accountRef))
	}
	if strings.TrimSpace(aiHomeDir) != "" {
		setEnvKey(m, "AIH_HOME_DIR", strings.TrimSpace(aiHomeDir))
	}
	env := mapToEnvSlice(m)
	if strings.TrimSpace(accountRef) != "" {
		env = applyAccountEgressProxyEnv(provider, env, egress)
	}
	sort.Strings(env)
	return env
}

func buildNativeCLICommand(
	nodeExe string,
	cliEntry string,
	harness string,
	targetID string,
	modelName string,
	cliPath string,
	workdir string,
	accountRef string,
	aiHomeDir string,
	hasAccount bool,
	platformKey string,
) string {
	var coreCmd string
	if hasAccount {
		coreCmd = fmt.Sprintf(`%s %s %s %s`,
			quoteShellToken(nodeExe, platformKey),
			quoteShellToken(cliEntry, platformKey),
			harness,
			targetID,
		)
		if modelName != "" {
			coreCmd += " --model " + quoteShellToken(modelName, platformKey)
		}
	} else {
		coreCmd = quoteShellToken(cliPath, platformKey)
	}

	var cmd string
	if platformKey == "windows" {
		parts := []string{`set "AIH_ACCOUNT_APP=1"`}
		if ref := strings.TrimSpace(accountRef); ref != "" {
			parts = append(parts, fmt.Sprintf(`set "AIH_PROVIDER_ACCOUNT_REF=%s"`, ref))
		}
		if strings.TrimSpace(aiHomeDir) != "" {
			parts = append(parts, fmt.Sprintf(`set "AIH_HOME_DIR=%s"`, strings.TrimSpace(aiHomeDir)))
		}
		cmd = strings.Join(parts, " && ") + " && " + coreCmd
	} else {
		parts := []string{"AIH_ACCOUNT_APP=1"}
		if ref := strings.TrimSpace(accountRef); ref != "" {
			parts = append(parts, "AIH_PROVIDER_ACCOUNT_REF="+quoteShellToken(ref, platformKey))
		}
		if strings.TrimSpace(aiHomeDir) != "" {
			parts = append(parts, "AIH_HOME_DIR="+quoteShellToken(strings.TrimSpace(aiHomeDir), platformKey))
		}
		cmd = strings.Join(parts, " ") + " " + coreCmd
	}

	if strings.TrimSpace(workdir) != "" {
		quotedDir := quoteShellToken(workdir, platformKey)
		if platformKey == "windows" {
			cmd = "cd /d " + quotedDir + " && " + cmd
		} else {
			cmd = "cd " + quotedDir + " && " + cmd
		}
	}
	return cmd
}

func quoteShellToken(val, platformKey string) string {
	if platformKey == "windows" {
		return `"` + strings.ReplaceAll(val, `"`, `\"`) + `"`
	}
	return `'` + strings.ReplaceAll(val, `'`, `'\''`) + `'`
}

func buildCLITitle(harness, targetID, model string, hasAccount bool) string {
	if !hasAccount {
		return harness + " CLI"
	}
	base := "aih " + harness + " " + targetID
	if strings.TrimSpace(model) != "" {
		return base + " · " + strings.TrimSpace(model)
	}
	return base
}

func terminalsPlatform(platformKey string) string {
	switch normalizePlatformKey(platformKey) {
	case "darwin":
		return terminals.PlatformMacOS
	case "windows":
		return terminals.PlatformWindows
	default:
		return terminals.PlatformLinux
	}
}

func envSliceToStringMap(environ []string) map[string]string {
	out := make(map[string]string, len(environ))
	for _, entry := range environ {
		k, v, ok := strings.Cut(entry, "=")
		if ok && strings.TrimSpace(k) != "" {
			out[k] = v
		}
	}
	return out
}
