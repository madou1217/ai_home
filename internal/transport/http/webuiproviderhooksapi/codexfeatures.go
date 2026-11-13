package webuiproviderhooksapi

// codex 的 hooks 在 config.toml 里还有一个特性开关：只写 hooks.json 不够。
// 本文件的解析/写入规则与 Node 的 lib/cli/config/codex-feature-flags.js 对齐：
//   - 0.114.0 之前开关叫 codex_hooks，之后叫 hooks；
//   - 没有 [features] 段时视为「未显式声明」，不写开关（默认开启）；
//   - 只有显式 false 或旧开关名才需要改写；用户其它 feature 行原样保留。

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const (
	// codexHooksFeatureSwitchVersion 是开关改名的版本分界线。
	codexHooksFeatureSwitchVersion = "0.114.0"
	// codexVersionProbeTimeout 与 Node 的 1s 探测预算一致。
	codexVersionProbeTimeout = time.Second
	// lineBreak 只是为了避免在源码里散落转义序列。
	lineBreak = "\n"
)

var codexHooksFeatureFlags = map[string]struct{}{"hooks": {}, "codex_hooks": {}}

type semver struct {
	major int
	minor int
	patch int
}

// parseSemver 从任意文本里找第一段 major.minor.patch（与 Node 的正则同口径）。
func parseSemver(value string) (semver, bool) {
	runes := []rune(value)
	for start := 0; start < len(runes); start++ {
		if !isDigit(runes[start]) {
			continue
		}
		major, length, ok := readDigits(runes[start:])
		if !ok || start+length >= len(runes) || runes[start+length] != '.' {
			continue
		}
		minor, minorLength, ok := readDigits(runes[start+length+1:])
		if !ok {
			continue
		}
		remainder := runes[start+length+1+minorLength:]
		if len(remainder) == 0 || remainder[0] != '.' {
			continue
		}
		patch, _, ok := readDigits(remainder[1:])
		if !ok {
			continue
		}
		return semver{major: major, minor: minor, patch: patch}, true
	}
	return semver{}, false
}

func isDigit(value rune) bool {
	return value >= '0' && value <= '9'
}

func readDigits(runes []rune) (int, int, bool) {
	length := 0
	for length < len(runes) && isDigit(runes[length]) {
		length++
	}
	if length == 0 {
		return 0, 0, false
	}
	value, err := strconv.Atoi(string(runes[:length]))
	if err != nil {
		return 0, 0, false
	}
	return value, length, true
}

func compareSemver(left semver, right semver) int {
	if left.major != right.major {
		return left.major - right.major
	}
	if left.minor != right.minor {
		return left.minor - right.minor
	}
	return left.patch - right.patch
}

// resolveCodexHooksFlagName 与 Node 的 resolveCodexHooksFeatureFlag 同口径。
func resolveCodexHooksFlagName(codexVersion string) string {
	installed, installedOK := parseSemver(codexVersion)
	switching, switchingOK := parseSemver(codexHooksFeatureSwitchVersion)
	if !installedOK || !switchingOK {
		return "hooks"
	}
	if compareSemver(installed, switching) < 0 {
		return "codex_hooks"
	}
	return "hooks"
}

// codexFeaturesState 是 [features] 段的解析结果。
type codexFeaturesState struct {
	codexVersion   string
	flagName       string
	explicit       bool
	enabled        bool
	disabled       bool
	activeFlagName string
}

func getCodexHooksFeatureFlagState(configText string, codexVersion string) codexFeaturesState {
	state := codexFeaturesState{
		codexVersion: codexVersion,
		flagName:     resolveCodexHooksFlagName(codexVersion),
		enabled:      true,
	}
	lines := strings.Split(configText, lineBreak)
	featureIndex, sectionEnd, found := findFeaturesSection(lines)
	if !found {
		return state
	}
	activeFlagName := ""
	activeValue := (*bool)(nil)
	for _, line := range lines[featureIndex+1 : sectionEnd] {
		key, rawValue, ok := splitFeatureLine(line)
		if !ok {
			continue
		}
		if _, known := codexHooksFeatureFlags[key]; !known {
			continue
		}
		value, isBoolean := parseTomlBooleanLiteral(rawValue)
		if !isBoolean {
			continue
		}
		activeFlagName = key
		activeValue = &value
	}
	state.activeFlagName = activeFlagName
	state.explicit = activeFlagName != ""
	state.enabled = activeValue == nil || *activeValue
	state.disabled = activeValue != nil && !*activeValue
	return state
}

func findFeaturesSection(lines []string) (int, int, bool) {
	featureIndex := -1
	for index, line := range lines {
		if strings.TrimSpace(line) == "[features]" {
			featureIndex = index
			break
		}
	}
	if featureIndex < 0 {
		return 0, 0, false
	}
	sectionEnd := featureIndex + 1
	for sectionEnd < len(lines) {
		if strings.HasPrefix(strings.TrimSpace(lines[sectionEnd]), "[") {
			break
		}
		sectionEnd++
	}
	return featureIndex, sectionEnd, true
}

// splitFeatureLine 等价于 Node 的 /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/。
func splitFeatureLine(line string) (string, string, bool) {
	trimmed := strings.TrimSpace(line)
	index := strings.Index(trimmed, "=")
	if index <= 0 {
		return "", "", false
	}
	key := strings.TrimSpace(trimmed[:index])
	if !validFeatureKey(key) {
		return "", "", false
	}
	return key, strings.TrimSpace(trimmed[index+1:]), true
}

func validFeatureKey(key string) bool {
	if key == "" {
		return false
	}
	for _, character := range key {
		if (character >= 'a' && character <= 'z') ||
			(character >= 'A' && character <= 'Z') ||
			(character >= '0' && character <= '9') ||
			character == '_' || character == '-' {
			continue
		}
		return false
	}
	return true
}

func parseTomlBooleanLiteral(value string) (bool, bool) {
	text := value
	if index := strings.Index(text, "#"); index >= 0 {
		text = text[:index]
	}
	text = strings.ToLower(strings.TrimSpace(text))
	switch text {
	case "true":
		return true, true
	case "false":
		return false, true
	default:
		return false, false
	}
}

// setCodexFeatureFlag 把 flagName = true 写进 [features]，保留其它 feature 行。
func setCodexFeatureFlag(configText string, flagName string) string {
	lines := strings.Split(configText, lineBreak)
	featureIndex, sectionEnd, found := findFeaturesSection(lines)
	if !found {
		base := strings.TrimRightFunc(configText, unicode.IsSpace)
		prefix := ""
		if base != "" {
			prefix = base + lineBreak + lineBreak
		}
		return prefix + "[features]" + lineBreak + flagName + " = true" + lineBreak
	}
	preserved := make([]string, 0, sectionEnd-featureIndex)
	for _, line := range lines[featureIndex+1 : sectionEnd] {
		if key, _, ok := splitFeatureLine(line); ok {
			if _, known := codexHooksFeatureFlags[key]; known {
				continue
			}
		}
		preserved = append(preserved, line)
	}
	next := make([]string, 0, len(lines)+2)
	next = append(next, lines[:featureIndex]...)
	next = append(next, "[features]", flagName+" = true")
	next = append(next, preserved...)
	next = append(next, lines[sectionEnd:]...)
	return strings.TrimRight(strings.Join(next, lineBreak), lineBreak) + lineBreak
}

// installCodexHooksFeature 读取/改写 config.toml；dryRun 只返回将发生的变更。
func installCodexHooksFeature(context installContext, dryRun bool) codexFeaturesView {
	configPath := filepath.Join(context.hostHomeDir, ".codex", "config.toml")
	before := readTextFile(configPath)
	codexVersion := strings.TrimSpace(context.codexVersion)
	if codexVersion == "" {
		codexVersion = probeInstalledCodexVersion()
	}
	state := getCodexHooksFeatureFlagState(before, codexVersion)
	shouldPatch := state.explicit && (!state.enabled || state.activeFlagName != state.flagName)
	content := before
	if shouldPatch {
		content = setCodexFeatureFlag(before, state.flagName)
	}
	changed := content != before
	if changed && !dryRun {
		_ = os.MkdirAll(filepath.Dir(configPath), 0o755)
		_ = os.WriteFile(configPath, []byte(content), 0o644)
	}
	return codexFeaturesView{
		Path:           configPath,
		Changed:        changed,
		FlagName:       state.flagName,
		CodexVersion:   state.codexVersion,
		DisabledBefore: state.disabled,
	}
}

// probeInstalledCodexVersion 与 Node 的 getInstalledCodexVersion 同口径：
// 1s 超时，失败返回空串（不是错误）。
func probeInstalledCodexVersion() string {
	ctx, cancel := context.WithTimeout(context.Background(), codexVersionProbeTimeout)
	defer cancel()
	output, err := exec.CommandContext(ctx, "codex", "--version").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(output))
}
