package apps

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/application/serverconfig"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/configsnapshot"
	"github.com/madou1217/ai_home/internal/runtime/providersessionhook"
	"github.com/madou1217/ai_home/internal/transport/http/webuiserverconfigapi"
)

const (
	managedHookMarker         = providersessionhook.Marker
	agyManagedHookName        = "aih-session-sync"
	openCodePluginMarker      = "aih-session-hook"
	defaultHookTimeoutSeconds = 10
	codexSwitchVersion        = "0.114.0"
)

var (
	defaultEventsFallback = map[string][]string{
		"claude":   {"UserPromptSubmit", "Stop"},
		"codex":    {"UserPromptSubmit", "Stop"},
		"gemini":   {"BeforeAgent", "AfterAgent"},
		"grok":     {"UserPromptSubmit", "Stop"},
		"agy":      {"PreToolUse", "PostToolUse", "Stop"},
		"opencode": {"UserPromptSubmit", "Stop"},
	}
	codexHooksFeatureFlags = map[string]struct{}{"hooks": {}, "codex_hooks": {}}
)

type resolvedHookProfile struct {
	provider      string
	supported     bool
	syncMode      string
	adapter       providers.HookAdapterID
	target        []string
	targetKind    string
	timeoutUnit   providers.HookTimeoutUnit
	eventMatchers map[string]string
	featureFlag   bool
	events        []string
}

func resolveProviderHookProfile(cat *providers.Catalog, providerRaw string) resolvedHookProfile {
	provider := strings.ToLower(strings.TrimSpace(providerRaw))
	syncMode := "unavailable"
	if cat == nil {
		return resolvedHookProfile{provider: provider, syncMode: syncMode}
	}
	def, ok := cat.Get(provider)
	if !ok {
		return resolvedHookProfile{provider: provider, syncMode: syncMode}
	}
	if def.SessionSync.Mode != "" {
		syncMode = string(def.SessionSync.Mode)
	}
	derived := providers.DeriveHookProfile(def)
	events := uniqueStrings(def.SessionSync.Events)
	if len(events) == 0 {
		events = append([]string{}, defaultEventsFallback[provider]...)
	}
	profile := resolvedHookProfile{
		provider:      provider,
		supported:     derived.Supported && strings.TrimSpace(string(derived.Adapter)) != "",
		syncMode:      syncMode,
		adapter:       derived.Adapter,
		target:        append([]string{}, derived.Target...),
		targetKind:    strings.TrimSpace(def.SessionSync.TargetKind),
		timeoutUnit:   derived.TimeoutUnit,
		eventMatchers: derived.EventMatchers,
		events:        events,
	}
	if derived.FeatureFlag != nil {
		profile.featureFlag = *derived.FeatureFlag
	}
	return profile
}

func hookTargetPath(profile resolvedHookProfile, opts Options) string {
	home := ResolveHostHome(opts)
	if profile.adapter == providers.HookAdapterOpenCodePlugin {
		return openCodePluginFilePath(home, resolveEnvMap(opts), resolvePlatform(opts))
	}
	if len(profile.target) == 0 || home == "" {
		return ""
	}
	parts := append([]string{home}, profile.target...)
	return joinPlatformPath(resolvePlatform(opts), parts...)
}

func openCodePluginFilePath(hostHome string, env map[string]string, platform string) string {
	cfgDir := envLookup(env, "OPENCODE_CONFIG_DIR")
	if cfgDir == "" {
		if xdg := envLookup(env, "XDG_CONFIG_HOME"); xdg != "" {
			cfgDir = joinPlatformPath(platform, xdg, "opencode")
		} else {
			cfgDir = joinPlatformPath(platform, hostHome, ".config", "opencode")
		}
	}
	return joinPlatformPath(platform, cfgDir, "plugin", openCodePluginMarker+".js")
}

// DiagnoseProviderHooks 诊断单个 Provider 官方会话 Hook 的安装状态。
func DiagnoseProviderHooks(ctx context.Context, provider string, cat *providers.Catalog, opts Options) HookDiagnosis {
	if cat == nil {
		cat = resolveCatalog(opts)
	}
	profile := resolveProviderHookProfile(cat, provider)
	if !profile.supported {
		return HookDiagnosis{
			Supported:     false,
			Provider:      profile.provider,
			SyncMode:      profile.syncMode,
			Installed:     false,
			MissingEvents: []string{},
			Events:        []string{},
			Reason:        "unsupported_provider",
		}
	}
	targetPath := hookTargetPath(profile, opts)
	switch profile.adapter {
	case providers.HookAdapterOpenCodePlugin:
		snapshot, readErr := configsnapshot.Read(targetPath)
		if readErr != nil {
			return hookReadFailure(profile, targetPath, readErr)
		}
		hasPlugin := snapshot.Exists && ownedOpenCodeSource(snapshot.Content)
		missing := []string{}
		reason := ""
		if !hasPlugin {
			missing = append([]string{}, profile.events...)
			reason = "missing_events"
			if snapshot.Exists {
				reason = "hook_plugin_ownership_conflict"
			}
		}
		return HookDiagnosis{
			Supported:     true,
			Provider:      profile.provider,
			TargetPath:    targetPath,
			TargetKind:    "plugin.js",
			SyncMode:      "hook",
			Installed:     hasPlugin,
			MissingEvents: missing,
			Events:        profile.events,
			Reason:        reason,
		}

	case providers.HookAdapterAgyNamedHooks:
		cfg, readErr := readHookDocument(targetPath)
		if readErr != nil {
			return hookReadFailure(profile, targetPath, readErr)
		}
		hookDef, _ := cfg[agyManagedHookName].(map[string]any)
		disabled := false
		if hookDef != nil {
			if en, ok := hookDef["enabled"].(bool); ok && !en {
				disabled = true
			}
		}
		var missing []string
		for _, ev := range profile.events {
			var evVal any
			if hookDef != nil {
				evVal = hookDef[ev]
			}
			if !agyEventHasManagedHandler(evVal, profile.provider) {
				missing = append(missing, ev)
			}
		}
		if missing == nil {
			missing = []string{}
		}
		installed := !disabled && len(missing) == 0
		reason := ""
		if !installed {
			if disabled {
				reason = "disabled"
			} else {
				reason = "missing_events"
			}
		}
		return HookDiagnosis{
			Supported:     true,
			Provider:      profile.provider,
			TargetPath:    targetPath,
			TargetKind:    nonEmpty(profile.targetKind, "hooks.json"),
			HookName:      agyManagedHookName,
			SyncMode:      "hook",
			Installed:     installed,
			Disabled:      disabled,
			MissingEvents: missing,
			Events:        profile.events,
			Reason:        reason,
		}

	case providers.HookAdapterJSONHooks:
		cfg, readErr := readHookDocument(targetPath)
		if readErr != nil {
			return hookReadFailure(profile, targetPath, readErr)
		}
		hooksObj, _ := cfg["hooks"].(map[string]any)
		var missing []string
		for _, ev := range profile.events {
			var groups any
			if hooksObj != nil {
				groups = hooksObj[ev]
			}
			if !jsonEventHasManagedHandler(groups, profile.provider) {
				missing = append(missing, ev)
			}
		}
		if missing == nil {
			missing = []string{}
		}
		var codexFeat *CodexFeaturesView
		disabled := false
		if profile.featureFlag {
			feat := diagnoseCodexFeatures(ctx, opts)
			if feat.Error != "" {
				return hookReadFailure(profile, targetPath, errors.New(feat.Error))
			}
			codexFeat = &feat
			disabled = feat.Disabled
		}
		installed := len(missing) == 0 && !disabled
		reason := ""
		if !installed {
			if disabled {
				reason = "disabled"
			} else {
				reason = "missing_events"
			}
		}
		return HookDiagnosis{
			Supported:     true,
			Provider:      profile.provider,
			TargetPath:    targetPath,
			TargetKind:    profile.targetKind,
			SyncMode:      "hook",
			Installed:     installed,
			Disabled:      disabled,
			MissingEvents: missing,
			Events:        profile.events,
			Reason:        reason,
			CodexFeatures: codexFeat,
		}
	default:
		return HookDiagnosis{
			Supported:     false,
			Provider:      profile.provider,
			SyncMode:      profile.syncMode,
			MissingEvents: []string{},
			Events:        []string{},
			Reason:        "unsupported_hook_adapter",
		}
	}
}

// InstallAppHooks 为已安装的 CLI 应用批量写入官方会话 Hook（保留用户配置）。
func (m *Manager) InstallAppHooks(ctx context.Context, providersList []string, opts Options) HooksActionResponse {
	cat := resolveCatalog(opts)
	inv := m.ListManagedApps(ctx, opts)
	cliMap := make(map[string]AppView)
	for _, app := range inv.Apps {
		if app.Type == "cli" {
			cliMap[app.Provider] = app
		}
	}
	results := make([]HookActionResult, 0, len(providersList))
	allOK := len(providersList) > 0
	for _, raw := range providersList {
		norm := strings.ToLower(strings.TrimSpace(raw))
		app, found := cliMap[norm]
		if !found || !app.Installed {
			results = append(results, HookActionResult{Provider: norm, OK: false, Verified: false, Error: "请先安装该 CLI，再启用即时刷新。"})
			allOK = false
			continue
		}
		if !app.HookSupported {
			results = append(results, HookActionResult{Provider: norm, OK: false, Verified: false, Error: "该应用没有可用的官方会话 Hook。"})
			allOK = false
			continue
		}
		outcome := installSingleProviderHook(ctx, cat, norm, opts)
		verified := DiagnoseProviderHooks(ctx, norm, cat, opts)
		ok := outcome.OK && verified.Installed
		if !ok {
			allOK = false
		}
		results = append(results, HookActionResult{
			Provider:      norm,
			OK:            ok,
			Verified:      ok,
			Error:         outcome.Error,
			Installed:     verified.Installed,
			MissingEvents: verified.MissingEvents,
			Reason:        verified.Reason,
			Result:        &outcome,
		})
	}
	m.InvalidateCache("")
	return HooksActionResponse{OK: allOK, Results: results}
}

// UninstallAppHooks 为指定 CLI 卸载 AIH 托管的官方会话 Hook（保留用户自定义 hook）。
func (m *Manager) UninstallAppHooks(ctx context.Context, providersList []string, opts Options) HooksActionResponse {
	cat := resolveCatalog(opts)
	inv := m.ListManagedApps(ctx, opts)
	cliMap := make(map[string]AppView)
	for _, app := range inv.Apps {
		if app.Type == "cli" {
			cliMap[app.Provider] = app
		}
	}
	results := make([]HookActionResult, 0, len(providersList))
	allOK := len(providersList) > 0
	for _, raw := range providersList {
		norm := strings.ToLower(strings.TrimSpace(raw))
		app, found := cliMap[norm]
		if !found || !app.HookSupported {
			results = append(results, HookActionResult{Provider: norm, OK: false, Verified: false, Error: "该应用没有可用的官方会话 Hook。"})
			allOK = false
			continue
		}
		outcome := uninstallSingleProviderHook(cat, norm, opts)
		verified := DiagnoseProviderHooks(ctx, norm, cat, opts)
		ok := outcome.OK && verified.Error == "" && !verified.Installed
		if !ok {
			allOK = false
		}
		results = append(results, HookActionResult{
			Provider:  norm,
			OK:        ok,
			Verified:  ok,
			Error:     nonEmpty(outcome.Error, verified.Error),
			Installed: verified.Installed,
			Changed:   outcome.Changed,
			Reason:    verified.Reason,
			Result:    &outcome,
		})
	}
	m.InvalidateCache("")
	return HooksActionResponse{OK: allOK, Results: results}
}

func resolveDefaultServerRootURL(ctx context.Context, opts Options) string {
	host := strings.TrimSpace(opts.ServerHost)
	port := opts.ServerPort
	if strings.TrimSpace(opts.AIHomeDir) != "" && (host == "" || port <= 0) {
		if src, err := webuiserverconfigapi.OpenSource(opts.AIHomeDir); err == nil {
			if raw, found, readErr := src.ReadServerConfig(ctx); readErr == nil && found {
				var parsed struct {
					Host string `json:"host"`
					Port int    `json:"port"`
				}
				if json.Unmarshal([]byte(raw), &parsed) == nil {
					if host == "" {
						host = strings.TrimSpace(parsed.Host)
					}
					if port <= 0 {
						port = parsed.Port
					}
				}
			}
		}
	}
	if port <= 0 {
		if pEnv := envLookup(resolveEnvMap(opts), "AIH_SERVER_PORT"); pEnv != "" {
			if n, err := strconv.Atoi(pEnv); err == nil && serverconfig.IsValidPort(n) {
				port = n
			}
		}
	}
	// 主机/端口归一与 URL 拼接只在 application/serverconfig 定义一次；
	// 这里的 "::" 也要回落回环，因为它是"连回本机"而不是"绑定网卡"。
	return serverconfig.BaseURL(serverconfig.NormalizeLoopbackHost(strings.Trim(host, "[]")), port, "")
}


func resolveRepoFile(opts Options, relParts ...string) string {
	rel := filepath.Join(relParts...)
	var searchRoots []string
	if root := envLookup(resolveEnvMap(opts), "AIH_ROOT"); root != "" {
		searchRoots = append(searchRoots, root)
	}
	if cwd, err := os.Getwd(); err == nil {
		searchRoots = append(searchRoots, cwd)
	}
	if exe, err := os.Executable(); err == nil {
		searchRoots = append(searchRoots, filepath.Dir(exe))
	}
	for _, start := range searchRoots {
		dir := start
		for depth := 0; depth < 8; depth++ {
			cand := filepath.Join(dir, rel)
			if fileExists(cand) {
				return cand
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return rel
}

func resolveSenderCommand(profile resolvedHookProfile, event string, opts Options) string {
	return providersessionhook.BuildCommand(providersessionhook.CommandOptions{
		Provider:       profile.provider,
		EventName:      event,
		SenderExecPath: opts.SenderExecPath,
		Platform:       resolvePlatform(opts),
	})
}

func hookHandlerTimeout(profile resolvedHookProfile) int {
	if profile.timeoutUnit == providers.HookTimeoutMilliseconds {
		return defaultHookTimeoutSeconds * 1000
	}
	return defaultHookTimeoutSeconds
}

func jsonEventHasManagedHandler(groupsVal any, provider string) bool {
	groups, _ := groupsVal.([]any)
	for _, g := range groups {
		gm, _ := g.(map[string]any)
		if gm == nil {
			continue
		}
		hooks, _ := gm["hooks"].([]any)
		for _, h := range hooks {
			hm, _ := h.(map[string]any)
			if hm != nil {
				if cmd, ok := hm["command"].(string); ok && isManagedCommandString(cmd, provider) {
					return true
				}
			}
		}
	}
	return false
}

func agyEventHasManagedHandler(eventVal any, provider string) bool {
	items, _ := eventVal.([]any)
	for _, item := range items {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		if cmd, ok := m["command"].(string); ok && isManagedCommandString(cmd, provider) {
			return true
		}
		hooks, _ := m["hooks"].([]any)
		for _, h := range hooks {
			hm, _ := h.(map[string]any)
			if hm != nil {
				if cmd, ok := hm["command"].(string); ok && isManagedCommandString(cmd, provider) {
					return true
				}
			}
		}
	}
	return false
}

func removeManagedHandlersFromHooksMap(hooks map[string]any, provider string) (map[string]any, bool) {
	if len(hooks) == 0 {
		return map[string]any{}, false
	}
	out := make(map[string]any)
	changed := false
	for ev, rawGroups := range hooks {
		groups, ok := rawGroups.([]any)
		if !ok {
			out[ev] = rawGroups
			continue
		}
		var keptGroups []any
		eventChanged := false
		for _, rawGroup := range groups {
			gm, _ := rawGroup.(map[string]any)
			if gm == nil {
				keptGroups = append(keptGroups, rawGroup)
				continue
			}
			innerHooks, ok := gm["hooks"].([]any)
			if !ok {
				keptGroups = append(keptGroups, rawGroup)
				continue
			}
			var keptInner []any
			for _, rawHook := range innerHooks {
				hm, _ := rawHook.(map[string]any)
				cmd, _ := hm["command"].(string)
				if isManagedCommandString(cmd, provider) {
					changed = true
					eventChanged = true
					continue
				}
				keptInner = append(keptInner, rawHook)
			}
			if len(keptInner) == 0 {
				if len(innerHooks) == 0 {
					keptGroups = append(keptGroups, rawGroup)
				}
				continue
			}
			groupCopy := cloneJSONMap(gm)
			groupCopy["hooks"] = keptInner
			keptGroups = append(keptGroups, groupCopy)
		}
		if !eventChanged {
			out[ev] = rawGroups
		} else if len(keptGroups) > 0 {
			out[ev] = keptGroups
		}
	}
	return out, changed
}

func buildOpenCodePluginSource(senderExec string) string {
	litBytes, _ := json.Marshal(senderExec)
	return signedOpenCodeSource(strings.ReplaceAll(openCodePluginTemplate, "__AIH_SENDER_EXEC_LITERAL__", string(litBytes)))
}

const openCodePluginTemplate = `// aih-session-hook: AIH 托管的 opencode 会话生命周期桥(自动生成,勿手改)
// 作用:把 opencode 事件总线的会话开始/结束信号交给 Go 发送器投递。
// 插件源码不包含接收端 URL/端口:发送器在投递时按 config:server 解析。
// 兼容 opencode v2(default 对象 + setup)与 v1>=1.18.29(default 对象 + server() 旧式 hooks)。
import { spawn } from 'node:child_process';
const AIH_SENDER_EXEC = __AIH_SENDER_EXEC_LITERAL__;
const aihActiveSessions = new Set();
let aihV2SetupActive = false;

function aihPost(eventName, sessionID) {
  if (!AIH_SENDER_EXEC || !sessionID) return;
  try {
    // fire-and-forget:不 await,失败静默(不能拖慢/中断会话流)。
    const child = spawn(AIH_SENDER_EXEC, [
      '__provider-hook', '--aih-provider-session-hook',
      '--provider', 'opencode', '--event', eventName
    ], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    child.on('error', () => {});
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ sessionId: sessionID, eventName: eventName, at: Date.now() }));
    }
  } catch (_error) { /* ignore */ }
}

function aihHandleV2Event(event) {
  if (!event || typeof event !== 'object') return;
  const type = String(event.type || '');
  const data = event.data || {};
  const sessionID = data.sessionID || event.sessionID || '';
  if (!sessionID) return;

  if (type === 'session.execution.started') {
    if (!aihActiveSessions.has(sessionID)) {
      aihActiveSessions.add(sessionID);
      aihPost('UserPromptSubmit', sessionID);
    }
    return;
  }
  if (type === 'session.execution.succeeded' || type === 'session.execution.failed'
    || type === 'session.execution.interrupted') {
    if (aihActiveSessions.delete(sessionID)) aihPost('Stop', sessionID);
  }
}

function aihHandleV1Event(event) {
  if (!event || typeof event !== 'object') return;
  const type = String(event.type || '');
  const props = event.properties || {};
  const info = props.info || {};
  const sessionID = props.sessionID || info.sessionID || info.id
    || (props.part && props.part.sessionID) || '';
  if (!sessionID) return;

  if (type === 'session.idle') {
    if (aihActiveSessions.delete(sessionID)) aihPost('Stop', sessionID);
    return;
  }
  if (type === 'message.updated' || type === 'message.part.updated'
    || type === 'message.part.delta' || type === 'session.status') {
    if (!aihActiveSessions.has(sessionID)) {
      aihActiveSessions.add(sessionID);
      aihPost('UserPromptSubmit', sessionID);
    }
  }
}

export default {
  id: 'aih-session-hook',
  async setup(ctx) {
    if (!ctx || !ctx.event || typeof ctx.event.subscribe !== 'function') return;
    aihV2SetupActive = true;
    const controller = new AbortController();
    const consume = async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          try { aihHandleV2Event(event); } catch (_error) { /* ignore */ }
        }
      } catch (_error) { /* ignore */ }
    };
    consume();
    return () => { try { controller.abort(); } catch (_error) { /* ignore */ } };
  },
  server: async () => ({
    event: async ({ event }) => {
      if (aihV2SetupActive) return;
      aihHandleV1Event(event);
    }
  })
};
`
