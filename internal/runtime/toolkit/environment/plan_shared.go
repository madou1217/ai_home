package environment

import (
	"strconv"
	"strings"
)

func itoa(value int) string { return strconv.Itoa(value) }

// homePathsWith 把相对家目录的路径展开成绝对路径（BuildOptions 版本）。
func homePathsWith(options BuildOptions, values []string) []string {
	return homePaths(options, values...)
}

// BuildHomeCleanupPlan 是 Node buildHomeCleanupPlan 的等价实现。
func BuildHomeCleanupPlan(toolID string, name string, options BuildOptions, files []string, trees []string) (Plan, bool) {
	return BuildCleanupPlan(toolID, "移除 "+name+" 的程序文件；项目和包缓存不在声明范围内时会保留",
		homePathsWith(options, files), homePathsWith(options, trees), options)
}

// BuildWindowsCleanupPlan 以 Windows 路径口径构造清理计划。
func BuildWindowsCleanupPlan(toolID string, name string, options BuildOptions, files []string, trees []string) (Plan, bool) {
	windowsOptions := options
	windowsOptions.Platform = PlatformWindows
	return BuildHomeCleanupPlan(toolID, name, windowsOptions, files, trees)
}

// BuildProfileAwareCleanupPlan 移除程序文件并从 Shell 配置删除该工具的初始化行。
//
// 脚本逐行照搬 Node platforms/shared.js：按标记 grep -v 删除、去掉删除后
// 文件末尾多出的空行（安装时补过一个空行），最后原子替换回去。
func BuildProfileAwareCleanupPlan(toolID string, name string, patterns []string, files []string, trees []string, options BuildOptions) (Plan, bool) {
	safePatterns := make([]string, 0, len(patterns))
	for _, pattern := range patterns {
		if trimmed := strings.TrimSpace(pattern); trimmed != "" {
			safePatterns = append(safePatterns, trimmed)
		}
	}
	lines := []string{"set -e"}
	for index, pattern := range safePatterns {
		lines = append(lines, "pattern_"+itoa(index)+"="+ShellQuote(pattern))
	}
	lines = append(lines,
		"for profile in \"$HOME/.zshrc\" \"$HOME/.zprofile\" \"$HOME/.bashrc\" \"$HOME/.bash_profile\" \"$HOME/.profile\"; do",
		"  [ -f \"$profile\" ] || continue",
		"  tmp=\"$"+"{profile}.aih-cleanup.$$\"",
		"  cp \"$profile\" \"$tmp\"",
	)
	for index := range safePatterns {
		lines = append(lines, "  grep -v -E \"$pattern_"+itoa(index)+"\" \"$tmp\" > \"$"+"{tmp}.next\" || true; mv \"$"+"{tmp}.next\" \"$tmp\"")
	}
	lines = append(lines,
		"  if ! cmp -s \"$profile\" \"$tmp\"; then awk '{ lines[NR] = $0 } END { n = NR; while (n > 0 && lines[n] == \"\") n--; for (i = 1; i <= n; i++) print lines[i] }' \"$tmp\" > \"$"+"{tmp}.trim\" && mv \"$"+"{tmp}.trim\" \"$tmp\"; fi",
		"  if cmp -s \"$profile\" \"$tmp\"; then rm -f \"$tmp\"; else mv \"$tmp\" \"$profile\"; fi",
		"done",
	)
	for _, target := range homePathsWith(options, files) {
		lines = append(lines, "rm -f -- "+ShellQuote(target))
	}
	for _, target := range homePathsWith(options, trees) {
		lines = append(lines, "rm -rf -- "+ShellQuote(target))
	}
	return CreateLifecyclePlan(toolID, "uninstall", "bash", []string{"-c", strings.Join(lines, "\n")}, PlanOptions{
		ID:     toolID + "_uninstall_profile_cleanup",
		Label:  "卸载 " + name,
		Method: "AIH 清理器",
		Effect: "移除 " + name + " 程序文件，并从 Shell 配置中删除该工具的初始化行",
	}), true
}

// BuildCondaCleanupPlan 是 POSIX 的 Conda 清理计划。
func BuildCondaCleanupPlan(options BuildOptions) Plan {
	roots := homePaths(options, "miniconda3", "anaconda3", ".conda")
	lines := []string{
		"set -e",
		"if command -v conda >/dev/null 2>&1; then conda init --reverse --all >/dev/null 2>&1 || true; fi",
	}
	for _, target := range roots {
		lines = append(lines, "rm -rf -- "+ShellQuote(target))
	}
	return CreateLifecyclePlan("conda", "uninstall", "bash", []string{"-c", strings.Join(lines, "\n")}, PlanOptions{
		ID:     "conda_uninstall_managed_cleanup",
		Label:  "卸载 Miniconda",
		Method: "AIH 清理器",
		Effect: "撤销 Conda Shell 初始化并移除用户目录下的 Miniconda/Conda 程序目录",
	})
}

// BuildPoetryInstallerPlan 是 Poetry 官方安装器的计划。
func BuildPoetryInstallerPlan(action string, options BuildOptions) Plan {
	python := "python3"
	if normalizePlatform(options.Platform) == PlatformWindows {
		python = "py.exe"
	}
	scriptURL := "https://install.python-poetry.org"
	verb := "安装"
	if action == "uninstall" {
		verb = "卸载"
	}
	if normalizePlatform(options.Platform) == PlatformWindows {
		powershell := powershellCommand(options)
		installerArgs := ""
		if action == "uninstall" {
			installerArgs = ", \"--uninstall\""
		}
		script := strings.Join([]string{
			"$ErrorActionPreference = 'Stop'",
			"$dest = Join-Path $env:TEMP ('aih-poetry-' + [guid]::NewGuid().ToString('n') + '.py')",
			buildWindowsDownloadStatements(scriptURL, "Poetry 安装脚本", "$dest"),
			"try { & " + python + " $dest" + installerArgs + " } finally { Remove-Item -Force $dest -ErrorAction SilentlyContinue }",
		}, "; ")
		return CreateLifecyclePlan("poetry", action, powershell, []string{
			"-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
		}, PlanOptions{
			ID:     "poetry_" + action + "_official_installer",
			Label:  verb + " Poetry",
			Method: "Poetry 官方安装器",
			Effect: verb + " Poetry",
		})
	}
	uninstallArg := ""
	if action == "uninstall" {
		uninstallArg = " --uninstall"
	}
	script := strings.Join([]string{
		"set -euo pipefail",
		"tmp=\"$(mktemp -t aih-poetry.XXXXXX)\"",
		"trap 'rm -f \"$tmp\"' EXIT",
		"curl --compressed -fsSL " + ShellQuote(scriptURL) + " -o \"$tmp\"",
		python + " \"$tmp\"" + uninstallArg,
	}, "; ")
	return CreateLifecyclePlan("poetry", action, "bash", []string{"-c", script}, PlanOptions{
		ID:     "poetry_" + action + "_official_installer",
		Label:  verb + " Poetry",
		Method: "Poetry 官方安装器",
		Effect: verb + " Poetry",
	})
}

// appendProfileLinesSnippet 向常见 Shell 配置追加初始化行（按标记去重）。
func appendProfileLinesSnippet(home string, marker string, lines []string) []string {
	profiles := []string{
		ShellQuote(JoinPath(PlatformLinux, home, ".zshrc")),
		ShellQuote(JoinPath(PlatformLinux, home, ".bashrc")),
		ShellQuote(JoinPath(PlatformLinux, home, ".profile")),
	}
	return []string{
		"touch " + ShellQuote(JoinPath(PlatformLinux, home, ".profile")),
		"for profile in " + strings.Join(profiles, " ") + "; do",
		"  [ -f \"$profile\" ] || continue",
		"  if ! grep -qF " + ShellQuote(marker) + " \"$profile\"; then",
		"    { printf '\\n'; printf '%s\\n' " + joinQuoted(lines) + "; } >> \"$profile\"",
		"  fi",
		"done",
	}
}

// resolveBinarySnippet 解析用户级工具的可执行路径（已知位置优先，其次 PATH）。
func resolveBinarySnippet(variable string, knownPath string, command string) []string {
	return []string{
		variable + "=" + ShellQuote(knownPath),
		"if [ ! -x \"$" + variable + "\" ]; then " + variable + "=\"$(command -v " + command + " || true)\"; fi",
		"if [ -z \"$" + variable + "\" ]; then echo \"未找到 " + command + "\" >&2; exit 127; fi",
	}
}

func joinQuoted(values []string) string {
	quoted := make([]string, 0, len(values))
	for _, value := range values {
		quoted = append(quoted, ShellQuote(value))
	}
	return strings.Join(quoted, " ")
}
