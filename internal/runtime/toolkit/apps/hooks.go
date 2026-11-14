package apps

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/runtime/providersessionhook"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
	"github.com/madou1217/ai_home/internal/transport/http/webuiserverconfigapi"
)

const (
	managedHookMarker         = providersessionhook.Marker
	agyManagedHookName        = "aih-session-sync"
	openCodePluginMarker      = "aih-session-hook"
	defaultHookTimeoutSeconds = 10
	defaultServerPort         = 9527
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
	providerRefRe          = regexp.MustCompile(`--provider\s+['"]?([a-z0-9._-]+)['"]?`)
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
		content, _ := os.ReadFile(targetPath)
		text := string(content)
		hasPlugin := strings.Contains(text, openCodePluginMarker) && strings.Contains(text, "AIH_RECEIVER_URL")
		missing := []string{}
		reason := ""
		if !hasPlugin {
			missing = append([]string{}, profile.events...)
			reason = "missing_events"
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
		cfg := readJSONObjectSafe(targetPath)
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
		cfg := readJSONObjectSafe(targetPath)
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
			Verified:      verified.Installed,
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
		ok := outcome.OK && !verified.Installed
		if !ok {
			allOK = false
		}
		results = append(results, HookActionResult{
			Provider:  norm,
			OK:        ok,
			Verified:  !verified.Installed,
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
			if n, err := strconv.Atoi(pEnv); err == nil && n > 0 && n <= 65535 {
				port = n
			}
		}
	}
	if port <= 0 {
		port = defaultServerPort
	}
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		host = "127.0.0.1"
	} else if strings.Contains(host, ":") && !strings.HasPrefix(host, "[") {
		host = "[" + host + "]"
	}
	return fmt.Sprintf("http://%s:%d", host, port)
}

func resolveReceiverBaseURL(ctx context.Context, opts Options) string {
	if explicit := strings.TrimSpace(opts.ReceiverURL); explicit != "" {
		return explicit
	}
	return resolveDefaultServerRootURL(ctx, opts) + "/v0/webui/session-events/provider-hook"
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

func resolveSenderCommand(profile resolvedHookProfile, event, receiverBase string, opts Options) string {
	return providersessionhook.BuildCommand(providersessionhook.CommandOptions{
		Provider:       profile.provider,
		EventName:      event,
		ReceiverURL:    receiverBase,
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

func installSingleProviderHook(ctx context.Context, cat *providers.Catalog, provider string, opts Options) HookOperationOutcome {
	profile := resolveProviderHookProfile(cat, provider)
	if !profile.supported {
		return HookOperationOutcome{OK: false, Provider: provider, Error: "unsupported_provider"}
	}
	targetPath := hookTargetPath(profile, opts)
	receiverBase := resolveReceiverBaseURL(ctx, opts)

	if profile.adapter == providers.HookAdapterOpenCodePlugin {
		src := buildOpenCodePluginSource(receiverBase)
		prev, _ := os.ReadFile(targetPath)
		changed := string(prev) != src
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return HookOperationOutcome{OK: false, Provider: provider, Error: err.Error()}
		}
		if err := os.WriteFile(targetPath, []byte(src), 0o644); err != nil {
			return HookOperationOutcome{OK: false, Provider: provider, Error: err.Error()}
		}
		return HookOperationOutcome{
			OK: true, Provider: provider, TargetPath: targetPath, TargetKind: "plugin.js",
			Changed: changed, Events: []string{"UserPromptSubmit", "Stop"}, ReceiverURL: receiverBase,
		}
	}

	beforeBytes, _ := os.ReadFile(targetPath)
	beforeObj := readJSONObjectSafe(targetPath)

	var nextObj map[string]any
	if profile.adapter == providers.HookAdapterAgyNamedHooks {
		nextObj = cloneJSONMap(beforeObj)
		hookDef := map[string]any{"enabled": true}
		for _, ev := range profile.events {
			handler := map[string]any{
				"type":    "command",
				"command": resolveSenderCommand(profile, ev, receiverBase, opts),
				"timeout": hookHandlerTimeout(profile),
			}
			if ev == "PreToolUse" || ev == "PostToolUse" {
				hookDef[ev] = []any{map[string]any{"matcher": "*", "hooks": []any{handler}}}
			} else {
				hookDef[ev] = []any{handler}
			}
		}
		nextObj[agyManagedHookName] = hookDef
	} else {
		nextObj = cloneJSONMap(beforeObj)
		rawHooks, _ := nextObj["hooks"].(map[string]any)
		cleanedHooks, _ := removeManagedHandlersFromHooksMap(rawHooks, profile.provider)
		if cleanedHooks == nil {
			cleanedHooks = make(map[string]any)
		}
		for _, ev := range profile.events {
			handler := map[string]any{
				"type":    "command",
				"command": resolveSenderCommand(profile, ev, receiverBase, opts),
				"timeout": hookHandlerTimeout(profile),
			}
			group := map[string]any{"hooks": []any{handler}}
			if matcher := profile.eventMatchers[ev]; matcher != "" {
				group["matcher"] = matcher
			}
			existing, _ := cleanedHooks[ev].([]any)
			cleanedHooks[ev] = append(existing, group)
		}
		nextObj["hooks"] = cleanedHooks
	}

	nextBytes, err := json.MarshalIndent(nextObj, "", "  ")
	if err != nil {
		return HookOperationOutcome{OK: false, Provider: provider, Error: err.Error()}
	}
	nextBytes = append(nextBytes, '\n')
	changed := string(beforeBytes) != string(nextBytes)
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return HookOperationOutcome{OK: false, Provider: provider, Error: err.Error()}
	}
	if err := os.WriteFile(targetPath, nextBytes, 0o644); err != nil {
		return HookOperationOutcome{OK: false, Provider: provider, Error: err.Error()}
	}

	var codexFeat *CodexFeaturesView
	if profile.featureFlag {
		cf := enableCodexHooksFeature(ctx, opts)
		codexFeat = &cf
		if cf.Changed {
			changed = true
		}
	}
	return HookOperationOutcome{
		OK: true, Provider: provider, TargetPath: targetPath, TargetKind: profile.targetKind,
		Changed: changed, Events: profile.events, CodexFeatures: codexFeat,
	}
}

func uninstallSingleProviderHook(cat *providers.Catalog, provider string, opts Options) HookOperationOutcome {
	profile := resolveProviderHookProfile(cat, provider)
	if !profile.supported {
		return HookOperationOutcome{OK: false, Provider: provider, Error: "unsupported_provider"}
	}
	targetPath := hookTargetPath(profile, opts)
	if profile.adapter == providers.HookAdapterOpenCodePlugin {
		changed := false
		if fileExists(targetPath) {
			if err := os.Remove(targetPath); err != nil {
				return HookOperationOutcome{OK: false, Provider: provider, Error: err.Error()}
			}
			changed = true
		}
		return HookOperationOutcome{OK: true, Provider: provider, TargetPath: targetPath, TargetKind: "plugin.js", Changed: changed}
	}

	obj := readJSONObjectSafe(targetPath)
	changed := false
	next := cloneJSONMap(obj)
	if profile.adapter == providers.HookAdapterAgyNamedHooks {
		if _, exists := next[agyManagedHookName]; exists {
			delete(next, agyManagedHookName)
			changed = true
		}
	} else {
		rawHooks, _ := next["hooks"].(map[string]any)
		cleaned, didChange := removeManagedHandlersFromHooksMap(rawHooks, profile.provider)
		changed = didChange
		if len(cleaned) > 0 {
			next["hooks"] = cleaned
		} else {
			delete(next, "hooks")
		}
	}
	if changed {
		data, err := json.MarshalIndent(next, "", "  ")
		if err != nil {
			return HookOperationOutcome{OK: false, Provider: provider, Error: err.Error()}
		}
		data = append(data, '\n')
		if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
			return HookOperationOutcome{OK: false, Provider: provider, Error: err.Error()}
		}
		if err := os.WriteFile(targetPath, data, 0o644); err != nil {
			return HookOperationOutcome{OK: false, Provider: provider, Error: err.Error()}
		}
	}
	return HookOperationOutcome{OK: true, Provider: provider, TargetPath: targetPath, TargetKind: profile.targetKind, Changed: changed}
}

func isManagedCommandString(cmd, provider string) bool {
	if !strings.Contains(cmd, managedHookMarker) {
		return false
	}
	if provider == "" {
		return true
	}
	m := providerRefRe.FindStringSubmatch(cmd)
	if len(m) == 2 {
		return strings.EqualFold(m[1], provider)
	}
	return strings.Contains(strings.ToLower(cmd), "provider="+strings.ToLower(provider))
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
		groups, _ := rawGroups.([]any)
		var keptGroups []any
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
					continue
				}
				keptInner = append(keptInner, rawHook)
			}
			if len(keptInner) == 0 {
				if len(innerHooks) > 0 {
					changed = true
				}
				continue
			}
			groupCopy := cloneJSONMap(gm)
			groupCopy["hooks"] = keptInner
			keptGroups = append(keptGroups, groupCopy)
		}
		if len(keptGroups) > 0 {
			out[ev] = keptGroups
		} else if len(groups) > 0 {
			changed = true
		}
	}
	return out, changed
}

func readJSONObjectSafe(target string) map[string]any {
	raw, err := os.ReadFile(target)
	if err != nil {
		return map[string]any{}
	}
	var out map[string]any
	if json.Unmarshal(raw, &out) != nil || out == nil {
		return map[string]any{}
	}
	return out
}

func cloneJSONMap(src map[string]any) map[string]any {
	if src == nil {
		return map[string]any{}
	}
	b, err := json.Marshal(src)
	if err != nil {
		return map[string]any{}
	}
	var dst map[string]any
	if json.Unmarshal(b, &dst) != nil || dst == nil {
		return map[string]any{}
	}
	return dst
}

func diagnoseCodexFeatures(ctx context.Context, opts Options) CodexFeaturesView {
	home := ResolveHostHome(opts)
	cfgPath := joinPlatformPath(resolvePlatform(opts), home, ".codex", "config.toml")
	raw, _ := os.ReadFile(cfgPath)
	ver := probeCodexVersion(ctx, opts)
	flagName := resolveCodexHooksFlagName(ver)

	view := CodexFeaturesView{
		Path:         cfgPath,
		FlagName:     flagName,
		CodexVersion: ver,
		Enabled:      true,
	}
	lines := strings.Split(string(raw), "\n")
	start, end, ok := findFeaturesSection(lines)
	if !ok {
		return view
	}
	activeFlag := ""
	var activeVal *bool
	for _, line := range lines[start+1 : end] {
		k, v, okSplit := splitTomlKV(line)
		if !okSplit {
			continue
		}
		if _, known := codexHooksFeatureFlags[k]; !known {
			continue
		}
		if b, isBool := parseTomlBool(v); isBool {
			activeFlag = k
			activeVal = &b
		}
	}
	view.ActiveFlagName = activeFlag
	view.Explicit = activeFlag != ""
	view.Enabled = activeVal == nil || *activeVal
	view.Disabled = activeVal != nil && !*activeVal
	return view
}

func enableCodexHooksFeature(ctx context.Context, opts Options) CodexFeaturesView {
	view := diagnoseCodexFeatures(ctx, opts)
	shouldPatch := view.Explicit && (!view.Enabled || view.ActiveFlagName != view.FlagName)
	if !shouldPatch {
		return CodexFeaturesView{
			Path:         view.Path,
			FlagName:     view.FlagName,
			CodexVersion: view.CodexVersion,
		}
	}
	raw, _ := os.ReadFile(view.Path)
	lines := strings.Split(string(raw), "\n")
	start, end, found := findFeaturesSection(lines)
	var nextText string
	if !found {
		base := strings.TrimRightFunc(string(raw), unicode.IsSpace)
		prefix := ""
		if base != "" {
			prefix = base + "\n\n"
		}
		nextText = prefix + "[features]\n" + view.FlagName + " = true\n"
	} else {
		var preserved []string
		for _, line := range lines[start+1 : end] {
			if k, _, okSplit := splitTomlKV(line); okSplit {
				if _, known := codexHooksFeatureFlags[k]; known {
					continue
				}
			}
			preserved = append(preserved, line)
		}
		var next []string
		next = append(next, lines[:start]...)
		next = append(next, "[features]", view.FlagName+" = true")
		next = append(next, preserved...)
		next = append(next, lines[end:]...)
		nextText = strings.TrimRight(strings.Join(next, "\n"), "\n") + "\n"
	}
	changed := string(raw) != nextText
	if changed {
		_ = os.MkdirAll(filepath.Dir(view.Path), 0o755)
		_ = os.WriteFile(view.Path, []byte(nextText), 0o644)
	}
	return CodexFeaturesView{
		Path:           view.Path,
		Changed:        changed,
		FlagName:       view.FlagName,
		CodexVersion:   view.CodexVersion,
		DisabledBefore: view.Disabled,
	}
}

func probeCodexVersion(ctx context.Context, opts Options) string {
	codexPath := ResolveProviderCLIPath("codex", opts)
	if codexPath == "" {
		codexPath = "codex"
	}
	probeCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	res := opts.exec().Run(probeCtx, codexPath, []string{"--version"}, environment.ExecOptions{Timeout: time.Second})
	if !res.OK {
		return ""
	}
	return strings.TrimSpace(res.Stdout)
}

func resolveCodexHooksFlagName(codexVersion string) string {
	inst, ok1 := parseVersionTuple(codexVersion)
	sw, ok2 := parseVersionTuple(codexSwitchVersion)
	if !ok1 || !ok2 {
		return "hooks"
	}
	for i := 0; i < 3; i++ {
		if inst[i] < sw[i] {
			return "codex_hooks"
		}
		if inst[i] > sw[i] {
			return "hooks"
		}
	}
	return "hooks"
}

func findFeaturesSection(lines []string) (int, int, bool) {
	start := -1
	for i, line := range lines {
		if strings.TrimSpace(line) == "[features]" {
			start = i
			break
		}
	}
	if start < 0 {
		return 0, 0, false
	}
	end := start + 1
	for end < len(lines) {
		if strings.HasPrefix(strings.TrimSpace(lines[end]), "[") {
			break
		}
		end++
	}
	return start, end, true
}

func splitTomlKV(line string) (string, string, bool) {
	trimmed := strings.TrimSpace(line)
	idx := strings.IndexByte(trimmed, '=')
	if idx <= 0 {
		return "", "", false
	}
	k := strings.TrimSpace(trimmed[:idx])
	for _, r := range k {
		if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' || r == '-') {
			return "", "", false
		}
	}
	return k, strings.TrimSpace(trimmed[idx+1:]), true
}

func parseTomlBool(val string) (bool, bool) {
	s := val
	if idx := strings.IndexByte(s, '#'); idx >= 0 {
		s = s[:idx]
	}
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "true":
		return true, true
	case "false":
		return false, true
	default:
		return false, false
	}
}

func buildOpenCodePluginSource(receiverURL string) string {
	litBytes, _ := json.Marshal(receiverURL)
	return strings.ReplaceAll(openCodePluginTemplate, "__AIH_RECEIVER_URL_LITERAL__", string(litBytes))
}

const openCodePluginTemplate = "// aih-session-hook: AIH 托管的 opencode 会话生命周期桥(自动生成,勿手改)\n// 作用:把 opencode 事件总线(随 opencode 主版本)的会话开始/结束信号 POST 给 aih,\n// 驱动 webUI 实时 pending 状态。兼容 opencode v2(default 对象 + setup)与\n// v1>=1.18.29(default 对象 + server() 旧式 hooks)。\nconst AIH_RECEIVER_URL = __AIH_RECEIVER_URL_LITERAL__;\nconst aihActiveSessions = new Set();\nlet aihV2SetupActive = false;\n\nfunction aihPost(eventName, sessionID) {\n  if (!AIH_RECEIVER_URL || !sessionID) return;\n  const url = AIH_RECEIVER_URL\n    + '?provider=opencode&event=' + encodeURIComponent(eventName)\n    + '&sessionId=' + encodeURIComponent(sessionID);\n  try {\n    // fire-and-forget:不 await,失败静默(不能拖慢/中断会话流)。\n    const p = fetch(url, {\n      method: 'POST',\n      headers: { 'Content-Type': 'application/json' },\n      body: JSON.stringify({ eventName: eventName, sessionId: sessionID, at: Date.now() })\n    });\n    if (p && typeof p.catch === 'function') p.catch(() => {});\n  } catch (_error) { /* ignore */ }\n}\n\nfunction aihHandleV2Event(event) {\n  if (!event || typeof event !== 'object') return;\n  const type = String(event.type || '');\n  const data = event.data || {};\n  const sessionID = data.sessionID || event.sessionID || '';\n  if (!sessionID) return;\n\n  if (type === 'session.execution.started') {\n    if (!aihActiveSessions.has(sessionID)) {\n      aihActiveSessions.add(sessionID);\n      aihPost('UserPromptSubmit', sessionID);\n    }\n    return;\n  }\n  if (type === 'session.execution.succeeded' || type === 'session.execution.failed'\n    || type === 'session.execution.interrupted') {\n    if (aihActiveSessions.delete(sessionID)) aihPost('Stop', sessionID);\n  }\n}\n\nfunction aihHandleV1Event(event) {\n  if (!event || typeof event !== 'object') return;\n  const type = String(event.type || '');\n  const props = event.properties || {};\n  const info = props.info || {};\n  const sessionID = props.sessionID || info.sessionID || info.id\n    || (props.part && props.part.sessionID) || '';\n  if (!sessionID) return;\n\n  if (type === 'session.idle') {\n    if (aihActiveSessions.delete(sessionID)) aihPost('Stop', sessionID);\n    return;\n  }\n  if (type === 'message.updated' || type === 'message.part.updated'\n    || type === 'message.part.delta' || type === 'session.status') {\n    if (!aihActiveSessions.has(sessionID)) {\n      aihActiveSessions.add(sessionID);\n      aihPost('UserPromptSubmit', sessionID);\n    }\n  }\n}\n\nexport default {\n  id: 'aih-session-hook',\n  async setup(ctx) {\n    if (!ctx || !ctx.event || typeof ctx.event.subscribe !== 'function') return;\n    aihV2SetupActive = true;\n    const controller = new AbortController();\n    const consume = async () => {\n      try {\n        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {\n          try { aihHandleV2Event(event); } catch (_error) { /* ignore */ }\n        }\n      } catch (_error) { /* ignore */ }\n    };\n    consume();\n    return () => { try { controller.abort(); } catch (_error) { /* ignore */ } };\n  },\n  server: async () => ({\n    event: async ({ event }) => {\n      if (aihV2SetupActive) return;\n      aihHandleV1Event(event);\n    }\n  })\n};\n"
