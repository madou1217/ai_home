package apps

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage/providerroot"
	"github.com/madou1217/ai_home/internal/runtime/codexpreferences"
	"github.com/madou1217/ai_home/internal/runtime/configsnapshot"
	"github.com/madou1217/ai_home/internal/runtime/providerconfigs"
)

func hookReadFailure(profile resolvedHookProfile, target string, err error) HookDiagnosis {
	return HookDiagnosis{Supported: profile.supported, Provider: profile.provider, TargetPath: target, TargetKind: profile.targetKind, SyncMode: profile.syncMode, Events: profile.events, MissingEvents: profile.events, Reason: err.Error(), Error: err.Error()}
}
func installSingleProviderHook(ctx context.Context, cat *providers.Catalog, provider string, opts Options) HookOperationOutcome {
	profile := resolveProviderHookProfile(cat, provider)
	if len(opts.HookEvents) > 0 {
		profile.events = uniqueStrings(opts.HookEvents)
	}
	hookName := nonEmpty(strings.TrimSpace(opts.HookName), agyManagedHookName)
	if !profile.supported {
		return HookOperationOutcome{Provider: provider, Error: "unsupported_provider"}
	}
	target := hookTargetPath(profile, opts)
	receiver := resolveReceiverBaseURL(ctx, opts)
	outcome := HookOperationOutcome{DryRun: opts.HookDryRun, Provider: provider, TargetPath: target, TargetKind: profile.targetKind, Events: profile.events}
	if profile.adapter == providers.HookAdapterOpenCodePlugin {
		if info, err := os.Lstat(target); err == nil && info.Mode()&os.ModeSymlink != 0 {
			outcome.Error = "hook_plugin_symlink_conflict"
			return outcome
		}
	}

	var features *CodexFeaturesView
	if profile.featureFlag {
		// Validate Codex preferences before touching the separate hooks JSON file.
		home := ResolveHostHome(opts)
		doc, err := codexpreferences.Read(filepath.Join(home, providerroot.ConfigDir("codex")))
		if err != nil {
			outcome.Error = err.Error()
			return outcome
		}
		raw, err := os.ReadFile(doc.Path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			outcome.Error = err.Error()
			return outcome
		}
		if len(raw) > 0 && !providerconfigs.ValidateContent(string(raw), "toml").Valid {
			outcome.Error = "hook_codex_config_invalid"
			return outcome
		}
	}
	changed, err := updateHookFile(target, opts.HookDryRun, func(before configsnapshot.Snapshot) ([]byte, bool, error) {
		if profile.adapter == providers.HookAdapterOpenCodePlugin {
			if before.Exists && !ownedOpenCodeSource(before.Content) {
				return nil, false, errors.New("hook_plugin_ownership_conflict")
			}
			return []byte(buildOpenCodePluginSource(receiver)), false, nil
		}
		object, err := parseHookDocument(before)
		if err != nil {
			return nil, false, err
		}
		next := cloneJSONMap(object)
		if profile.adapter == providers.HookAdapterAgyNamedHooks {
			hook := map[string]any{}
			if prior, exists := next[hookName]; exists {
				if !agyHookOwned(prior, provider, opts.SenderExecPath) {
					return nil, false, errors.New("hook_entry_ownership_conflict")
				}
				hook = cloneJSONMap(prior.(map[string]any))
			}
			hook["enabled"] = true
			for _, event := range profile.events {
				handler := map[string]any{"type": "command", "command": resolveSenderCommand(profile, event, opts), "timeout": configuredHookTimeout(profile, opts)}
				if event == "PreToolUse" || event == "PostToolUse" {
					hook[event] = []any{map[string]any{"matcher": "*", "hooks": []any{handler}}}
				} else {
					hook[event] = []any{handler}
				}
			}
			next[hookName] = hook
		} else {
			hooks, _ := next["hooks"].(map[string]any)
			cleaned, _ := removeManagedHandlersFromHooksMap(hooks, provider, opts.SenderExecPath)
			for _, event := range profile.events {
				handler := map[string]any{"type": "command", "command": resolveSenderCommand(profile, event, opts), "timeout": configuredHookTimeout(profile, opts)}
				group := map[string]any{"hooks": []any{handler}}
				if matcher := profile.eventMatchers[event]; matcher != "" {
					group["matcher"] = matcher
				}
				existing, _ := cleaned[event].([]any)
				cleaned[event] = append(existing, group)
			}
			next["hooks"] = cleaned
		}
		// Compare semantic JSON before rewriting: a repeated install must not change
		// formatting, numeric spelling, mode or inode of an already configured file.
		prior, _ := json.Marshal(object)
		following, err := json.Marshal(next)
		if err != nil {
			return nil, false, err
		}
		if bytes.Equal(prior, following) {
			return nil, false, nil
		}
		encoded, err := json.MarshalIndent(next, "", "  ")
		return append(encoded, '\n'), false, err
	})
	if err != nil {
		outcome.Error = err.Error()
		outcome.Changed = changed
		return outcome
	}
	if profile.featureFlag {
		value, err := enableCodexHooksFeatureSafe(ctx, opts)
		features = &value
		if err != nil {
			outcome.Error = err.Error()
			outcome.Changed = changed
			outcome.CodexFeatures = features
			return outcome
		}
		changed = changed || value.Changed
	}
	outcome.OK = true
	outcome.Changed = changed
	outcome.CodexFeatures = features
	if profile.adapter == providers.HookAdapterOpenCodePlugin {
		outcome.TargetKind = "plugin.js"
		outcome.ReceiverURL = receiver
	}
	return outcome
}

func uninstallSingleProviderHook(cat *providers.Catalog, provider string, opts Options) HookOperationOutcome {
	profile := resolveProviderHookProfile(cat, provider)
	if len(opts.HookEvents) > 0 {
		profile.events = uniqueStrings(opts.HookEvents)
	}
	hookName := nonEmpty(strings.TrimSpace(opts.HookName), agyManagedHookName)
	if !profile.supported {
		return HookOperationOutcome{Provider: provider, Error: "unsupported_provider"}
	}
	target := hookTargetPath(profile, opts)
	out := HookOperationOutcome{DryRun: opts.HookDryRun, Provider: provider, TargetPath: target, TargetKind: profile.targetKind}

	initial, readErr := configsnapshot.Read(target)
	if readErr != nil && !errors.Is(readErr, configsnapshot.ErrRecovery) {
		out.Error = readErr.Error()
		return out
	}
	if readErr == nil && !initial.Exists {
		out.OK = true
		return out
	}
	if profile.adapter == providers.HookAdapterOpenCodePlugin {
		if info, err := os.Lstat(target); err == nil && info.Mode()&os.ModeSymlink != 0 {
			out.Error = "hook_plugin_symlink_conflict"
			return out
		}
	}

	changed, err := updateHookFile(target, opts.HookDryRun, func(before configsnapshot.Snapshot) ([]byte, bool, error) {
		if !before.Exists {
			return nil, false, nil
		}
		if profile.adapter == providers.HookAdapterOpenCodePlugin {
			if !ownedOpenCodeSource(before.Content) {
				return nil, false, errors.New("hook_plugin_ownership_conflict")
			}
			return nil, true, nil
		}
		object, err := parseHookDocument(before)
		if err != nil {
			return nil, false, err
		}
		next := cloneJSONMap(object)
		changed := false
		if profile.adapter == providers.HookAdapterAgyNamedHooks {
			if prior, exists := next[hookName]; exists {
				if !agyHookOwned(prior, provider, opts.SenderExecPath) {
					return nil, false, errors.New("hook_entry_ownership_conflict")
				}
				kept := cloneJSONMap(prior.(map[string]any))
				for key := range kept {
					if key == "enabled" {
						delete(kept, key)
						continue
					}
					if agyKnownEvent(key) {
						delete(kept, key)
					}
				}
				if len(kept) == 0 {
					delete(next, hookName)
				} else {
					next[hookName] = kept
				}
				changed = true
			}
		} else {
			hooks, _ := next["hooks"].(map[string]any)
			cleaned, removed := removeManagedHandlersFromHooksMap(hooks, provider, opts.SenderExecPath)
			changed = removed
			if changed {
				if len(cleaned) > 0 {
					next["hooks"] = cleaned
				} else {
					delete(next, "hooks")
				}
			}
		}
		if !changed {
			return nil, false, nil
		}
		encoded, err := json.MarshalIndent(next, "", "  ")
		return append(encoded, '\n'), false, err
	})
	out.OK = err == nil
	out.Changed = changed
	if err != nil {
		out.Error = err.Error()
	}
	return out
}

func isManagedCommandString(cmd, provider string, allowed ...string) bool {
	if !strings.Contains(cmd, managedHookMarker) {
		return false
	}
	fields, ok := splitHookCommand(cmd)
	if !ok || len(fields) < 5 {
		return false
	}
	// Current Go command has a private subcommand. Legacy Node can begin with
	// either an explicit node binary or `/usr/bin/env node`.
	start := -1
	base := strings.ToLower(filepath.Base(strings.ReplaceAll(fields[0], "\\", "/")))
	trustedSender := base == "aih-server" || base == "aih-server.exe"
	for _, explicit := range allowed {
		if explicit != "" && fields[0] == explicit {
			trustedSender = true
		}
	}
	if fields[1] == "__provider-hook" && trustedSender {
		start = 2
	} else {
		scriptIndex := 1
		if len(fields) > 2 && base == "env" && filepath.Base(fields[1]) == "node" {
			scriptIndex = 2
		}
		script := strings.ToLower(filepath.Base(fields[scriptIndex]))
		trustedNode := base == "node" || base == "node.exe" || (scriptIndex == 2 && base == "env")
		if trustedNode && (script == "aih-provider-session-hook-sender.js" || script == "provider-session-hook.js") {
			start = scriptIndex + 1
		}
	}
	if start < 0 || fields[start] != managedHookMarker ||
		fields[start+1] != "--provider" || fields[start+3] != "--event" {
		return false
	}
	// 当前命令不携带接收端 URL（运行期按 config:server 解析）；旧安装可能仍在
	// 末尾带 --url，两者都识别为托管 handler，重复安装时统一改写成新形状。
	switch len(fields) {
	case start + 5:
	case start + 7:
		if fields[start+5] != "--url" {
			return false
		}
	default:
		return false
	}
	return provider == "" || strings.EqualFold(provider, fields[start+2])
}

// InstallProviderHooks is the shared explicit write port, without inventory or
// implicit client installation. Toolkit/WebUI/Node all delegate here.
func InstallProviderHooks(ctx context.Context, provider string, opts Options) HookOperationOutcome {
	return installSingleProviderHook(ctx, resolveCatalog(opts), provider, opts)
}
func UninstallProviderHooks(provider string, opts Options) HookOperationOutcome {
	return uninstallSingleProviderHook(resolveCatalog(opts), provider, opts)
}
func updateHookFile(target string, dry bool, transform func(configsnapshot.Snapshot) ([]byte, bool, error)) (bool, error) {
	if !dry {
		return configsnapshot.Update(target, transform)
	}
	before, err := configsnapshot.Read(target)
	if err != nil {
		return false, err
	}
	next, remove, err := transform(before)
	if err != nil {
		return false, err
	}
	if remove {
		return before.Exists, nil
	}
	return next != nil && !bytes.Equal(next, before.Content), nil
}

func configuredHookTimeout(profile resolvedHookProfile, opts Options) int {
	if profile.timeoutUnit == providers.HookTimeoutMilliseconds {
		if opts.HookTimeoutMilliseconds > 0 {
			return max(100, opts.HookTimeoutMilliseconds)
		}
		if opts.HookTimeoutSeconds > 0 {
			return max(100, opts.HookTimeoutSeconds*1000)
		}
	} else if opts.HookTimeoutSeconds > 0 {
		return max(1, opts.HookTimeoutSeconds)
	}
	return hookHandlerTimeout(profile)
}
