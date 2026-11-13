package providercliupgrade

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/madou1217/ai_home/internal/runtime/codexhooks"
)

const (
	ChannelStandaloneRelease = "standalone_release"
	ChannelNpmGlobal         = "npm_global"
	ChannelVendorSelfUpdate  = "vendor_selfupdate"
	ChannelHomebrew          = "homebrew"
	ChannelUnknown           = "unknown"

	shimMaxBytes = 4096
)

var (
	quotedPathRe          = regexp.MustCompile(`['"]([^'"\n]+)['"]`)
	cmdUpstreamAssignRe   = regexp.MustCompile(`(?im)^\s*set\s+"` + codexhooks.WrapperUpstreamVar + `=([^"\n]+)"`)
	npmCmdShimRe          = regexp.MustCompile(`(?i)"%~?dp0%[\\/]*([^"\n]*node_modules[\\/][^"\n]+)"`)
	cmdOrBatExtRe         = regexp.MustCompile(`(?i)\.(?:cmd|bat)$`)
)

// ChannelCapabilities 描述安装渠道支持的能力边界。
type ChannelCapabilities struct {
	Pinnable                   bool
	RollbackReusesLocalRelease bool
	InstallsSideBySide         bool
}

var baseChannelCapabilities = map[string]ChannelCapabilities{
	ChannelStandaloneRelease: {Pinnable: true, RollbackReusesLocalRelease: true, InstallsSideBySide: true},
	ChannelNpmGlobal:         {Pinnable: true, RollbackReusesLocalRelease: false, InstallsSideBySide: false},
	ChannelVendorSelfUpdate:  {Pinnable: false, RollbackReusesLocalRelease: false, InstallsSideBySide: false},
	ChannelHomebrew:          {Pinnable: false, RollbackReusesLocalRelease: false, InstallsSideBySide: false},
	ChannelUnknown:           {Pinnable: false, RollbackReusesLocalRelease: false, InstallsSideBySide: false},
}

// ResolveChannelCapabilities 返回指定渠道和 provider 的升级能力（与 Node resolveChannelCapabilities 同口径）。
func ResolveChannelCapabilities(channel string, provider string) ChannelCapabilities {
	ch := strings.TrimSpace(channel)
	p := strings.ToLower(strings.TrimSpace(provider))
	base, ok := baseChannelCapabilities[ch]
	if !ok {
		base = baseChannelCapabilities[ChannelUnknown]
	}
	if ch == ChannelVendorSelfUpdate {
		switch p {
		case "claude":
			return ChannelCapabilities{
				Pinnable:                   true,
				RollbackReusesLocalRelease: base.RollbackReusesLocalRelease,
				InstallsSideBySide:         true,
			}
		case "opencode":
			return ChannelCapabilities{
				Pinnable:                   true,
				RollbackReusesLocalRelease: base.RollbackReusesLocalRelease,
				InstallsSideBySide:         false,
			}
		}
	}
	return base
}

// VendorPinnedArgs 返回支持钉版本官方命令的 provider 参数模板。
func VendorPinnedArgs(provider string, version string) ([]string, bool) {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "claude":
		return []string{"install", version}, true
	case "opencode":
		return []string{"upgrade", version}, true
	default:
		return nil, false
	}
}

// RequiresQuiescence 判断升级前是否必须等待 provider 空闲（无活跃会话/app-server）。
// 并排安装的渠道在 POSIX 上不必等待，Windows 保守起见一律等待。
func RequiresQuiescence(channel string, goos string, provider string) bool {
	if !ResolveChannelCapabilities(channel, provider).InstallsSideBySide {
		return true
	}
	return isWindowsOS(goos)
}

func isWindowsOS(goos string) bool {
	normalized := strings.ToLower(strings.TrimSpace(goos))
	return normalized == "windows" || normalized == "win32"
}

// ChannelDetectInput 汇总渠道检测输入。
type ChannelDetectInput struct {
	Provider              string
	ResolvedPath          string
	StandaloneRoots       []string
	NpmGlobalRoot         string
	VendorSelfUpdateRoots []string
	HomebrewRoots         []string
	NpmPackageDir         string
}

// ChannelDetection 保存渠道识别和路径证据。
type ChannelDetection struct {
	Channel                    string
	ResolvedPath               string
	OwnerPath                  string
	PackageName                string
	InstallDir                 string
	Pinnable                   bool
	RollbackReusesLocalRelease bool
	ShadowedNpmInstall         bool
	Evidence                   []string
}

// DetectCLIChannel 通过 realpath、aih 垫片、npm cmd 垫片和安装根比对识别 CLI 所属渠道。
func DetectCLIChannel(input ChannelDetectInput) ChannelDetection {
	resolvedPath := strings.TrimSpace(input.ResolvedPath)
	if resolvedPath == "" {
		return ChannelDetection{
			Channel:  ChannelUnknown,
			Evidence: []string{"cli_not_resolved"},
		}
	}

	evidence := []string{}
	ownerPath := safeRealpath(resolvedPath)
	if ownerPath != resolvedPath {
		evidence = append(evidence, "resolved_through_link")
	}
	if shimTarget := followAIHShim(ownerPath); shimTarget != "" {
		ownerPath = safeRealpath(shimTarget)
		evidence = append(evidence, "resolved_through_aih_shim")
	}
	if npmShimTarget := followNpmCmdShim(ownerPath); npmShimTarget != "" {
		ownerPath = safeRealpath(npmShimTarget)
		evidence = append(evidence, "resolved_through_npm_cmd_shim")
	}

	standaloneRoots := realpathList(input.StandaloneRoots)
	npmGlobalRoot := safeRealpath(input.NpmGlobalRoot)
	vendorRoots := realpathList(input.VendorSelfUpdateRoots)
	homebrewRoots := realpathList(input.HomebrewRoots)

	channel := ChannelUnknown
	switch {
	case anyDirContains(standaloneRoots, ownerPath):
		channel = ChannelStandaloneRelease
		evidence = append(evidence, "under_standalone_releases")
	case npmGlobalRoot != "" && isInsideDir(npmGlobalRoot, ownerPath):
		channel = ChannelNpmGlobal
		evidence = append(evidence, "under_npm_global_root")
	case anyDirContains(vendorRoots, ownerPath):
		channel = ChannelVendorSelfUpdate
		evidence = append(evidence, "under_vendor_selfupdate_root")
	case anyDirContains(homebrewRoots, ownerPath):
		channel = ChannelHomebrew
		evidence = append(evidence, "under_homebrew_root")
	default:
		evidence = append(evidence, "no_known_root_matched")
	}

	npmPkgDirInput := strings.TrimSpace(input.NpmPackageDir)
	npmPkgDir := ""
	if npmPkgDirInput != "" && pathExists(npmPkgDirInput) {
		npmPkgDir = safeRealpath(npmPkgDirInput)
	}
	compareRoot := npmGlobalRoot
	if compareRoot == "" {
		compareRoot = npmPkgDir
	}
	shadowedNpmInstall := npmPkgDir != "" &&
		channel != ChannelNpmGlobal &&
		isInsideDir(compareRoot, npmPkgDir)
	if shadowedNpmInstall {
		evidence = append(evidence, "npm_install_shadowed")
	}

	caps := ResolveChannelCapabilities(channel, strings.TrimSpace(input.Provider))
	return ChannelDetection{
		Channel:                    channel,
		ResolvedPath:               resolvedPath,
		OwnerPath:                  ownerPath,
		Pinnable:                   caps.Pinnable,
		RollbackReusesLocalRelease: caps.RollbackReusesLocalRelease,
		ShadowedNpmInstall:         shadowedNpmInstall,
		Evidence:                   evidence,
	}
}

func followAIHShim(target string) string {
	info, err := os.Stat(target)
	if err != nil || info.IsDir() || info.Size() > shimMaxBytes {
		return ""
	}
	raw, err := os.ReadFile(target)
	if err != nil {
		return ""
	}
	content := string(raw)
	if !strings.Contains(content, codexhooks.WrapperMarkerCLI) {
		return ""
	}
	if match := cmdUpstreamAssignRe.FindStringSubmatch(content); len(match) == 2 {
		candidate := strings.TrimSpace(match[1])
		if candidate != "" && candidate != target && pathExists(candidate) {
			return candidate
		}
	}
	for _, match := range quotedPathRe.FindAllStringSubmatch(content, -1) {
		if len(match) < 2 {
			continue
		}
		candidate := match[1]
		if candidate != "" && candidate != target && pathExists(candidate) {
			return candidate
		}
	}
	return ""
}

func followNpmCmdShim(target string) string {
	if !cmdOrBatExtRe.MatchString(strings.TrimSpace(target)) {
		return ""
	}
	info, err := os.Stat(target)
	if err != nil || info.IsDir() || info.Size() > shimMaxBytes {
		return ""
	}
	raw, err := os.ReadFile(target)
	if err != nil {
		return ""
	}
	match := npmCmdShimRe.FindStringSubmatch(string(raw))
	if len(match) < 2 {
		return ""
	}
	rel := strings.ReplaceAll(match[1], "\\", string(filepath.Separator))
	resolved := filepath.Clean(filepath.Join(filepath.Dir(target), rel))
	if resolved != target && pathExists(resolved) {
		return resolved
	}
	return ""
}

func safeRealpath(target string) string {
	trimmed := strings.TrimSpace(target)
	if trimmed == "" {
		return ""
	}
	resolved, err := filepath.EvalSymlinks(trimmed)
	if err == nil && resolved != "" {
		return resolved
	}
	return trimmed
}

func realpathList(values []string) []string {
	out := make([]string, 0, len(values))
	for _, v := range values {
		if r := safeRealpath(v); r != "" {
			out = append(out, r)
		}
	}
	return out
}

func anyDirContains(roots []string, target string) bool {
	for _, root := range roots {
		if isInsideDir(root, target) {
			return true
		}
	}
	return false
}

// isInsideDir 按路径边界判断 target 是否位于 dir 内，避免 /a/b 误匹配 /a/bc。
func isInsideDir(dir string, target string) bool {
	root := strings.TrimSpace(dir)
	child := strings.TrimSpace(target)
	if root == "" || child == "" {
		return false
	}
	rel, err := filepath.Rel(root, child)
	if err != nil {
		return false
	}
	if rel == "." || rel == "" {
		return true
	}
	return !strings.HasPrefix(rel, "..") && !filepath.IsAbs(rel)
}

func pathExists(target string) bool {
	_, err := os.Stat(target)
	return err == nil
}
