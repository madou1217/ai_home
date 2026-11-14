package aihserver

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/codexhooks"
	"github.com/madou1217/ai_home/internal/runtime/sessionevents"
	"github.com/madou1217/ai_home/internal/transport/http/codexappserverapi"
)

const (
	// codexHooksStatusPath 是 Codex Hook 诊断状态管理端点（仅限 Management Key 访问）。
	codexHooksStatusPath = "/v1/management/webui/codex-hooks/status"

	defaultCodexHooksSelfHealInterval = 15 * time.Second
	minCodexHooksSelfHealInterval     = 1 * time.Second
)

// codexHooksDaemonOptions 配置 Codex Desktop / VSCode / CLI Hook 注入器、
// 后台自愈循环以及会话通知队列桥接器生命周期。
type codexHooksDaemonOptions struct {
	Context                      context.Context
	AIHomeDir                    string
	HostHomeDir                  string
	EnableDesktopHook            bool
	EnableVscodeHook             bool
	EnableCLIHook                bool
	EnableNotificationBridge     bool
	AllowSystemApplications      *bool
	DesktopRuntimeLayouts        []codexhooks.DesktopLayout
	ExtensionRoots               []string
	VSCodeExtensions             string
	PathEnv                      string
	TempDir                      string
	NodeExecPath                 string
	HelperScriptPath             string
	ProviderHookReceiverURL      string
	CLISelfHealInterval          time.Duration
	DesktopSelfHealInterval      time.Duration
	TraceConfig                  *codexhooks.DesktopTraceConfig
	RestartAppServerOnHookChange bool
	SessionEventBus              *sessionevents.Bus
	LogInfo                      func(string)
	LogWarn                      func(string)

	// 以下可注入回调默认留空走真实实现，仅用于无副作用单元测试。
	ResolveCodexBinary func(loginShellFallback bool) string
	ReadBundleMetadata func(bundlePath string) codexhooks.BundleMetadata
	ReadCodexVersion   func(upstreamBinaryPath string) string
	ListProcesses      func() ([]codexhooks.ProcessInfo, error)
	KillProcess        func(pid int) error
}

// codexHooksRuntime 持有运行中的 Codex Hook 服务、自愈循环与通知队列桥接器，
// 实现 io.Closer 以便组合根在 Server 退出时统一停止全部后台协程。
type codexHooksRuntime struct {
	cancel      context.CancelFunc
	closeOnce   sync.Once
	aiHomeDir   string
	hostHomeDir string

	desktop            *codexhooks.DesktopHookService
	vscode             *codexhooks.VscodeHookService
	cli                *codexhooks.CLIHookService
	desktopSelfHeal    *codexhooks.SelfHealLoop
	vscodeSelfHeal     *codexhooks.SelfHealLoop
	cliSelfHeal        *codexhooks.SelfHealLoop
	notificationBridge *codexhooks.NotificationBridge

	traceConfig                  *codexhooks.DesktopTraceConfig
	restartAppServerOnHookChange bool
	logInfo                      func(string)
	logWarn                      func(string)
}

const codexHelperScriptRelPath = "lib/server/codex-app-server-stdio-proxy.js"

// buildCodexHooksDaemonOptions 根据 Go Server 启动配置装配完整的 Codex Hook 守护参数。
// Desktop 开启时联动启用 VSCode 扩展 Hook（除非 EnableVscodeHook 显式设为 false），
// ProviderHookReceiverURL 为空且 nodeBaseURL 非空时自动派生，TraceRemoteControl 与 RemoteControlProxy
// 未显式指定时保持默认 true，SelfHeal 间隔默认 15s。
func buildCodexHooksDaemonOptions(
	dependencies Options,
	aiHomeDir string,
	nodeBaseURL string,
	sessionEventBus *sessionevents.Bus,
	errorLog *log.Logger,
) codexHooksDaemonOptions {
	cfg := dependencies.CodexHooks
	resolvedAIHome := strings.TrimSpace(aiHomeDir)
	if resolvedAIHome == "" {
		resolvedAIHome = strings.TrimSpace(dependencies.AIHomeDir)
	}
	resolvedNodeBase := strings.TrimSpace(nodeBaseURL)
	if resolvedNodeBase == "" {
		resolvedNodeBase = strings.TrimSpace(dependencies.NodeBaseURL)
	}
	resolvedLog := errorLog
	if resolvedLog == nil {
		resolvedLog = dependencies.ErrorLog
	}

	enableVscode := cfg.EnableDesktopHook
	if cfg.EnableVscodeHook != nil {
		enableVscode = *cfg.EnableVscodeHook
	}

	receiverURL := strings.TrimSpace(cfg.ProviderHookReceiverURL)
	if receiverURL == "" {
		if cleanBase := strings.TrimRight(resolvedNodeBase, "/"); cleanBase != "" {
			receiverURL = cleanBase + "/v0/webui/session-events/provider-hook"
		}
	}

	traceRemoteControl := true
	if cfg.TraceRemoteControl != nil {
		traceRemoteControl = *cfg.TraceRemoteControl
	}
	remoteControlProxy := true
	if cfg.RemoteControlProxy != nil {
		remoteControlProxy = *cfg.RemoteControlProxy
	}

	var logInfo, logWarn func(string)
	if resolvedLog != nil {
		logInfo = func(message string) {
			if trimmed := strings.TrimSpace(message); trimmed != "" {
				resolvedLog.Println(trimmed)
			}
		}
		logWarn = func(message string) {
			if trimmed := strings.TrimSpace(message); trimmed != "" {
				resolvedLog.Println(trimmed)
			}
		}
	}

	return codexHooksDaemonOptions{
		AIHomeDir:                resolvedAIHome,
		EnableDesktopHook:        cfg.EnableDesktopHook,
		EnableVscodeHook:         enableVscode,
		EnableCLIHook:            cfg.EnableCLIHook,
		EnableNotificationBridge: true,
		NodeExecPath:             resolveCodexNodeExecPath(cfg.NodeExecPath),
		HelperScriptPath:         resolveCodexHelperScriptPath(cfg.HelperScriptPath, cfg.EntryFilePath),
		ProviderHookReceiverURL:  receiverURL,
		CLISelfHealInterval:      clampSelfHealInterval(cfg.CLISelfHealInterval),
		DesktopSelfHealInterval:  clampSelfHealInterval(cfg.DesktopSelfHealInterval),
		TraceConfig: &codexhooks.DesktopTraceConfig{
			TraceFile:          strings.TrimSpace(cfg.TraceFile),
			TraceResponses:     cfg.TraceResponses,
			TraceRemoteControl: traceRemoteControl,
			RemoteControlProxy: remoteControlProxy,
		},
		RestartAppServerOnHookChange: cfg.RestartAppServerOnHookChange,
		SessionEventBus:              sessionEventBus,
		LogInfo:                      logInfo,
		LogWarn:                      logWarn,
	}
}

func resolveCodexNodeExecPath(explicit string) string {
	if trimmed := strings.TrimSpace(explicit); trimmed != "" {
		return trimmed
	}
	if envNode := strings.TrimSpace(os.Getenv("AIH_SERVER_NODE_EXEC")); envNode != "" {
		return envNode
	}
	if found, err := exec.LookPath("node"); err == nil && strings.TrimSpace(found) != "" {
		return strings.TrimSpace(found)
	}
	if goruntime.GOOS != "windows" {
		for _, candidate := range []string{"/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"} {
			if isRegularNonDirFile(candidate) {
				return candidate
			}
		}
	}
	return ""
}

func resolveCodexHelperScriptPath(explicitHelper string, entryFilePath string) string {
	if trimmed := strings.TrimSpace(explicitHelper); trimmed != "" {
		return trimmed
	}
	relHelper := filepath.FromSlash(codexHelperScriptRelPath)
	var roots []string
	addAncestors := func(start string, levels int) {
		curr := strings.TrimSpace(start)
		for i := 0; i <= levels && curr != ""; i++ {
			roots = append(roots, curr)
			parent := filepath.Dir(curr)
			if parent == curr {
				break
			}
			curr = parent
		}
	}
	entry := strings.TrimSpace(entryFilePath)
	if entry == "" {
		entry = strings.TrimSpace(os.Getenv("AIH_SERVER_ENTRY_FILE"))
	}
	if entry != "" {
		addAncestors(filepath.Dir(entry), 2)
	}
	if exe, err := os.Executable(); err == nil && strings.TrimSpace(exe) != "" {
		addAncestors(filepath.Dir(exe), 4)
	}
	if wd, err := os.Getwd(); err == nil && strings.TrimSpace(wd) != "" {
		addAncestors(wd, 4)
	}
	seen := make(map[string]struct{}, len(roots))
	for _, root := range roots {
		if _, ok := seen[root]; ok {
			continue
		}
		seen[root] = struct{}{}
		candidate := filepath.Join(root, relHelper)
		if isRegularNonDirFile(candidate) {
			return candidate
		}
	}
	return ""
}

func isRegularNonDirFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

// startCodexHooksDaemons 初始化并启动 Codex CLI/Desktop/VSCode Hook 管理器、
// 自愈定时循环与通知队列桥接器。发生局部启动错误时会自动清理已启动协程。
func startCodexHooksDaemons(opts codexHooksDaemonOptions) (*codexHooksRuntime, error) {
	aiHomeDir := strings.TrimSpace(opts.AIHomeDir)
	if aiHomeDir == "" {
		return nil, fmt.Errorf("启动 Codex Hook 运行时失败: AIHomeDir 不能为空")
	}
	hostHomeDir := strings.TrimSpace(opts.HostHomeDir)
	if hostHomeDir == "" {
		if home, err := os.UserHomeDir(); err == nil {
			hostHomeDir = strings.TrimSpace(home)
		}
	}
	parentCtx := opts.Context
	if parentCtx == nil {
		parentCtx = context.Background()
	}
	ctx, cancel := context.WithCancel(parentCtx)

	var traceCopy *codexhooks.DesktopTraceConfig
	if opts.TraceConfig != nil {
		cfg := *opts.TraceConfig
		traceCopy = &cfg
	}

	runtime := &codexHooksRuntime{
		cancel:                       cancel,
		aiHomeDir:                    aiHomeDir,
		hostHomeDir:                  hostHomeDir,
		traceConfig:                  traceCopy,
		restartAppServerOnHookChange: opts.RestartAppServerOnHookChange,
		logInfo:                      opts.LogInfo,
		logWarn:                      opts.LogWarn,
	}

	if opts.EnableNotificationBridge {
		bridge := codexhooks.NewNotificationBridge(codexhooks.NotificationBridgeOptions{
			AIHomeDir: aiHomeDir,
			Bus:       opts.SessionEventBus,
		})
		bridge.Start(ctx)
		runtime.notificationBridge = bridge
	}

	if opts.EnableCLIHook {
		cliSvc := codexhooks.NewCLIHookService(codexhooks.CLIHookOptions{
			AIHomeDir:          aiHomeDir,
			HostHomeDir:        hostHomeDir,
			PathEnv:            opts.PathEnv,
			TempDir:            opts.TempDir,
			NodeExecPath:       opts.NodeExecPath,
			HelperScriptPath:   opts.HelperScriptPath,
			ResolveCodexBinary: opts.ResolveCodexBinary,
		})
		runtime.cli = cliSvc
		hookResult := cliSvc.EnsureInstalled(codexhooks.CLIHookEnsureOptions{})
		if hookResult.Supported {
			if hookResult.Enabled {
				runtime.emitInfo("[aih:codex-cli-hook] cli hook enabled")
			} else if hookResult.Reason != "" {
				runtime.emitInfo("[aih:codex-cli-hook] cli hook " + hookResult.Reason)
			}
		}
		cliLoop, err := codexhooks.StartSelfHealLoop(ctx, codexhooks.SelfHealOptions{
			Interval: clampSelfHealInterval(opts.CLISelfHealInterval),
			EnsureInstalled: func(context.Context) (codexhooks.SelfHealResult, error) {
				res := cliSvc.EnsureInstalled(codexhooks.CLIHookEnsureOptions{Background: true})
				return codexhooks.SelfHealResult{
					OK:               res.OK,
					Repaired:         res.Repaired,
					Retryable:        res.Retryable,
					TargetBinaryPath: res.TargetBinaryPath,
					Reason:           res.Reason,
					ErrorCode:        res.ErrorCode,
					Extra:            res,
				}, nil
			},
			OnRepaired: func(res codexhooks.SelfHealResult) {
				runtime.emitInfo(fmt.Sprintf("[aih:codex-cli-hook] repaired cli hook at %s", strings.TrimSpace(res.TargetBinaryPath)))
			},
			OnFailure: func(failure codexhooks.SelfHealFailure) {
				runtime.emitWarn(formatHookSelfHealFailure("codex-cli-hook", failure))
			},
		})
		if err != nil {
			_ = runtime.Close()
			return nil, fmt.Errorf("启动 Codex CLI Hook 自愈循环失败: %w", err)
		}
		runtime.cliSelfHeal = cliLoop
	}

	if opts.EnableDesktopHook {
		desktopSvc := codexhooks.NewDesktopHookService(codexhooks.DesktopHookOptions{
			AIHomeDir:               aiHomeDir,
			HostHomeDir:             hostHomeDir,
			NodeExecPath:            opts.NodeExecPath,
			HelperScriptPath:        opts.HelperScriptPath,
			ProviderHookReceiverURL: opts.ProviderHookReceiverURL,
			RuntimeLayouts:          opts.DesktopRuntimeLayouts,
			AllowSystemApplications: opts.AllowSystemApplications,
			ReadBundleMetadata:      opts.ReadBundleMetadata,
			ReadCodexVersion:        opts.ReadCodexVersion,
			ListProcesses:           opts.ListProcesses,
			KillProcess:             opts.KillProcess,
		})
		runtime.desktop = desktopSvc
		startupResult, activateErr := desktopSvc.Activate()
		if activateErr != nil {
			runtime.emitWarn(fmt.Sprintf("[aih:codex-hook] %v", activateErr))
		} else {
			if startupResult.Retryable != nil && !*startupResult.Retryable {
				runtime.emitWarn(formatHookSelfHealFailure("codex-hook", codexhooks.SelfHealFailure{
					Result: &codexhooks.SelfHealResult{
						OK:               startupResult.OK,
						Reason:           startupResult.Reason,
						ErrorCode:        startupResult.ErrorCode,
						Retryable:        startupResult.Retryable,
						TargetBinaryPath: startupResult.TargetBinaryPath,
					},
					Suspended: true,
				}))
			}
			runtime.applyDesktopTraceAndRestart(startupResult, true)
			if startupResult.Supported {
				if startupResult.Enabled {
					runtime.emitInfo("[aih:codex-hook] desktop hook enabled")
				} else if startupResult.Reason != "" {
					runtime.emitInfo("[aih:codex-hook] desktop hook " + startupResult.Reason)
				}
			}
		}

		if activateErr != nil || startupResult.Retryable == nil || *startupResult.Retryable {
			desktopLoop, err := codexhooks.StartSelfHealLoop(ctx, codexhooks.SelfHealOptions{
				Interval: clampSelfHealInterval(opts.DesktopSelfHealInterval),
				EnsureInstalled: func(context.Context) (codexhooks.SelfHealResult, error) {
					res, err := desktopSvc.EnsureInstalled()
					return codexhooks.SelfHealResult{
						OK:               res.OK,
						Repaired:         res.Repaired,
						Retryable:        res.Retryable,
						TargetBinaryPath: res.TargetBinaryPath,
						Reason:           res.Reason,
						ErrorCode:        res.ErrorCode,
						Extra:            res,
					}, err
				},
				OnRepaired: func(res codexhooks.SelfHealResult) {
					if desktopResult, ok := res.Extra.(codexhooks.DesktopHookResult); ok {
						runtime.applyDesktopTraceAndRestart(desktopResult, false)
					}
					runtime.emitInfo(fmt.Sprintf("[aih:codex-hook] repaired desktop hook at %s", strings.TrimSpace(res.TargetBinaryPath)))
				},
				OnFailure: func(failure codexhooks.SelfHealFailure) {
					runtime.emitWarn(formatHookSelfHealFailure("codex-hook", failure))
				},
			})
			if err != nil {
				_ = runtime.Close()
				return nil, fmt.Errorf("启动 Codex Desktop Hook 自愈循环失败: %w", err)
			}
			runtime.desktopSelfHeal = desktopLoop
		}
	}

	if opts.EnableVscodeHook {
		vscodeSvc := codexhooks.NewVscodeHookService(codexhooks.VscodeHookOptions{
			AIHomeDir:        aiHomeDir,
			HostHomeDir:      hostHomeDir,
			NodeExecPath:     opts.NodeExecPath,
			HelperScriptPath: opts.HelperScriptPath,
			ExtensionRoots:   opts.ExtensionRoots,
			VSCodeExtensions: opts.VSCodeExtensions,
			ListProcesses:    opts.ListProcesses,
			KillProcess:      opts.KillProcess,
		})
		runtime.vscode = vscodeSvc
		vscodeResult := vscodeSvc.Activate()
		if vscodeResult.Supported {
			if vscodeResult.Enabled {
				runtime.emitInfo(fmt.Sprintf("[aih:codex-vscode-hook] vscode hook enabled (%d installed)", vscodeResult.Installed))
			} else if vscodeResult.Reason != "" {
				runtime.emitInfo("[aih:codex-vscode-hook] vscode hook " + vscodeResult.Reason)
			}
		}
		vscodeLoop, err := codexhooks.StartSelfHealLoop(ctx, codexhooks.SelfHealOptions{
			Interval: clampSelfHealInterval(opts.DesktopSelfHealInterval),
			EnsureInstalled: func(context.Context) (codexhooks.SelfHealResult, error) {
				res := vscodeSvc.EnsureInstalled()
				return codexhooks.SelfHealResult{
					OK:       res.OK,
					Repaired: res.Repaired,
					Reason:   res.Reason,
					Extra:    res,
				}, nil
			},
			OnRepaired: func(codexhooks.SelfHealResult) {
				runtime.emitInfo("[aih:codex-vscode-hook] repaired vscode hook")
			},
			OnFailure: func(failure codexhooks.SelfHealFailure) {
				runtime.emitWarn(formatHookSelfHealFailure("codex-vscode-hook", failure))
			},
		})
		if err != nil {
			_ = runtime.Close()
			return nil, fmt.Errorf("启动 Codex VSCode Hook 自愈循环失败: %w", err)
		}
		runtime.vscodeSelfHeal = vscodeLoop
	}

	return runtime, nil
}

// Close 幂等停止全部 Hook 自愈循环与通知队列桥接协程。
func (r *codexHooksRuntime) Close() error {
	if r == nil {
		return nil
	}
	r.closeOnce.Do(func() {
		if r.cliSelfHeal != nil {
			r.cliSelfHeal.Stop()
		}
		if r.desktopSelfHeal != nil {
			r.desktopSelfHeal.Stop()
		}
		if r.vscodeSelfHeal != nil {
			r.vscodeSelfHeal.Stop()
		}
		if r.notificationBridge != nil {
			r.notificationBridge.Stop()
		}
		if r.cancel != nil {
			r.cancel()
		}
	})
	return nil
}

// EnsureCLIInstalled 触发一次 Codex CLI Hook 核对与修复（供 CLI 自动升级后重装垫片）。
func (r *codexHooksRuntime) EnsureCLIInstalled() codexhooks.CLIHookResult {
	if r == nil || r.cli == nil {
		return codexhooks.CLIHookResult{OK: false, Reason: "cli_hook_disabled"}
	}
	return r.cli.EnsureInstalled(codexhooks.CLIHookEnsureOptions{})
}

// DesktopService 返回运行时持有的 DesktopHookService（可能为 nil）。
func (r *codexHooksRuntime) DesktopService() *codexhooks.DesktopHookService {
	if r == nil {
		return nil
	}
	return r.desktop
}

// VscodeService 返回运行时持有的 VscodeHookService（可能为 nil）。
func (r *codexHooksRuntime) VscodeService() *codexhooks.VscodeHookService {
	if r == nil {
		return nil
	}
	return r.vscode
}

// CLIService 返回运行时持有的 CLIHookService（可能为 nil）。
func (r *codexHooksRuntime) CLIService() *codexhooks.CLIHookService {
	if r == nil {
		return nil
	}
	return r.cli
}

// NotificationBridge 返回运行时持有的 NotificationBridge（可能为 nil）。
func (r *codexHooksRuntime) NotificationBridge() *codexhooks.NotificationBridge {
	if r == nil {
		return nil
	}
	return r.notificationBridge
}

// Status 汇总当前 CLI / Desktop / VSCode Hook 状态与自愈循环运行态快照。
func (r *codexHooksRuntime) Status() map[string]any {
	if r == nil {
		return map[string]any{"ok": false, "reason": "runtime_unavailable"}
	}
	cliStatus := map[string]any{"enabled": false}
	if r.cli != nil {
		cliStatus = r.cli.Status()
	}
	desktopStatus := map[string]any{"enabled": false}
	if r.desktop != nil {
		desktopStatus = r.desktop.Status()
	}
	vscodeStatus := map[string]any{"enabled": false}
	if r.vscode != nil {
		vscodeStatus = r.vscode.Status()
	}
	selfHeal := map[string]any{}
	if r.cliSelfHeal != nil {
		selfHeal["cli"] = r.cliSelfHeal.State()
	}
	if r.desktopSelfHeal != nil {
		selfHeal["desktop"] = r.desktopSelfHeal.State()
	}
	if r.vscodeSelfHeal != nil {
		selfHeal["vscode"] = r.vscodeSelfHeal.State()
	}
	return map[string]any{
		"ok":                    true,
		"notificationQueuePath": codexhooks.ResolveNotificationQueuePath(r.aiHomeDir),
		"cli":                   cliStatus,
		"desktop":               desktopStatus,
		"vscode":                vscodeStatus,
		"selfHeal":              selfHeal,
	}
}

func (r *codexHooksRuntime) applyDesktopTraceAndRestart(result codexhooks.DesktopHookResult, startup bool) {
	if r == nil || r.desktop == nil {
		return
	}
	var traceChanged bool
	if r.traceConfig != nil {
		traceResult := r.desktop.UpdateTraceConfig(*r.traceConfig)
		traceChanged = traceResult.Changed
	}
	if (traceChanged || result.HelperScriptChanged || result.RestartRequired) &&
		(result.RestartRequired || r.restartAppServerOnHookChange) {
		restartResult := r.desktop.RestartRunningAppServers()
		if restartResult.Count > 0 {
			r.emitInfo(fmt.Sprintf("[aih:codex-hook] restarted %d desktop app-server process(es) for hook config update", restartResult.Count))
		}
		return
	}
	if startup && (traceChanged || result.HelperScriptChanged) && !r.restartAppServerOnHookChange {
		r.emitInfo("[aih:codex-hook] desktop app-server reload disabled by hook change policy")
	}
}

func (r *codexHooksRuntime) emitInfo(message string) {
	if r != nil && r.logInfo != nil && message != "" {
		r.logInfo(message)
	}
}

func (r *codexHooksRuntime) emitWarn(message string) {
	if r != nil && r.logWarn != nil && message != "" {
		r.logWarn(message)
	}
}

func clampSelfHealInterval(interval time.Duration) time.Duration {
	if interval <= 0 {
		return defaultCodexHooksSelfHealInterval
	}
	if interval < minCodexHooksSelfHealInterval {
		return minCodexHooksSelfHealInterval
	}
	return interval
}

func formatHookSelfHealFailure(label string, failure codexhooks.SelfHealFailure) string {
	detail := ""
	if failure.Err != nil {
		detail = strings.TrimSpace(failure.Err.Error())
	} else if failure.Result != nil {
		var parts []string
		if reason := strings.TrimSpace(failure.Result.Reason); reason != "" {
			parts = append(parts, reason)
		}
		if code := strings.TrimSpace(failure.Result.ErrorCode); code != "" {
			parts = append(parts, code)
		}
		detail = strings.Join(parts, ": ")
	}
	if detail == "" {
		detail = "hook_failed"
	}
	suffix := ""
	if failure.Suspended {
		suffix = "; automatic retries suspended until server restart"
	}
	return fmt.Sprintf("[aih:%s] self-heal failed: %s%s", label, detail, suffix)
}

// buildWebUICodexHooksRoutes 装配 WebUI Codex Hook 状态诊断路由（只读）。
func buildWebUICodexHooksRoutes(dependencies webuiRouteDependencies) ([]webuiRoute, error) {
	return buildWebUICodexHooksRoutesWithRuntime(dependencies, nil)
}

// buildWebUICodexHooksRoutesWithRuntime 允许注入运行中守护进程实例，
// 使诊断接口额外返回自愈循环计数与退避态。
func buildWebUICodexHooksRoutesWithRuntime(
	dependencies webuiRouteDependencies,
	hooksRuntime *codexHooksRuntime,
) ([]webuiRoute, error) {
	if dependencies.Authorizer == nil {
		return nil, fmt.Errorf("创建 Codex Hook 状态接口失败: 缺少 Authorizer")
	}
	handler := codexHooksStatusHandler{
		authorizer:  dependencies.Authorizer,
		aiHomeDir:   dependencies.AIHomeDir,
		hostHomeDir: dependencies.HostHomeDir,
		runtime:     hooksRuntime,
	}
	return []webuiRoute{
		{Pattern: "GET " + codexHooksStatusPath, Handler: handler},
	}, nil
}

type codexHooksStatusHandler struct {
	authorizer  interface{ Authorized(*http.Request) bool }
	aiHomeDir   string
	hostHomeDir string
	runtime     *codexHooksRuntime
}

func (h codexHooksStatusHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if h.authorizer == nil || !h.authorizer.Authorized(request) {
		writeSystemJSON(response, http.StatusUnauthorized, map[string]any{
			"ok":    false,
			"error": "unauthorized",
		})
		return
	}
	if request.Method != http.MethodGet {
		writeSystemJSON(response, http.StatusMethodNotAllowed, map[string]any{
			"ok":    false,
			"error": "method_not_allowed",
		})
		return
	}
	if h.runtime != nil {
		writeSystemJSON(response, http.StatusOK, h.runtime.Status())
		return
	}

	desktopSvc := codexhooks.NewDesktopHookService(codexhooks.DesktopHookOptions{
		AIHomeDir:   h.aiHomeDir,
		HostHomeDir: h.hostHomeDir,
	})
	vscodeSvc := codexhooks.NewVscodeHookService(codexhooks.VscodeHookOptions{
		AIHomeDir:   h.aiHomeDir,
		HostHomeDir: h.hostHomeDir,
	})
	cliSvc := codexhooks.NewCLIHookService(codexhooks.CLIHookOptions{
		AIHomeDir:   h.aiHomeDir,
		HostHomeDir: h.hostHomeDir,
	})
	writeSystemJSON(response, http.StatusOK, map[string]any{
		"ok":                    true,
		"notificationQueuePath": codexhooks.ResolveNotificationQueuePath(h.aiHomeDir),
		"cli":                   cliSvc.Status(),
		"desktop":               desktopSvc.Status(),
		"vscode":                vscodeSvc.Status(),
		"selfHeal":              map[string]any{},
	})
}

// newCodexAppServerProxyHandler 构造承载 /v0/codex/app-server（及根路径 WS 升级）的
// Codex app-server 代理处理器。
func newCodexAppServerProxyHandler(
	authorizer codexappserverapi.Authorizer,
	aiHomeDir string,
	hostHomeDir string,
	errorLog *log.Logger,
) (*codexappserverapi.AppServerHandler, error) {
	var logError func(error)
	if errorLog != nil {
		logError = func(err error) {
			if err != nil {
				errorLog.Printf("[aih:codex-proxy] %v", err)
			}
		}
	}
	return codexappserverapi.NewAppServerHandler(codexappserverapi.AppServerDependencies{
		Authorizer:  authorizer,
		AIHomeDir:   aiHomeDir,
		HostHomeDir: hostHomeDir,
		LogError:    logError,
	})
}

// newCodexRemoteControlProxyHandler 构造 ChatGPT remote-control HTTP/WebSocket 反向代理。
func newCodexRemoteControlProxyHandler(
	upstreamOrigin string,
	suppressStateFile string,
	httpClient *http.Client,
) (*codexappserverapi.RemoteControlHandler, error) {
	return codexappserverapi.NewRemoteControlHandler(codexappserverapi.RemoteControlDependencies{
		UpstreamOrigin:    upstreamOrigin,
		SuppressStateFile: suppressStateFile,
		HTTPClient:        httpClient,
	})
}

// shouldDispatchCodexAppServerUpgrade 判断请求是否为 Codex app-server WebSocket 升级入口。
func shouldDispatchCodexAppServerUpgrade(request *http.Request) bool {
	if request == nil || request.URL == nil {
		return false
	}
	return codexappserverapi.IsAppServerUpgradePath(request.URL.Path) &&
		codexappserverapi.IsUpgradeRequest(request)
}
