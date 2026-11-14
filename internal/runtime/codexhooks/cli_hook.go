package codexhooks

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	// CLIHookStateRelativePath 是相对于 AI_HOME 的 CLI hook 状态文件路径。
	CLIHookStateRelativePath = "run/codex/cli-hook-state.json"
	// DefaultBackgroundResolveTTL 是后台自愈复用完整 CLI 查找结论的最长间隔。
	DefaultBackgroundResolveTTL = 5 * time.Minute
)

// CLIHookPaths 表示解析后的 CLI 包装目标与对应上游备份路径。
type CLIHookPaths struct {
	TargetBinaryPath          string   `json:"targetBinaryPath"`
	ResolvedTargetBinaryPath  string   `json:"resolvedTargetBinaryPath,omitempty"`
	UpstreamBinaryPath        string   `json:"upstreamBinaryPath"`
	LegacyUpstreamBinaryPaths []string `json:"legacyUpstreamBinaryPaths,omitempty"`
	Reason                    string   `json:"reason,omitempty"`
}

// CLIHookState 表示持久化的 cli-hook-state.json（v1）。
type CLIHookState struct {
	Version                  int    `json:"version"`
	Enabled                  bool   `json:"enabled"`
	UpdatedAt                string `json:"updatedAt,omitempty"`
	TargetBinaryPath         string `json:"targetBinaryPath,omitempty"`
	ResolvedTargetBinaryPath string `json:"resolvedTargetBinaryPath,omitempty"`
	UpstreamBinaryPath       string `json:"upstreamBinaryPath,omitempty"`
	Reason                   string `json:"reason,omitempty"`
}

// CLIHookResult 描述 CLI hook 安装、巡检、停用及别名修复的结果。
type CLIHookResult struct {
	OK                       bool     `json:"ok"`
	Supported                bool     `json:"supported"`
	Enabled                  bool     `json:"enabled"`
	Installed                bool     `json:"installed,omitempty"`
	Updated                  bool     `json:"updated,omitempty"`
	Healthy                  bool     `json:"healthy,omitempty"`
	Repaired                 bool     `json:"repaired,omitempty"`
	Migrated                 bool     `json:"migrated,omitempty"`
	Reason                   string   `json:"reason,omitempty"`
	ErrorCode                string   `json:"errorCode,omitempty"`
	Retryable                *bool    `json:"retryable,omitempty"`
	TargetBinaryPath         string   `json:"targetBinaryPath,omitempty"`
	ResolvedTargetBinaryPath string   `json:"resolvedTargetBinaryPath,omitempty"`
	UpstreamBinaryPath       string   `json:"upstreamBinaryPath,omitempty"`
	RepairedAliases          []string `json:"repairedAliases,omitempty"`
	StateFilePath            string   `json:"stateFilePath,omitempty"`
}

// CLIHookEnsureOptions 控制 EnsureInstalled 的单次核对行为。
type CLIHookEnsureOptions struct {
	Background bool
}

// CLIHookOptions 配置 CLIHookService。
type CLIHookOptions struct {
	AIHomeDir        string
	HostHomeDir      string
	Platform         string
	Arch             string
	PathEnv          string
	TempDir          string
	NodeExecPath     string
	HelperScriptPath string
	BackgroundTTL    time.Duration
	Now              func() time.Time
	// ResolveCodexBinary 允许注入 `codex` 二进制查找逻辑；background=false 允许登录 shell 回落。
	ResolveCodexBinary func(loginShellFallback bool) string
}

type cliFullResolutionMemo struct {
	path string
	at   time.Time
}

// CLIHookService 管理 Codex CLI 的包装器安装、.aih-original 备份与 PATH 别名转发。
type CLIHookService struct {
	aiHomeDir        string
	hostHomeDir      string
	platform         string
	arch             string
	pathEnv          string
	tempDir          string
	nodeExecPath     string
	helperScriptPath string
	stateFilePath    string
	backgroundTTL    time.Duration
	now              func() time.Time
	resolveBinaryFn  func(loginShellFallback bool) string

	mu                 sync.Mutex
	lastFullResolution *cliFullResolutionMemo
}

// NewCLIHookService 创建 Codex CLI hook 管理服务。
func NewCLIHookService(opts CLIHookOptions) *CLIHookService {
	aiHome := strings.TrimSpace(opts.AIHomeDir)
	stateFilePath := ""
	if aiHome != "" {
		stateFilePath = filepath.Join(aiHome, "run", "codex", "cli-hook-state.json")
	}
	ttl := opts.BackgroundTTL
	if ttl <= 0 {
		ttl = DefaultBackgroundResolveTTL
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	svc := &CLIHookService{
		aiHomeDir:        aiHome,
		hostHomeDir:      strings.TrimSpace(opts.HostHomeDir),
		platform:         NormalizePlatform(opts.Platform),
		arch:             NormalizeArch(opts.Arch),
		pathEnv:          opts.PathEnv,
		tempDir:          strings.TrimSpace(opts.TempDir),
		nodeExecPath:     strings.TrimSpace(opts.NodeExecPath),
		helperScriptPath: strings.TrimSpace(opts.HelperScriptPath),
		stateFilePath:    stateFilePath,
		backgroundTTL:    ttl,
		now:              nowFn,
		resolveBinaryFn:  opts.ResolveCodexBinary,
	}
	if svc.resolveBinaryFn == nil {
		svc.resolveBinaryFn = svc.defaultResolveCodexBinary
	}
	return svc
}

// StateFilePath 返回 cli-hook-state.json 路径。
func (svc *CLIHookService) StateFilePath() string {
	return svc.stateFilePath
}

func (svc *CLIHookService) effectivePathEntries() []string {
	rawPath := svc.pathEnv
	if rawPath == "" {
		rawPath = os.Getenv("PATH")
		if rawPath == "" && svc.platform == "windows" {
			rawPath = os.Getenv("Path")
		}
	}
	if rawPath == "" {
		return nil
	}
	parts := strings.Split(rawPath, string(os.PathListSeparator))
	if svc.platform == "windows" && strings.Contains(rawPath, ";") && os.PathListSeparator != ';' {
		parts = strings.Split(rawPath, ";")
	}
	out := make([]string, 0, len(parts))
	for _, entry := range parts {
		trimmed := strings.TrimSpace(entry)
		if trimmed != "" {
			out = append(out, trimmed)
		}
	}
	return out
}

func (svc *CLIHookService) candidateExecutableNames() []string {
	if svc.platform == "windows" {
		return []string{"codex.ps1", "codex.cmd", "codex.bat", "codex.exe", "codex"}
	}
	return []string{"codex"}
}

func (svc *CLIHookService) isCandidateExecutable(filePath string) bool {
	if strings.TrimSpace(filePath) == "" {
		return false
	}
	info, err := os.Stat(filePath)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	if svc.platform == "windows" {
		return true
	}
	return info.Mode()&0o111 != 0
}

func (svc *CLIHookService) userCandidateDirs() []string {
	if svc.platform == "windows" {
		return nil
	}
	home := strings.TrimSpace(svc.hostHomeDir)
	if home == "" {
		home = strings.TrimSpace(os.Getenv("AIH_HOST_HOME"))
	}
	if home == "" {
		home = strings.TrimSpace(os.Getenv("HOME"))
	}
	if home == "" {
		home = strings.TrimSpace(os.Getenv("USERPROFILE"))
	}
	var dirs []string
	if home != "" {
		dirs = append(dirs,
			filepath.Join(home, ".local", "bin"),
			filepath.Join(home, ".codex", "packages", "standalone", "current", "bin"),
			filepath.Join(home, ".npm-global", "bin"),
			filepath.Join(home, ".volta", "bin"),
			filepath.Join(home, ".local", "share", "pnpm"),
		)
	}
	// 仅在未显式注入 PathEnv（生产守护进程极简 PATH 场景）时兜底标准包管理器目录，保持单测隔离。
	if strings.TrimSpace(svc.pathEnv) == "" {
		dirs = append(dirs, "/opt/homebrew/bin", "/usr/local/bin")
	}
	return dirs
}

func (svc *CLIHookService) probeCodexBinary() string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if svc.platform == "windows" {
		out, err := exec.CommandContext(ctx, "where.exe", "codex").Output()
		if err != nil {
			return ""
		}
		var firstValid string
		for _, line := range strings.Split(string(out), "\n") {
			cand := strings.TrimSpace(strings.TrimSuffix(line, "\r"))
			if cand == "" || !isRegularFile(cand) {
				continue
			}
			if firstValid == "" {
				firstValid = cand
			}
			ext := strings.ToLower(filepath.Ext(cand))
			if ext == ".exe" || ext == ".cmd" || ext == ".bat" || ext == ".com" {
				return cand
			}
		}
		return firstValid
	}
	out, err := exec.CommandContext(ctx, "sh", "-lc", `command -v "codex"`).Output()
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(out), "\n") {
		cand := strings.TrimSpace(line)
		if cand != "" && svc.isCandidateExecutable(cand) {
			return cand
		}
	}
	return ""
}

func (svc *CLIHookService) defaultResolveCodexBinary(loginShellFallback bool) string {
	names := svc.candidateExecutableNames()
	for _, dir := range svc.effectivePathEntries() {
		for _, name := range names {
			candidate := filepath.Join(dir, name)
			if svc.isCandidateExecutable(candidate) {
				return candidate
			}
		}
	}
	for _, dir := range svc.userCandidateDirs() {
		for _, name := range names {
			candidate := filepath.Join(dir, name)
			if svc.isCandidateExecutable(candidate) {
				return candidate
			}
		}
	}
	if !loginShellFallback || strings.TrimSpace(svc.pathEnv) != "" {
		return ""
	}
	return svc.probeCodexBinary()
}

func (svc *CLIHookService) resolveTempRoot() string {
	if svc.tempDir != "" {
		return svc.tempDir
	}
	return os.TempDir()
}

func (svc *CLIHookService) isTemporaryPath(filePath string) bool {
	trimmed := strings.TrimSpace(filePath)
	if trimmed == "" {
		return false
	}
	absTemp, err1 := filepath.Abs(svc.resolveTempRoot())
	absTarget, err2 := filepath.Abs(trimmed)
	if err1 != nil || err2 != nil {
		return false
	}
	rel, err := filepath.Rel(absTemp, absTarget)
	if err != nil {
		return false
	}
	return rel == "" || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel))
}

// BuildWrapperScript 生成默认 POSIX CLI 包装脚本。
func (svc *CLIHookService) BuildWrapperScript(upstreamBinaryPath string) string {
	return BuildCLIWrapperScript(WrapperOptions{
		NodeExecPath:       svc.nodeExecPath,
		HelperScriptPath:   svc.helperScriptPath,
		UpstreamBinaryPath: upstreamBinaryPath,
		StateFilePath:      svc.stateFilePath,
	})
}

// BuildWrapperScriptForTarget 按目标扩展名（POSIX / .ps1 / .cmd）生成包装脚本。
func (svc *CLIHookService) BuildWrapperScriptForTarget(targetBinaryPath string, upstreamBinaryPath string) string {
	return BuildCLIWrapperScriptForTarget(targetBinaryPath, WrapperOptions{
		NodeExecPath:       svc.nodeExecPath,
		HelperScriptPath:   svc.helperScriptPath,
		UpstreamBinaryPath: upstreamBinaryPath,
		StateFilePath:      svc.stateFilePath,
	})
}

// IsWrapperInstalled 判断给定文件是否包含独立的 aih-codex-cli-hook 注释标记行。
func (svc *CLIHookService) IsWrapperInstalled(targetBinaryPath string) bool {
	return HasCLIWrapperMarkerLine(readTextFileSafe(targetBinaryPath))
}

func (svc *CLIHookService) isAliasWrapperInstalled(targetBinaryPath string) bool {
	return HasAliasWrapperMarkerLine(readTextFileSafe(targetBinaryPath))
}

// BuildBackupPath 为不同扩展名计算 .aih-original 备份文件路径。
func BuildBackupPath(binaryPath string) string {
	normalized := strings.TrimSpace(binaryPath)
	if normalized == "" {
		return ""
	}
	originalExt := strings.TrimSpace(filepath.Ext(normalized))
	lowerExt := strings.ToLower(originalExt)
	if _, preserve := PreserveBackupExtensions[lowerExt]; !preserve {
		return normalized + ".aih-original"
	}
	base := strings.TrimSuffix(filepath.Base(normalized), originalExt)
	return filepath.Join(filepath.Dir(normalized), base+".aih-original"+originalExt)
}

func isNodeEntryContent(filePath string) bool {
	text := readTextFileSafe(filePath)
	if strings.TrimSpace(text) == "" {
		return false
	}
	trimmed := strings.TrimSpace(text)
	if strings.HasPrefix(trimmed, "#!/usr/bin/env node") ||
		strings.HasPrefix(trimmed, "#!/usr/bin/node") ||
		strings.Contains(text, "node_modules") ||
		strings.Contains(text, "require(") {
		return true
	}
	return false
}

func resolveRealPathSafe(filePath string) string {
	trimmed := strings.TrimSpace(filePath)
	if trimmed == "" {
		return ""
	}
	if !fileExists(trimmed) {
		return trimmed
	}
	resolved, err := filepath.EvalSymlinks(trimmed)
	if err != nil || strings.TrimSpace(resolved) == "" {
		return trimmed
	}
	return resolved
}

func isSameResolvedFile(leftPath string, rightPath string) bool {
	left := resolveRealPathSafe(leftPath)
	right := resolveRealPathSafe(rightPath)
	return left != "" && right != "" && left == right
}

// ResolveUpstreamBinaryPath 解析软链接后的规范目标及 .aih-original 备份与遗留备份候选路径。
func (svc *CLIHookService) ResolveUpstreamBinaryPath(targetBinaryPath string) (resolvedTarget string, upstream string, legacy []string) {
	normalized := strings.TrimSpace(targetBinaryPath)
	if normalized == "" {
		return "", "", nil
	}
	resolvedTarget = resolveRealPathSafe(normalized)
	if resolvedTarget == "" {
		resolvedTarget = normalized
	}
	upstream = BuildBackupPath(resolvedTarget)

	legacyTargetBackup := normalized + ".aih-original"
	rawCandidates := []string{
		legacyTargetBackup,
		legacyTargetBackup + filepath.Ext(upstream),
		resolvedTarget + ".aih-original",
	}
	seen := make(map[string]struct{}, len(rawCandidates))
	for _, cand := range rawCandidates {
		if cand == "" || cand == upstream {
			continue
		}
		if _, dup := seen[cand]; !dup {
			seen[cand] = struct{}{}
			legacy = append(legacy, cand)
		}
	}
	if upstream != "" && !fileExists(upstream) && isNodeEntryContent(legacyTargetBackup) {
		if _, dup := seen[legacyTargetBackup]; !dup {
			legacy = append(legacy, legacyTargetBackup)
		}
	}
	return resolvedTarget, upstream, legacy
}

func resolveAliasTargetFromFile(filePath string) string {
	content := readTextFileSafe(filePath)
	if content == "" || !HasAliasWrapperMarkerLine(content) {
		return ""
	}
	if target := extractExecQuotedTarget(content); target != "" {
		return target
	}
	if target := extractPSAliasTarget(content); target != "" {
		return target
	}
	if m := reCmdAliasTarget.FindStringSubmatch(content); len(m) >= 2 {
		return strings.TrimSpace(m[1])
	}
	return ""
}

func resolvePnpmShimRuntimeTarget(filePath string) string {
	content := readTextFileSafe(filePath)
	m := rePnpmShimTarget.FindStringSubmatch(content)
	if len(m) < 2 || strings.TrimSpace(m[1]) == "" {
		return ""
	}
	return filepath.Clean(filepath.Join(filepath.Dir(filePath), m[1]))
}

func resolveUpstreamDelegateTarget(filePath string) string {
	content := readTextFileSafe(filePath)
	if !reDelegateMarkerLine.MatchString(content) {
		return ""
	}
	return extractExecQuotedTarget(content)
}

func (svc *CLIHookService) isCleanExecutableSnapshot(filePath string, visited map[string]struct{}) bool {
	normalized := strings.TrimSpace(filePath)
	if normalized == "" || !fileExists(normalized) || svc.IsWrapperInstalled(normalized) || svc.isAliasWrapperInstalled(normalized) {
		return false
	}
	realPath := resolveRealPathSafe(normalized)
	if _, seen := visited[realPath]; seen {
		return false
	}
	visited[realPath] = struct{}{}

	if pnpmTarget := resolvePnpmShimRuntimeTarget(normalized); pnpmTarget != "" && !fileExists(pnpmTarget) {
		return false
	}
	if delegateTarget := resolveUpstreamDelegateTarget(normalized); delegateTarget != "" {
		return svc.isCleanExecutableSnapshot(delegateTarget, visited)
	}
	return true
}

func (svc *CLIHookService) isTrustedUpstreamFile(upstreamBinaryPath string, targetBinaryPath string) bool {
	upstream := strings.TrimSpace(upstreamBinaryPath)
	if !svc.isCleanExecutableSnapshot(upstream, make(map[string]struct{})) {
		return false
	}
	return !isSameResolvedFile(upstream, targetBinaryPath)
}

func (svc *CLIHookService) resolveStandaloneTarget(startPath string) string {
	hostHome := svc.hostHomeDir
	if hostHome == "" {
		hostHome = strings.TrimSpace(os.Getenv("AIH_HOST_HOME"))
	}
	if hostHome == "" {
		hostHome = strings.TrimSpace(os.Getenv("HOME"))
	}
	if hostHome == "" || svc.platform == "windows" {
		return ""
	}
	candidate := filepath.Join(hostHome, ".codex", "packages", "standalone", "current", "bin", "codex")
	if svc.isTemporaryPath(startPath) && !svc.isTemporaryPath(candidate) {
		return ""
	}
	if svc.isCleanExecutableSnapshot(candidate, make(map[string]struct{})) {
		return candidate
	}
	if svc.IsWrapperInstalled(candidate) && svc.isTrustedUpstreamFile(candidate+".aih-original", candidate) {
		return candidate
	}
	return ""
}

func (svc *CLIHookService) findTrustedRecoveryTarget(startPath string) string {
	normalized := strings.TrimSpace(startPath)
	if normalized == "" {
		return ""
	}
	if standalone := svc.resolveStandaloneTarget(normalized); standalone != "" {
		return standalone
	}

	var triple string
	var pkgName string
	executable := "codex"
	switch {
	case svc.platform == "darwin" && svc.arch == "amd64":
		triple = "x86_64-apple-darwin"
		pkgName = "@openai/codex-darwin-x64"
	case svc.platform == "darwin":
		triple = "aarch64-apple-darwin"
		pkgName = "@openai/codex-darwin-arm64"
	case svc.platform == "windows" && svc.arch == "arm64":
		triple = "aarch64-pc-windows-msvc"
		pkgName = "@openai/codex-win32-arm64"
		executable = "codex.exe"
	case svc.platform == "windows":
		triple = "x86_64-pc-windows-msvc"
		pkgName = "@openai/codex-win32-x64"
		executable = "codex.exe"
	case svc.arch == "arm64":
		triple = "aarch64-unknown-linux-musl"
		pkgName = "@openai/codex-linux-arm64"
	default:
		triple = "x86_64-unknown-linux-musl"
		pkgName = "@openai/codex-linux-x64"
	}

	absDir, err := filepath.Abs(filepath.Dir(normalized))
	if err != nil {
		return ""
	}
	current := absDir
	for current != "" {
		roots := []string{
			filepath.Join(current, pkgName),
			filepath.Join(current, "node_modules", pkgName),
		}
		for _, root := range roots {
			bin := filepath.Join(root, "vendor", triple, "bin", executable)
			for _, cand := range []string{bin, bin + ".aih-original"} {
				if svc.isCleanExecutableSnapshot(cand, make(map[string]struct{})) {
					if r := resolveRealPathSafe(cand); r != "" {
						return r
					}
					return cand
				}
				if svc.IsWrapperInstalled(cand) && svc.isTrustedUpstreamFile(cand+".aih-original", cand) {
					if r := resolveRealPathSafe(cand); r != "" {
						return r
					}
					return cand
				}
			}
		}
		parent := filepath.Dir(current)
		if parent == current {
			break
		}
		current = parent
	}
	return ""
}

func (svc *CLIHookService) resolveCodexBinaryFully() string {
	resolved := strings.TrimSpace(svc.resolveBinaryFn(true))
	svc.lastFullResolution = &cliFullResolutionMemo{
		path: resolved,
		at:   svc.now(),
	}
	return resolved
}

func (svc *CLIHookService) resolveCodexBinary(background bool) string {
	if !background {
		return svc.resolveCodexBinaryFully()
	}
	if scanned := strings.TrimSpace(svc.resolveBinaryFn(false)); scanned != "" {
		return scanned
	}
	if memo := svc.lastFullResolution; memo != nil {
		if svc.now().Sub(memo.at) < svc.backgroundTTL {
			if memo.path == "" || fileExists(memo.path) {
				return memo.path
			}
		}
	}
	return svc.resolveCodexBinaryFully()
}

func (svc *CLIHookService) resolveTargetPaths(targetBinaryPath string) CLIHookPaths {
	if strings.TrimSpace(targetBinaryPath) == "" {
		return CLIHookPaths{Reason: "codex_cli_not_found"}
	}
	resolved, upstream, legacy := svc.ResolveUpstreamBinaryPath(targetBinaryPath)
	if IsCodexDesktopBinary(targetBinaryPath) || IsCodexDesktopBinary(resolved) {
		return CLIHookPaths{
			TargetBinaryPath:         targetBinaryPath,
			ResolvedTargetBinaryPath: resolved,
			Reason:                   "desktop_bundle_binary",
		}
	}
	return CLIHookPaths{
		TargetBinaryPath:          targetBinaryPath,
		ResolvedTargetBinaryPath:  resolved,
		UpstreamBinaryPath:        upstream,
		LegacyUpstreamBinaryPaths: legacy,
	}
}

// ResolvePaths 解析当前规范受管 Codex CLI 目标，必要时沿转发别名解析并执行安全恢复。
func (svc *CLIHookService) ResolvePaths(opts CLIHookEnsureOptions) CLIHookPaths {
	svc.mu.Lock()
	defer svc.mu.Unlock()

	targetBinaryPath := svc.resolveCodexBinary(opts.Background)
	if standalone := svc.resolveStandaloneTarget(targetBinaryPath); standalone != "" {
		targetBinaryPath = standalone
	}

	visited := make(map[string]struct{})
	for targetBinaryPath != "" && svc.isAliasWrapperInstalled(targetBinaryPath) {
		if _, seen := visited[targetBinaryPath]; seen {
			break
		}
		visited[targetBinaryPath] = struct{}{}
		aliasTarget := resolveAliasTargetFromFile(targetBinaryPath)
		if aliasTarget == "" || !fileExists(aliasTarget) {
			targetBinaryPath = svc.findTrustedRecoveryTarget(targetBinaryPath)
			break
		}
		if svc.IsWrapperInstalled(aliasTarget) || svc.isAliasWrapperInstalled(aliasTarget) {
			recovered := svc.findTrustedRecoveryTarget(aliasTarget)
			if recovered == "" {
				recovered = svc.findTrustedRecoveryTarget(targetBinaryPath)
			}
			targetBinaryPath = recovered
			break
		}
		targetBinaryPath = aliasTarget
	}

	if targetBinaryPath != "" && svc.isAliasWrapperInstalled(targetBinaryPath) {
		targetBinaryPath = ""
	}
	if targetBinaryPath != "" && svc.IsWrapperInstalled(targetBinaryPath) {
		current := svc.resolveTargetPaths(targetBinaryPath)
		if !svc.isTrustedUpstreamFile(current.UpstreamBinaryPath, targetBinaryPath) {
			if recovered := svc.findTrustedRecoveryTarget(targetBinaryPath); recovered != "" {
				targetBinaryPath = recovered
			}
		}
	}
	return svc.resolveTargetPaths(targetBinaryPath)
}

func (svc *CLIHookService) collectManagedAliasCandidates(canonicalTargetPath string) []string {
	canonical := resolveRealPathSafe(canonicalTargetPath)
	names := []string{"codex"}
	if svc.platform == "windows" {
		names = []string{"codex", "codex.ps1", "codex.cmd", "codex.bat", "codex.exe"}
	}
	seen := make(map[string]struct{})
	var candidates []string
	for _, dir := range svc.effectivePathEntries() {
		for _, name := range names {
			cand := filepath.Join(dir, name)
			if cand == "" || isSameResolvedFile(cand, canonicalTargetPath) {
				continue
			}
			if svc.isTemporaryPath(canonicalTargetPath) && !svc.isTemporaryPath(cand) {
				continue
			}
			if !fileExists(cand) {
				continue
			}
			if !svc.IsWrapperInstalled(cand) && !svc.isAliasWrapperInstalled(cand) {
				continue
			}
			if resolveRealPathSafe(cand) == canonical {
				continue
			}
			if _, dup := seen[cand]; !dup {
				seen[cand] = struct{}{}
				candidates = append(candidates, cand)
			}
		}
	}
	return candidates
}

// RepairManagedAliases 把 PATH 上其它旧版 AIH 包装或别名重指向规范目标。
func (svc *CLIHookService) RepairManagedAliases(canonicalTargetPath string) []string {
	var repaired []string
	for _, candidate := range svc.collectManagedAliasCandidates(canonicalTargetPath) {
		script := BuildAliasWrapperScript(candidate, canonicalTargetPath)
		if readTextFileSafe(candidate) == script {
			continue
		}
		if err := writeWrapperFile(candidate, script); err == nil {
			repaired = append(repaired, candidate)
		}
	}
	return repaired
}

func (svc *CLIHookService) ensureUpstreamSnapshot(paths CLIHookPaths) (migrated bool, reason string) {
	if svc.isTrustedUpstreamFile(paths.UpstreamBinaryPath, paths.TargetBinaryPath) {
		return false, ""
	}
	for _, legacy := range paths.LegacyUpstreamBinaryPaths {
		if !svc.isTrustedUpstreamFile(legacy, paths.TargetBinaryPath) {
			continue
		}
		if _, err := copyExecutableSnapshot(legacy, paths.UpstreamBinaryPath); err != nil {
			return false, "upstream_backup_copy_failed"
		}
		_ = os.Remove(legacy)
		return true, ""
	}
	if paths.TargetBinaryPath == "" || !fileExists(paths.TargetBinaryPath) {
		return false, "target_binary_missing"
	}
	if svc.IsWrapperInstalled(paths.TargetBinaryPath) {
		return false, "upstream_backup_invalid"
	}
	if _, err := copyExecutableSnapshot(paths.TargetBinaryPath, paths.UpstreamBinaryPath); err != nil {
		return false, "upstream_backup_copy_failed"
	}
	return false, ""
}

func (svc *CLIHookService) isTargetHealthy(paths CLIHookPaths) bool {
	if !svc.IsWrapperInstalled(paths.TargetBinaryPath) {
		return false
	}
	expected := svc.BuildWrapperScriptForTarget(paths.TargetBinaryPath, paths.UpstreamBinaryPath)
	if readTextFileSafe(paths.TargetBinaryPath) != expected {
		return false
	}
	return svc.isTrustedUpstreamFile(paths.UpstreamBinaryPath, paths.TargetBinaryPath)
}

func (svc *CLIHookService) installWrapper(paths CLIHookPaths) CLIHookResult {
	if paths.TargetBinaryPath == "" || !fileExists(paths.TargetBinaryPath) {
		return CLIHookResult{
			OK:     false,
			Reason: "target_binary_missing",
		}
	}
	wrapper := svc.BuildWrapperScriptForTarget(paths.TargetBinaryPath, paths.UpstreamBinaryPath)
	if svc.IsWrapperInstalled(paths.TargetBinaryPath) {
		migrated, errReason := svc.ensureUpstreamSnapshot(paths)
		if errReason != "" {
			return CLIHookResult{
				OK:     false,
				Reason: errReason,
			}
		}
		if err := writeWrapperFile(paths.TargetBinaryPath, wrapper); err != nil {
			code, nonRetryable := classifyNonRetryableInstallError(err)
			var retryPtr *bool
			if nonRetryable {
				f := false
				retryPtr = &f
			}
			return CLIHookResult{
				OK:        false,
				Reason:    "hook_target_not_writable",
				ErrorCode: code,
				Retryable: retryPtr,
			}
		}
		return CLIHookResult{
			OK:                 true,
			Installed:          true,
			Updated:            true,
			Migrated:           migrated,
			TargetBinaryPath:   paths.TargetBinaryPath,
			UpstreamBinaryPath: paths.UpstreamBinaryPath,
		}
	}

	if _, err := copyExecutableSnapshot(paths.TargetBinaryPath, paths.UpstreamBinaryPath); err != nil {
		code, nonRetryable := classifyNonRetryableInstallError(err)
		var retryPtr *bool
		if nonRetryable {
			f := false
			retryPtr = &f
		}
		return CLIHookResult{
			OK:        false,
			Reason:    "hook_target_not_writable",
			ErrorCode: code,
			Retryable: retryPtr,
		}
	}
	if err := writeWrapperFile(paths.TargetBinaryPath, wrapper); err != nil {
		code, nonRetryable := classifyNonRetryableInstallError(err)
		var retryPtr *bool
		if nonRetryable {
			f := false
			retryPtr = &f
		}
		return CLIHookResult{
			OK:        false,
			Reason:    "hook_target_not_writable",
			ErrorCode: code,
			Retryable: retryPtr,
		}
	}
	return CLIHookResult{
		OK:                 true,
		Installed:          true,
		Updated:            false,
		TargetBinaryPath:   paths.TargetBinaryPath,
		UpstreamBinaryPath: paths.UpstreamBinaryPath,
	}
}

func (svc *CLIHookService) sameCLIStateExceptTimestamp(next CLIHookState) bool {
	if svc.stateFilePath == "" {
		return false
	}
	raw, err := os.ReadFile(svc.stateFilePath)
	if err != nil {
		return false
	}
	var current CLIHookState
	if err := json.Unmarshal(raw, &current); err != nil {
		return false
	}
	current.UpdatedAt = ""
	next.UpdatedAt = ""
	return current == next
}

func (svc *CLIHookService) writeState(enabled bool, paths CLIHookPaths, reason string) bool {
	if svc.stateFilePath == "" {
		return false
	}
	next := CLIHookState{
		Version:                  1,
		Enabled:                  enabled,
		UpdatedAt:                svc.now().UTC().Format("2006-01-02T15:04:05.000Z"),
		TargetBinaryPath:         paths.TargetBinaryPath,
		ResolvedTargetBinaryPath: paths.ResolvedTargetBinaryPath,
		UpstreamBinaryPath:       paths.UpstreamBinaryPath,
		Reason:                   reason,
	}
	if svc.sameCLIStateExceptTimestamp(next) {
		return true
	}
	encoded, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return false
	}
	return atomicWriteFile(svc.stateFilePath, encoded, 0o600) == nil
}

func (svc *CLIHookService) inspectOrInstallTarget(paths CLIHookPaths) CLIHookResult {
	if paths.TargetBinaryPath == "" || paths.Reason == "desktop_bundle_binary" {
		reason := paths.Reason
		if reason == "" {
			reason = "codex_cli_not_found"
		}
		return CLIHookResult{
			OK:               true,
			Supported:        true,
			Enabled:          false,
			Reason:           reason,
			TargetBinaryPath: paths.TargetBinaryPath,
		}
	}
	if svc.isTargetHealthy(paths) {
		repairedAliases := svc.RepairManagedAliases(paths.TargetBinaryPath)
		return CLIHookResult{
			OK:                       true,
			Supported:                true,
			Enabled:                  true,
			Healthy:                  true,
			TargetBinaryPath:         paths.TargetBinaryPath,
			ResolvedTargetBinaryPath: paths.ResolvedTargetBinaryPath,
			UpstreamBinaryPath:       paths.UpstreamBinaryPath,
			Repaired:                 len(repairedAliases) > 0,
			RepairedAliases:          repairedAliases,
		}
	}

	installed := svc.installWrapper(paths)
	var repairedAliases []string
	if installed.OK {
		repairedAliases = svc.RepairManagedAliases(paths.TargetBinaryPath)
	}
	installed.Supported = true
	installed.Enabled = installed.OK
	installed.Healthy = installed.OK
	installed.Repaired = installed.OK || len(repairedAliases) > 0
	installed.RepairedAliases = repairedAliases
	installed.TargetBinaryPath = paths.TargetBinaryPath
	installed.ResolvedTargetBinaryPath = paths.ResolvedTargetBinaryPath
	installed.UpstreamBinaryPath = paths.UpstreamBinaryPath
	return installed
}

// EnsureInstalled 校验并在需要时重装 CLI hook，同时持久化未变即不抖动的状态文件。
func (svc *CLIHookService) EnsureInstalled(opts CLIHookEnsureOptions) CLIHookResult {
	paths := svc.ResolvePaths(opts)
	res := svc.inspectOrInstallTarget(paths)
	statePaths := CLIHookPaths{
		TargetBinaryPath:         res.TargetBinaryPath,
		ResolvedTargetBinaryPath: res.ResolvedTargetBinaryPath,
		UpstreamBinaryPath:       res.UpstreamBinaryPath,
	}
	svc.writeState(res.Enabled, statePaths, res.Reason)
	return res
}

// Activate 显式执行完整解析与安装。
func (svc *CLIHookService) Activate() CLIHookResult {
	res := svc.EnsureInstalled(CLIHookEnsureOptions{Background: false})
	res.StateFilePath = svc.stateFilePath
	return res
}

// Deactivate 把 CLI hook 状态标记为已停用。
func (svc *CLIHookService) Deactivate() CLIHookResult {
	paths := svc.ResolvePaths(CLIHookEnsureOptions{})
	if svc.stateFilePath != "" {
		svc.writeState(false, paths, "")
	}
	return CLIHookResult{
		OK:            true,
		Supported:     svc.platform != "windows",
		Enabled:       false,
		StateFilePath: svc.stateFilePath,
	}
}

// ReadState 读取持久化 cli-hook-state.json。
func (svc *CLIHookService) ReadState() CLIHookState {
	if svc.stateFilePath == "" {
		return CLIHookState{}
	}
	raw, err := os.ReadFile(svc.stateFilePath)
	if err != nil {
		return CLIHookState{}
	}
	var state CLIHookState
	if err := json.Unmarshal(raw, &state); err != nil {
		return CLIHookState{}
	}
	return state
}

// Status 返回当前 CLI hook 诊断摘要（不修改磁盘）。
func (svc *CLIHookService) Status() map[string]any {
	paths := svc.ResolvePaths(CLIHookEnsureOptions{Background: true})
	state := svc.ReadState()
	healthy := paths.TargetBinaryPath != "" && paths.Reason == "" && svc.isTargetHealthy(paths)
	return map[string]any{
		"supported":     true,
		"paths":         paths,
		"state":         state,
		"stateFilePath": svc.stateFilePath,
		"healthy":       healthy,
	}
}
