package codexhooks

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const vscodeExtensionIDPrefix = "openai.chatgpt"

// VscodeTarget 表示单个 VSCode 扩展内的 Codex 二进制与其备份路径。
type VscodeTarget struct {
	TargetBinaryPath   string `json:"targetBinaryPath"`
	UpstreamBinaryPath string `json:"upstreamBinaryPath"`
}

// VscodeTargetResult 表示单个扩展目标的包装器安装结果。
type VscodeTargetResult struct {
	OK                 bool   `json:"ok"`
	Installed          bool   `json:"installed"`
	Updated            bool   `json:"updated"`
	Changed            bool   `json:"changed"`
	Reason             string `json:"reason,omitempty"`
	ErrorCode          string `json:"errorCode,omitempty"`
	TargetBinaryPath   string `json:"targetBinaryPath"`
	UpstreamBinaryPath string `json:"upstreamBinaryPath,omitempty"`
}

// VscodeHookResult 表示 VSCode 扩展注入或巡检的聚合结果。
type VscodeHookResult struct {
	OK        bool                 `json:"ok"`
	Supported bool                 `json:"supported"`
	Enabled   bool                 `json:"enabled"`
	Installed int                  `json:"installed"`
	Changed   bool                 `json:"changed"`
	Repaired  bool                 `json:"repaired"`
	Reason    string               `json:"reason,omitempty"`
	Targets   []VscodeTargetResult `json:"targets"`
}

// VscodeHookOptions 配置 VscodeHookService。
type VscodeHookOptions struct {
	AIHomeDir        string
	HostHomeDir      string
	Platform         string
	NodeExecPath     string
	HelperScriptPath string
	ExtensionRoots   []string
	VSCodeExtensions string
	SelfPID          int
	ListProcesses    func() ([]ProcessInfo, error)
	KillProcess      func(pid int) error
}

// VscodeHookService 管理 macOS 下 VSCode / VSCode Insiders ChatGPT 扩展内置 codex 包装器。
type VscodeHookService struct {
	aiHomeDir        string
	hostHomeDir      string
	platform         string
	nodeExecPath     string
	helperScriptPath string
	stateFilePath    string
	extensionRoots   []string
	vscodeExtEnv     string
	selfPID          int
	listProcessesFn  func() ([]ProcessInfo, error)
	killProcessFn    func(pid int) error
}

// NewVscodeHookService 创建 VSCode 扩展 hook 管理服务。
func NewVscodeHookService(opts VscodeHookOptions) *VscodeHookService {
	aiHome := strings.TrimSpace(opts.AIHomeDir)
	stateFilePath := ""
	if aiHome != "" {
		stateFilePath = filepath.Join(aiHome, "run", "codex", "desktop-hook-state.json")
	}
	selfPID := opts.SelfPID
	if selfPID == 0 {
		selfPID = os.Getpid()
	}
	return &VscodeHookService{
		aiHomeDir:        aiHome,
		hostHomeDir:      strings.TrimSpace(opts.HostHomeDir),
		platform:         NormalizePlatform(opts.Platform),
		nodeExecPath:     strings.TrimSpace(opts.NodeExecPath),
		helperScriptPath: strings.TrimSpace(opts.HelperScriptPath),
		stateFilePath:    stateFilePath,
		extensionRoots:   opts.ExtensionRoots,
		vscodeExtEnv:     strings.TrimSpace(opts.VSCodeExtensions),
		selfPID:          selfPID,
		listProcessesFn:  opts.ListProcesses,
		killProcessFn:    opts.KillProcess,
	}
}

func (svc *VscodeHookService) resolveExtensionRoots() []string {
	var raw []string
	if len(svc.extensionRoots) > 0 {
		raw = append(raw, svc.extensionRoots...)
	} else {
		extEnv := svc.vscodeExtEnv
		if extEnv == "" {
			extEnv = strings.TrimSpace(os.Getenv("VSCODE_EXTENSIONS"))
		}
		if extEnv != "" {
			raw = append(raw, extEnv)
		}
		if svc.hostHomeDir != "" {
			raw = append(raw,
				filepath.Join(svc.hostHomeDir, ".vscode", "extensions"),
				filepath.Join(svc.hostHomeDir, ".vscode-insiders", "extensions"),
			)
		}
	}
	seen := make(map[string]struct{}, len(raw))
	var out []string
	for _, root := range raw {
		trimmed := strings.TrimSpace(root)
		if trimmed == "" {
			continue
		}
		if _, dup := seen[trimmed]; !dup {
			seen[trimmed] = struct{}{}
			out = append(out, trimmed)
		}
	}
	return out
}

func isOpenAIChatGPTExtensionDir(name string) bool {
	trimmed := strings.TrimSpace(name)
	return trimmed == vscodeExtensionIDPrefix || strings.HasPrefix(trimmed, vscodeExtensionIDPrefix+"-")
}

// ResolvePaths 查找当前机器上所有 VSCode ChatGPT 扩展内置 codex 可执行文件。
func (svc *VscodeHookService) ResolvePaths() []VscodeTarget {
	if svc.platform != "darwin" {
		return nil
	}
	seen := make(map[string]struct{})
	var binaryPaths []string

	for _, root := range svc.resolveExtensionRoots() {
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if !entry.IsDir() || !isOpenAIChatGPTExtensionDir(entry.Name()) {
				continue
			}
			binDir := filepath.Join(root, entry.Name(), "bin")
			platformEntries, err := os.ReadDir(binDir)
			if err != nil {
				continue
			}
			for _, pEntry := range platformEntries {
				if !pEntry.IsDir() || !strings.HasPrefix(pEntry.Name(), "macos-") {
					continue
				}
				candidate := filepath.Join(binDir, pEntry.Name(), "codex")
				if isRegularFile(candidate) {
					if _, dup := seen[candidate]; !dup {
						seen[candidate] = struct{}{}
						binaryPaths = append(binaryPaths, candidate)
					}
				}
			}
		}
	}

	sort.Strings(binaryPaths)
	targets := make([]VscodeTarget, 0, len(binaryPaths))
	for _, targetPath := range binaryPaths {
		targets = append(targets, VscodeTarget{
			TargetBinaryPath:   targetPath,
			UpstreamBinaryPath: targetPath + ".aih-original",
		})
	}
	return targets
}

// BuildWrapperScript 生成 VSCode 扩展使用的 POSIX app-server 包装脚本文本。
func (svc *VscodeHookService) BuildWrapperScript(upstreamBinaryPath string) string {
	return BuildCodexAppServerWrapperScript(WrapperMarkerVscode, WrapperOptions{
		NodeExecPath:       svc.nodeExecPath,
		HelperScriptPath:   svc.helperScriptPath,
		UpstreamBinaryPath: upstreamBinaryPath,
		StateFilePath:      svc.stateFilePath,
	})
}

// IsWrapperInstalled 判断给定目标路径是否已安装 VSCode hook 包装器。
func (svc *VscodeHookService) IsWrapperInstalled(targetBinaryPath string) bool {
	if !fileExists(targetBinaryPath) {
		return false
	}
	return readFileMarkerPrefix(targetBinaryPath, WrapperMarkerVscode)
}

func (svc *VscodeHookService) installWrapper(target VscodeTarget) VscodeTargetResult {
	if target.TargetBinaryPath == "" || target.UpstreamBinaryPath == "" || !fileExists(target.TargetBinaryPath) {
		return VscodeTargetResult{
			OK:               false,
			Reason:           "target_binary_missing",
			TargetBinaryPath: target.TargetBinaryPath,
		}
	}
	if svc.stateFilePath == "" {
		return VscodeTargetResult{
			OK:               false,
			Reason:           "state_file_unavailable",
			TargetBinaryPath: target.TargetBinaryPath,
		}
	}

	wrapper := svc.BuildWrapperScript(target.UpstreamBinaryPath)
	if svc.IsWrapperInstalled(target.TargetBinaryPath) {
		if !fileExists(target.UpstreamBinaryPath) {
			return VscodeTargetResult{
				OK:               false,
				Reason:           "missing_upstream_backup",
				TargetBinaryPath: target.TargetBinaryPath,
			}
		}
		if readTextFileSafe(target.TargetBinaryPath) != wrapper {
			if err := writeWrapperFile(target.TargetBinaryPath, wrapper); err != nil {
				code, _ := classifyNonRetryableInstallError(err)
				return VscodeTargetResult{
					OK:               false,
					Reason:           "hook_target_not_writable",
					ErrorCode:        code,
					TargetBinaryPath: target.TargetBinaryPath,
				}
			}
			return VscodeTargetResult{
				OK:                 true,
				Updated:            true,
				Changed:            true,
				TargetBinaryPath:   target.TargetBinaryPath,
				UpstreamBinaryPath: target.UpstreamBinaryPath,
			}
		}
		return VscodeTargetResult{
			OK:                 true,
			TargetBinaryPath:   target.TargetBinaryPath,
			UpstreamBinaryPath: target.UpstreamBinaryPath,
		}
	}

	if _, err := copyExecutableSnapshot(target.TargetBinaryPath, target.UpstreamBinaryPath); err != nil {
		code, _ := classifyNonRetryableInstallError(err)
		return VscodeTargetResult{
			OK:               false,
			Reason:           "hook_target_not_writable",
			ErrorCode:        code,
			TargetBinaryPath: target.TargetBinaryPath,
		}
	}
	if err := writeWrapperFile(target.TargetBinaryPath, wrapper); err != nil {
		code, _ := classifyNonRetryableInstallError(err)
		return VscodeTargetResult{
			OK:               false,
			Reason:           "hook_target_not_writable",
			ErrorCode:        code,
			TargetBinaryPath: target.TargetBinaryPath,
		}
	}
	return VscodeTargetResult{
		OK:                 true,
		Installed:          true,
		Changed:            true,
		TargetBinaryPath:   target.TargetBinaryPath,
		UpstreamBinaryPath: target.UpstreamBinaryPath,
	}
}

func (svc *VscodeHookService) installAll() VscodeHookResult {
	if svc.platform != "darwin" {
		return VscodeHookResult{
			OK:        true,
			Supported: false,
			Enabled:   false,
			Reason:    "unsupported_platform",
			Targets:   []VscodeTargetResult{},
		}
	}
	targets := svc.ResolvePaths()
	if len(targets) == 0 {
		return VscodeHookResult{
			OK:        true,
			Supported: true,
			Enabled:   false,
			Reason:    "vscode_codex_extension_not_found",
			Targets:   []VscodeTargetResult{},
		}
	}
	results := make([]VscodeTargetResult, 0, len(targets))
	failed := false
	installed := 0
	changed := false
	for _, target := range targets {
		res := svc.installWrapper(target)
		results = append(results, res)
		if !res.OK {
			failed = true
		}
		if res.Installed {
			installed++
		}
		if res.Changed {
			changed = true
		}
	}
	reason := ""
	if failed {
		reason = "install_failed"
	}
	return VscodeHookResult{
		OK:        !failed,
		Supported: true,
		Enabled:   !failed,
		Installed: installed,
		Changed:   changed,
		Reason:    reason,
		Targets:   results,
	}
}

// Activate 立即检查并注入所有已发现的 VSCode Codex 扩展二进制。
func (svc *VscodeHookService) Activate() VscodeHookResult {
	return svc.installAll()
}

// EnsureInstalled 巡检并修复 VSCode Codex 扩展包装器，返回是否发生修复。
func (svc *VscodeHookService) EnsureInstalled() VscodeHookResult {
	res := svc.installAll()
	res.Repaired = res.OK && res.Changed
	return res
}

func defaultListUnixCommands() ([]ProcessInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ps", "-axo", "pid=,command=").Output()
	if err != nil {
		return nil, err
	}
	var procs []ProcessInfo
	for _, line := range strings.Split(string(out), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		idx := strings.IndexAny(trimmed, " \t")
		if idx <= 0 {
			continue
		}
		pid, err := strconv.Atoi(trimmed[:idx])
		if err != nil || pid <= 0 {
			continue
		}
		procs = append(procs, ProcessInfo{
			PID:     pid,
			Command: strings.TrimSpace(trimmed[idx+1:]),
		})
	}
	return procs, nil
}

// ListRunningAppServerProcesses 枚举命令行命中 VSCode 扩展 codex app-server 的进程。
func (svc *VscodeHookService) ListRunningAppServerProcesses() []ProcessInfo {
	targets := svc.ResolvePaths()
	if len(targets) == 0 {
		return nil
	}
	var needles []string
	for _, t := range targets {
		if t.TargetBinaryPath != "" {
			needles = append(needles, t.TargetBinaryPath)
		}
		if t.UpstreamBinaryPath != "" {
			needles = append(needles, t.UpstreamBinaryPath)
		}
	}
	listFn := svc.listProcessesFn
	if listFn == nil {
		listFn = defaultListUnixCommands
	}
	procs, err := listFn()
	if err != nil {
		return nil
	}
	var out []ProcessInfo
	for _, proc := range procs {
		if proc.PID <= 0 || proc.PID == svc.selfPID {
			continue
		}
		if !strings.Contains(proc.Command, "app-server") {
			continue
		}
		for _, needle := range needles {
			if strings.Contains(proc.Command, needle) {
				out = append(out, proc)
				break
			}
		}
	}
	return out
}

// RestartRunningAppServers 向仍在运行的 VSCode app-server 发送 SIGTERM。
func (svc *VscodeHookService) RestartRunningAppServers() RestartAppServersResult {
	killFn := svc.killProcessFn
	if killFn == nil {
		killFn = func(pid int) error {
			proc, err := os.FindProcess(pid)
			if err != nil {
				return err
			}
			return proc.Signal(syscall.SIGTERM)
		}
	}
	procs := svc.ListRunningAppServerProcesses()
	var signaled []int
	for _, proc := range procs {
		if err := killFn(proc.PID); err == nil {
			signaled = append(signaled, proc.PID)
		}
	}
	if signaled == nil {
		signaled = []int{}
	}
	return RestartAppServersResult{
		OK:    true,
		Count: len(signaled),
		PIDs:  signaled,
	}
}

// Status 返回 VSCode 扩展 hook 诊断摘要。
func (svc *VscodeHookService) Status() map[string]any {
	targets := svc.ResolvePaths()
	installedCount := 0
	for _, t := range targets {
		if svc.IsWrapperInstalled(t.TargetBinaryPath) && fileExists(t.UpstreamBinaryPath) {
			installedCount++
		}
	}
	return map[string]any{
		"supported":      svc.platform == "darwin",
		"targetCount":    len(targets),
		"installedCount": installedCount,
		"targets":        targets,
	}
}
