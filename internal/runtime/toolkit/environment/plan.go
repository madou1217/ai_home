package environment

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
)

// Plan 是一个可预览、可确认、可执行的生命周期计划（字段与 Node normalizePlan 一致）。
//
// Cwd 用指针是为了输出 null：前端的确认弹窗按「null = 用默认目录」渲染，
// omitempty 会让字段消失而不是 null。
type Plan struct {
	ID                   string            `json:"id"`
	ToolID               string            `json:"toolId"`
	Action               string            `json:"action"`
	Label                string            `json:"label"`
	Method               string            `json:"method"`
	Command              string            `json:"command"`
	Args                 []string          `json:"args"`
	Env                  map[string]string `json:"env"`
	Cwd                  *string           `json:"cwd"`
	Effect               string            `json:"effect"`
	TimeoutMS            int64             `json:"timeoutMs"`
	RequiresConfirmation bool              `json:"requiresConfirmation"`
	Preview              string            `json:"preview"`
}

// PlanOptions 是计划的可选元数据。
type PlanOptions struct {
	ID        string
	Label     string
	Method    string
	Effect    string
	TimeoutMS int64
	Cwd       string
	Env       map[string]string
}

// BuildOptions 是「为哪个目标平台构建计划」的上下文。
//
// 从 WebUI 可以预览其他平台的入门指南：Platform / HomeDir 是目标平台的事实，
// LookupEnv 只用于取 Windows 的 SystemRoot（决定 powershell.exe 的绝对路径）。
type BuildOptions struct {
	Platform  string
	HomeDir   string
	Name      string
	LookupEnv func(string) string
}

func (options BuildOptions) lookup(name string) string {
	if options.LookupEnv != nil {
		return strings.TrimSpace(options.LookupEnv(name))
	}
	return strings.TrimSpace(os.Getenv(name))
}

// 计划超时口径与 Node createLifecyclePlan 一致。
const (
	defaultPlanTimeoutMS = 30 * 60 * 1000
	minPlanTimeoutMS     = 1000
	maxPlanTimeoutMS     = 60 * 60 * 1000
)

// normalizePlanTimeout 复刻 Node 的 Math.min(Math.max(value || 30min, 1s), 1h)。
func normalizePlanTimeout(value int64) int64 {
	timeout := value
	if timeout == 0 {
		timeout = defaultPlanTimeoutMS
	}
	if timeout < minPlanTimeoutMS {
		timeout = minPlanTimeoutMS
	}
	if timeout > maxPlanTimeoutMS {
		timeout = maxPlanTimeoutMS
	}
	return timeout
}

// CreateLifecyclePlan 构造一个基础计划。
func CreateLifecyclePlan(toolID string, action string, command string, args []string, options PlanOptions) Plan {
	normalizedTool := strings.ToLower(strings.TrimSpace(toolID))
	normalizedAction := strings.ToLower(strings.TrimSpace(action))
	id := strings.TrimSpace(options.ID)
	if id == "" {
		id = normalizedTool + "_" + normalizedAction
	}
	planArgs := make([]string, 0, len(args))
	for _, arg := range args {
		planArgs = append(planArgs, arg)
	}
	env := map[string]string{}
	for key, value := range options.Env {
		env[key] = value
	}
	var cwd *string
	if trimmed := strings.TrimSpace(options.Cwd); trimmed != "" {
		cwd = &trimmed
	}
	return Plan{
		ID:                   id,
		ToolID:               normalizedTool,
		Action:               normalizedAction,
		Label:                strings.TrimSpace(options.Label),
		Method:               strings.TrimSpace(options.Method),
		Command:              strings.TrimSpace(command),
		Args:                 planArgs,
		Env:                  env,
		Cwd:                  cwd,
		Effect:               strings.TrimSpace(options.Effect),
		TimeoutMS:            normalizePlanTimeout(options.TimeoutMS),
		RequiresConfirmation: true,
	}
}

// ShellQuote 用 POSIX 单引号引用一个值。
func ShellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}

// PowershellQuote 用 PowerShell 单引号引用一个值。
func PowershellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

// ErrInstallerRequiresHTTPS 与 Node 的 environment_installer_requires_https 同名。
var ErrInstallerRequiresHTTPS = errors.New("environment_installer_requires_https")

// ErrInstallerHostNotAllowed 是主机白名单拒绝。
type ErrInstallerHostNotAllowed struct {
	Host string
}

func (err ErrInstallerHostNotAllowed) Error() string {
	return "environment_installer_host_not_allowed:" + err.Host
}

// AssertHTTPSURL 校验安装脚本地址：必须 https，且主机在白名单内。
func AssertHTTPSURL(raw string, allowedHosts []string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme == "" {
		return "", ErrInstallerRequiresHTTPS
	}
	if parsed.Scheme != "https" {
		return "", ErrInstallerRequiresHTTPS
	}
	hosts := make([]string, 0, len(allowedHosts))
	for _, host := range allowedHosts {
		if trimmed := strings.ToLower(strings.TrimSpace(host)); trimmed != "" {
			hosts = append(hosts, trimmed)
		}
	}
	if len(hosts) > 0 {
		hostname := strings.ToLower(parsed.Hostname())
		allowed := false
		for _, host := range hosts {
			if hostname == host || strings.HasSuffix(hostname, "."+host) {
				allowed = true
				break
			}
		}
		if !allowed {
			return "", ErrInstallerHostNotAllowed{Host: hostname}
		}
	}
	return parsed.String(), nil
}

// BuildShellScriptPlan 下载官方安装脚本并执行（curl + bash）。
func BuildShellScriptPlan(toolID string, action string, sourceURL string, hosts []string, label string, method string, scriptArgs []string, options PlanOptions) (Plan, error) {
	verified, err := AssertHTTPSURL(sourceURL, hosts)
	if err != nil {
		return Plan{}, err
	}
	bashLine := "bash \"$tmp\""
	for _, arg := range scriptArgs {
		bashLine += " " + ShellQuote(arg)
	}
	script := strings.Join([]string{
		"set -euo pipefail",
		"tmp=\"$(mktemp -t aih-env-install.XXXXXX)\"",
		"trap 'rm -f \"$tmp\"' EXIT",
		"curl --compressed -fsSL " + ShellQuote(verified) + " -o \"$tmp\"",
		bashLine,
	}, "; ")
	options.ID = toolID + "_" + action + "_official_script"
	options.Label = label
	options.Method = method
	options.Effect = label
	return CreateLifecyclePlan(toolID, action, "bash", []string{"-c", script}, options), nil
}

// BuildPowerShellScriptPlan 下载官方安装脚本并用 PowerShell 执行。
func BuildPowerShellScriptPlan(toolID string, action string, sourceURL string, hosts []string, label string, method string, options BuildOptions, planOptions PlanOptions) (Plan, error) {
	verified, err := AssertHTTPSURL(sourceURL, hosts)
	if err != nil {
		return Plan{}, err
	}
	powershell := powershellCommand(options)
	script := strings.Join([]string{
		"$ErrorActionPreference = 'Stop'",
		"$ProgressPreference = 'SilentlyContinue'",
		"$dest = Join-Path $env:TEMP ('aih-env-' + [guid]::NewGuid().ToString('n') + '.ps1')",
		buildWindowsDownloadStatements(verified, "安装脚本", "$dest"),
		"try { & $dest } finally { Remove-Item -Force $dest -ErrorAction SilentlyContinue }",
	}, "; ")
	planOptions.ID = toolID + "_" + action + "_official_script"
	planOptions.Label = label
	planOptions.Method = method
	planOptions.Effect = label
	return CreateLifecyclePlan(toolID, action, powershell, []string{
		"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
	}, planOptions), nil
}

// powershellCommand 复刻 Node：有 SystemRoot 时用绝对 powershell.exe，否则用命令名。
func powershellCommand(options BuildOptions) string {
	systemRoot := options.lookup("SystemRoot")
	if systemRoot == "" {
		systemRoot = options.lookup("SYSTEMROOT")
	}
	if systemRoot == "" {
		return "powershell.exe"
	}
	return JoinPath(PlatformWindows, systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

// buildWindowsDownloadStatements 是 Windows 下载语句（优先 curl.exe，回落 Invoke-WebRequest）。
func buildWindowsDownloadStatements(sourceURL string, label string, dest string) string {
	statement := fmt.Sprintf(
		"if ($curl) { & $curl.Source -fL --retry 3 --retry-delay 2 --connect-timeout 30 --speed-limit 1024 --speed-time 60 -o %s %s; if ($LASTEXITCODE -ne 0) { throw (%s + '下载失败: curl 退出码 ' + $LASTEXITCODE) } } else { Invoke-WebRequest -Uri %s -OutFile %s -UseBasicParsing }",
		dest, PowershellQuote(sourceURL), PowershellQuote(label), PowershellQuote(sourceURL), dest,
	)
	return strings.Join([]string{
		"$curl = Get-Command curl.exe -ErrorAction SilentlyContinue",
		statement,
	}, "; ")
}

// ActionLabel 返回中文动作名。
func ActionLabel(action string) string {
	switch action {
	case "install":
		return "安装"
	case "update":
		return "更新"
	case "uninstall":
		return "卸载"
	}
	return action
}

// BuildBrewPlan 构造 Homebrew 计划。
func BuildBrewPlan(toolID string, action string, packageName string, name string, cask bool) Plan {
	flags := []string{}
	if cask {
		flags = []string{"--cask"}
	}
	commands := map[string][]string{
		"install":   append(append([]string{}, "install"), append(flags, packageName)...),
		"update":    append(append([]string{}, "upgrade"), append(flags, packageName)...),
		"uninstall": append(append([]string{}, "uninstall"), append(flags, packageName)...),
	}
	labelAction := ActionLabel(action)
	display := name
	if display == "" {
		display = toolID
	}
	return CreateLifecyclePlan(toolID, action, "brew", commands[action], PlanOptions{
		ID:     toolID + "_" + action + "_homebrew",
		Label:  "Homebrew " + labelAction + " " + display,
		Method: "Homebrew",
		Effect: labelAction + display,
	})
}

// BuildWingetPlan 构造 WinGet 计划。
func BuildWingetPlan(toolID string, action string, packageID string, name string) Plan {
	argsByAction := map[string][]string{
		"install":   {"install", "--id", packageID, "--exact", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements"},
		"update":    {"upgrade", "--id", packageID, "--exact", "--source", "winget", "--accept-package-agreements", "--accept-source-agreements"},
		"uninstall": {"uninstall", "--id", packageID, "--exact"},
	}
	labelAction := ActionLabel(action)
	display := name
	if display == "" {
		display = toolID
	}
	return CreateLifecyclePlan(toolID, action, "winget.exe", argsByAction[action], PlanOptions{
		ID:     toolID + "_" + action + "_winget",
		Label:  "WinGet " + labelAction + " " + display,
		Method: "WinGet",
		Effect: labelAction + display,
	})
}

// BuildNpmGlobalPlan 构造 npm 全局安装计划。
func BuildNpmGlobalPlan(toolID string, action string, packageName string, platform string, name string) Plan {
	command := "npm"
	if normalizePlatform(platform) == PlatformWindows {
		command = "npm.cmd"
	}
	userConfig := "/dev/null"
	if normalizePlatform(platform) == PlatformWindows {
		userConfig = "NUL"
	}
	argsByAction := map[string][]string{
		"install":   {"install", "--global", packageName + "@latest"},
		"update":    {"install", "--global", packageName + "@latest"},
		"uninstall": {"uninstall", "--global", packageName},
	}
	labelAction := ActionLabel(action)
	display := name
	if display == "" {
		display = toolID
	}
	args := append([]string{}, argsByAction[action]...)
	args = append(args, "--userconfig="+userConfig, "--registry=https://registry.npmjs.org")
	return CreateLifecyclePlan(toolID, action, command, args, PlanOptions{
		ID:     toolID + "_" + action + "_npm",
		Label:  "npm " + labelAction + " " + display,
		Method: "npm",
		Effect: labelAction + display,
	})
}

// BuildCommandPlan 构造直接命令计划。
func BuildCommandPlan(toolID string, action string, command string, args []string, options PlanOptions) Plan {
	return CreateLifecyclePlan(toolID, action, command, args, options)
}

// BuildSelfUpdatePlan 构造内置更新器计划。
func BuildSelfUpdatePlan(toolID string, name string, command string, args []string) Plan {
	return BuildCommandPlan(toolID, "update", command, args, PlanOptions{
		ID:     toolID + "_self_update",
		Label:  name + " 自更新",
		Method: "内置更新器",
		Effect: "更新 " + name,
	})
}

// QuoteForPreview 按目标平台引用预览里的单个参数。
func QuoteForPreview(value string, platform string) string {
	text := value
	if isSimplePreviewToken(text) {
		return text
	}
	if normalizePlatform(platform) == PlatformWindows {
		return "\"" + strings.ReplaceAll(text, "\"", "\\\"") + "\""
	}
	return ShellQuote(text)
}

func isSimplePreviewToken(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		switch {
		case char >= 'a' && char <= 'z':
		case char >= 'A' && char <= 'Z':
		case char >= '0' && char <= '9':
		case strings.ContainsRune("_./:@%+=,-", char):
		default:
			return false
		}
	}
	return true
}

// RenderPlanCommand 生成界面展示的完整命令。
func RenderPlanCommand(plan Plan, platform string) string {
	parts := append([]string{plan.Command}, plan.Args...)
	quoted := make([]string, 0, len(parts))
	for _, part := range parts {
		quoted = append(quoted, QuoteForPreview(part, platform))
	}
	return strings.Join(quoted, " ")
}

// homePaths 把相对家目录的路径展开成绝对路径；家目录为空时返回空列表。
func homePaths(options BuildOptions, relativePaths ...string) []string {
	home := strings.TrimSpace(options.HomeDir)
	if home == "" {
		return nil
	}
	result := make([]string, 0, len(relativePaths))
	for _, value := range relativePaths {
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			continue
		}
		result = append(result, JoinPath(options.Platform, home, trimmed))
	}
	return result
}

// isUnsafeCleanupTarget 复刻 Node managed-path-cleaner 的安全校验：
// 空路径、根目录、只有一级的路径都不允许删除。
func isUnsafeCleanupTarget(platform string, target string) bool {
	resolved := NormalizePath(platform, target)
	if resolved == "" {
		return true
	}
	if normalizePlatform(platform) == PlatformWindows {
		trimmed := strings.TrimRight(resolved, "\\")
		if len(trimmed) <= 2 {
			return true
		}
		return false
	}
	if resolved == "/" {
		return true
	}
	trimmed := strings.Trim(resolved, "/")
	return trimmed == "" || !strings.Contains(trimmed, "/")
}

// BuildCleanupPlan 构造「移除已安装程序文件」的计划。
//
// 与 Node 的差异（有意）：Node 的计划是 node managed-path-cleaner.js --aih-managed-path-cleanup，
// 依赖 Node 可执行文件；Go 迁移后不能再把 Node 放进计划里，改为等价的
// bash + rm / PowerShell + Remove-Item。安全校验与删除顺序保持一致。
func BuildCleanupPlan(toolID string, label string, files []string, trees []string, options BuildOptions) (Plan, bool) {
	normalizedFiles := make([]string, 0, len(files))
	seenFiles := map[string]struct{}{}
	for _, target := range files {
		value := NormalizePath(options.Platform, target)
		if value == "" {
			continue
		}
		if isUnsafeCleanupTarget(options.Platform, value) {
			return Plan{}, false
		}
		if _, exists := seenFiles[value]; exists {
			continue
		}
		seenFiles[value] = struct{}{}
		normalizedFiles = append(normalizedFiles, value)
	}
	normalizedTrees := make([]string, 0, len(trees))
	seenTrees := map[string]struct{}{}
	for _, target := range trees {
		value := NormalizePath(options.Platform, target)
		if value == "" {
			continue
		}
		if isUnsafeCleanupTarget(options.Platform, value) {
			return Plan{}, false
		}
		if _, exists := seenTrees[value]; exists {
			continue
		}
		seenTrees[value] = struct{}{}
		normalizedTrees = append(normalizedTrees, value)
	}
	if len(normalizedFiles) == 0 && len(normalizedTrees) == 0 {
		return Plan{}, false
	}
	displayLabel := strings.TrimSpace(label)
	if displayLabel == "" {
		displayLabel = "清理已安装程序文件"
	}
	if normalizePlatform(options.Platform) == PlatformWindows {
		statements := []string{"$ErrorActionPreference = 'Stop'"}
		for _, target := range normalizedFiles {
			statements = append(statements, "Remove-Item -LiteralPath "+PowershellQuote(target)+" -Force -ErrorAction SilentlyContinue")
		}
		for _, target := range normalizedTrees {
			statements = append(statements, "Remove-Item -LiteralPath "+PowershellQuote(target)+" -Recurse -Force -ErrorAction SilentlyContinue")
		}
		return CreateLifecyclePlan(toolID, "uninstall", powershellCommand(options), []string{
			"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", strings.Join(statements, "; "),
		}, PlanOptions{
			ID:        toolID + "_uninstall_managed_cleanup",
			Label:     displayLabel,
			Method:    "AIH 清理器",
			TimeoutMS: 5 * 60 * 1000,
		}), true
	}
	statements := []string{"set -e"}
	for _, target := range normalizedFiles {
		statements = append(statements, "rm -f -- "+ShellQuote(target))
	}
	for _, target := range normalizedTrees {
		statements = append(statements, "rm -rf -- "+ShellQuote(target))
	}
	return CreateLifecyclePlan(toolID, "uninstall", "bash", []string{"-c", strings.Join(statements, "\n")}, PlanOptions{
		ID:        toolID + "_uninstall_managed_cleanup",
		Label:     displayLabel,
		Method:    "AIH 清理器",
		TimeoutMS: 5 * 60 * 1000,
	}), true
}
