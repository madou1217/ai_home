package codexappconfig

import (
	"regexp"
	"strconv"
	"strings"
)

// HookFeatureSwitchVersion 是 codex 把 hooks 开关从 codex_hooks 改为 hooks 的版本。
const HookFeatureSwitchVersion = "0.114.0"

var hookFeatureFlags = map[string]struct{}{"hooks": {}, "codex_hooks": {}}

var semverPattern = regexp.MustCompile("(\\d+)\\.(\\d+)\\.(\\d+)")
var featureLinePattern = regexp.MustCompile("^([A-Za-z0-9_-]+)\\s*=")

// Semver 是最小化的三段版本号。
type Semver struct {
	Major int
	Minor int
	Patch int
}

// ParseSemver 从任意字符串中提取第一个三段版本号。
func ParseSemver(value string) (Semver, bool) {
	match := semverPattern.FindStringSubmatch(value)
	if match == nil {
		return Semver{}, false
	}
	major, _ := strconv.Atoi(match[1])
	minor, _ := strconv.Atoi(match[2])
	patch, _ := strconv.Atoi(match[3])
	return Semver{Major: major, Minor: minor, Patch: patch}, true
}

// CompareSemver 返回 -1/0/1；任一侧无法解析时 ok=false。
func CompareSemver(left, right string) (int, bool) {
	a, okA := ParseSemver(left)
	b, okB := ParseSemver(right)
	if !okA || !okB {
		return 0, false
	}
	if a.Major != b.Major {
		return sign(a.Major - b.Major), true
	}
	if a.Minor != b.Minor {
		return sign(a.Minor - b.Minor), true
	}
	return sign(a.Patch - b.Patch), true
}

func sign(value int) int {
	if value < 0 {
		return -1
	}
	if value > 0 {
		return 1
	}
	return 0
}

// ResolveHooksFeatureFlag 按 codex 版本选择 hooks / codex_hooks。
func ResolveHooksFeatureFlag(codexVersion string) string {
	comparison, ok := CompareSemver(codexVersion, HookFeatureSwitchVersion)
	if ok && comparison < 0 {
		return "codex_hooks"
	}
	return "hooks"
}

// HasHooksFeatureFlag 判断配置的 [features] 段是否已有 hooks/codex_hooks 开关。
func HasHooksFeatureFlag(config string) bool {
	lines := strings.Split(config, "\n")
	start, end, found := findFeaturesSection(lines)
	if !found {
		return false
	}
	for _, line := range lines[start+1 : end] {
		name := featureName(line)
		if name == "" {
			continue
		}
		if _, ok := hookFeatureFlags[name]; ok {
			return true
		}
	}
	return false
}

// NormalizeHooksFeatureFlag 在已有 hooks 开关时按版本重写为正确名称；
// 没有该开关时原样返回（与 Node normalizeCodexHooksFeatureFlag 一致）。
func NormalizeHooksFeatureFlag(config, codexVersion string) string {
	if !HasHooksFeatureFlag(config) {
		return config
	}
	return SetFeatureFlag(config, ResolveHooksFeatureFlag(codexVersion))
}

// SetFeatureFlag 确保 [features] 段存在并写入 featureName = true，保留其它 feature 行。
func SetFeatureFlag(config, flagName string) string {
	lines := strings.Split(config, "\n")
	start, end, found := findFeaturesSection(lines)
	if !found {
		base := trimEndSpace(config)
		if base != "" {
			return base + "\n\n[features]\n" + flagName + " = true\n"
		}
		return "[features]\n" + flagName + " = true\n"
	}
	preserved := make([]string, 0, end-start)
	for _, line := range lines[start+1 : end] {
		name := featureName(line)
		if name == "hooks" || name == "codex_hooks" {
			continue
		}
		preserved = append(preserved, line)
	}
	next := make([]string, 0, len(lines)+1)
	next = append(next, lines[:start]...)
	next = append(next, "[features]", flagName+" = true")
	next = append(next, preserved...)
	next = append(next, lines[end:]...)
	return strings.TrimRight(strings.Join(next, "\n"), "\n") + "\n"
}

func findFeaturesSection(lines []string) (int, int, bool) {
	index := -1
	for position, line := range lines {
		if strings.TrimSpace(line) == "[features]" {
			index = position
			break
		}
	}
	if index < 0 {
		return 0, 0, false
	}
	end := index + 1
	for end < len(lines) && !strings.HasPrefix(strings.TrimSpace(lines[end]), "[") {
		end++
	}
	return index, end, true
}

func featureName(line string) string {
	match := featureLinePattern.FindStringSubmatch(strings.TrimSpace(line))
	if match == nil {
		return ""
	}
	return match[1]
}
