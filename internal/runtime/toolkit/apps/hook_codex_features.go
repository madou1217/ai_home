package apps

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/madou1217/ai_home/internal/runtime/codexpreferences"
	"github.com/madou1217/ai_home/internal/runtime/configsnapshot"
	"github.com/madou1217/ai_home/internal/runtime/providerconfigs"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

func diagnoseCodexFeatures(ctx context.Context, opts Options) CodexFeaturesView {
	home := ResolveHostHome(opts)
	cfgPath := joinPlatformPath(resolvePlatform(opts), home, ".codex", "config.toml")
	var raw []byte
	readErr := codexpreferences.CheckHostReady(filepath.Dir(cfgPath))
	if readErr == nil {
		var snapshot configsnapshot.Snapshot
		snapshot, readErr = configsnapshot.Read(cfgPath)
		raw = snapshot.Content
		if readErr == nil && snapshot.Exists && !providerconfigs.ValidateContent(string(raw), "toml").Valid {
			readErr = errors.New("hook_codex_config_invalid")
		}
	}
	ver := strings.TrimSpace(opts.CodexVersion)
	if ver == "" {
		ver = probeCodexVersion(ctx, opts)
	}
	flagName := resolveCodexHooksFlagName(ver)

	view := CodexFeaturesView{
		Path:         cfgPath,
		FlagName:     flagName,
		CodexVersion: ver,
		Enabled:      true,
	}
	if readErr != nil {
		view.Error = readErr.Error()
		view.Enabled = false
		return view
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
		} else {
			view.Error = "hook_codex_feature_type_invalid"
			view.Enabled = false
			return view
		}
	}
	view.ActiveFlagName = activeFlag
	view.Explicit = activeFlag != ""
	view.Enabled = activeVal == nil || *activeVal
	view.Disabled = activeVal != nil && !*activeVal
	return view
}

func enableCodexHooksFeatureSafe(ctx context.Context, opts Options) (CodexFeaturesView, error) {
	view := diagnoseCodexFeatures(ctx, opts)
	if view.Error != "" {
		return view, errors.New(view.Error)
	}
	shouldPatch := view.Explicit && (!view.Enabled || view.ActiveFlagName != view.FlagName)
	if !shouldPatch {
		return CodexFeaturesView{
			Path:         view.Path,
			FlagName:     view.FlagName,
			CodexVersion: view.CodexVersion,
		}, nil
	}
	doc, err := codexpreferences.Read(filepath.Dir(view.Path))
	if err != nil {
		return view, err
	}
	raw, err := os.ReadFile(doc.Path)
	if err != nil {
		return view, err
	}
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
	if changed && !opts.HookDryRun {
		if err = codexpreferences.ReplaceDocument(filepath.Dir(view.Path), string(raw), nextText); err != nil {
			return view, err
		}
	}
	return CodexFeaturesView{
		Path:           view.Path,
		Changed:        changed,
		FlagName:       view.FlagName,
		CodexVersion:   view.CodexVersion,
		DisabledBefore: view.Disabled,
	}, nil
}

func enableCodexHooksFeature(ctx context.Context, opts Options) CodexFeaturesView {
	v, _ := enableCodexHooksFeatureSafe(ctx, opts)
	return v
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
