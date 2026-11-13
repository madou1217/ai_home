// Package codexhooks 提供 Codex Desktop、VSCode 扩展与 CLI 包装器注入、自愈循环
// 以及会话通知队列的 Go 原生运行时实现。
package codexhooks

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

const (
	// CodexAppServerPassthroughEnv 允许内部调用方绕过包装器直连上游 app-server。
	CodexAppServerPassthroughEnv = "AIH_CODEX_APP_SERVER_PASSTHROUGH"

	// WrapperMarkerDesktop 标识由 Codex Desktop 钩子写入的包装器。
	WrapperMarkerDesktop = "aih-codex-desktop-hook"
	// WrapperMarkerVscode 标识由 Codex VSCode 扩展钩子写入的包装器。
	WrapperMarkerVscode = "aih-codex-vscode-hook"
	// WrapperMarkerCLI 标识由 Codex CLI 钩子写入的包装器。
	WrapperMarkerCLI = "aih-codex-cli-hook"
	// WrapperAliasMarker 标识指向唯一受管包装器的 PATH 转发别名。
	WrapperAliasMarker = "aih-codex-cli-hook-alias"
	// UpstreamDelegateMarker 标识上游测试或委托脚本标记。
	UpstreamDelegateMarker = "aih-codex-upstream-delegate"
	// WrapperUpstreamVar 是 Windows 批处理包装器暴露原二进制的约定环境变量名（跨模块契约）。
	WrapperUpstreamVar = "UPSTREAM"

	// HookStrategyInPlace 表示原地备份上游二进制后覆写包装器。
	HookStrategyInPlace = "in-place"
	// HookStrategyExternalLauncher 表示外部启动器模式（如新版 ChatGPT.app）。
	HookStrategyExternalLauncher = "external-launcher"

	// maxMarkerProbeBytes 限制检查包装器标记时读取的头部字节数，避免读入完整二进制。
	maxMarkerProbeBytes = 16 * 1024
)

// CodexGlobalValueOptions 是位于子命令之前且消费后续一个参数的 Codex 全局选项。
var CodexGlobalValueOptions = []string{
	"-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env",
	"-i", "--image", "-m", "--model", "--local-provider", "-p", "--profile",
	"-s", "--sandbox", "-C", "--cd", "--add-dir", "-a", "--ask-for-approval",
}

var (
	codexGlobalValueOptionSet = func() map[string]struct{} {
		set := make(map[string]struct{}, len(CodexGlobalValueOptions))
		for _, opt := range CodexGlobalValueOptions {
			set[opt] = struct{}{}
		}
		return set
	}()
	// PreserveBackupExtensions 在构建 .aih-original 备份文件名时必须保留扩展名。
	PreserveBackupExtensions = map[string]struct{}{
		".js":  {},
		".mjs": {},
		".cjs": {},
		".ps1": {},
		".cmd": {},
		".bat": {},
		".exe": {},
	}
	nodeEntryExtensions = map[string]struct{}{
		".js":  {},
		".mjs": {},
		".cjs": {},
	}
	windowsPS1Extensions = map[string]struct{}{
		".ps1": {},
	}
	windowsCmdExtensions = map[string]struct{}{
		".cmd": {},
		".bat": {},
	}

	reCLIMarkerLine      = regexp.MustCompile(`(?m)^(?:#|REM) ` + regexp.QuoteMeta(WrapperMarkerCLI) + `\r?$`)
	reAliasMarkerLine    = regexp.MustCompile(`(?m)^(?:#|REM) ` + regexp.QuoteMeta(WrapperAliasMarker) + `\r?$`)
	reDelegateMarkerLine = regexp.MustCompile(`(?m)^# ` + regexp.QuoteMeta(UpstreamDelegateMarker) + `\r?$`)
	reExecSingleQuoted   = regexp.MustCompile(`(?m)^exec\s+'(.+?)'\s+"\$@"\s*$`)
	reExecDoubleQuoted   = regexp.MustCompile(`(?m)^exec\s+"(.+?)"\s+"\$@"\s*$`)
	rePSSingleQuoted     = regexp.MustCompile(`(?m)^&\s+'(.+?)'\s+@args\s*$`)
	rePSDoubleQuoted     = regexp.MustCompile(`(?m)^&\s+"(.+?)"\s+@args\s*$`)
	reCmdAliasTarget     = regexp.MustCompile(`(?mi)^call\s+"(.+?)"\s+%\*\s*$`)
	reCmdSetVarPattern   = `(?mi)^\s*set\s+"%s=([^"\r\n]*)"`
	rePnpmShimTarget     = regexp.MustCompile(`\$basedir/([^"]*node_modules/@openai/codex/bin/codex\.js)`)
)

// DesktopLayout 描述 Codex 桌面端在不同平台和安装包版本下的二进制布局。
type DesktopLayout struct {
	ID            string
	Platform      string
	BinarySubpath string
	HookStrategy  string
}

// CodexDesktopBundleNames 按探测优先级列出 macOS Codex 桌面端 App Bundle 名称。
var CodexDesktopBundleNames = []string{"ChatGPT.app", "Codex.app"}

// CodexDesktopLayouts 按兼容性优先级列出桌面端内部 Codex 二进制布局。
var CodexDesktopLayouts = []DesktopLayout{
	{
		ID:            "macos-nested-cli",
		Platform:      "darwin",
		BinarySubpath: filepath.Join("Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex"),
		HookStrategy:  HookStrategyExternalLauncher,
	},
	{
		ID:            "macos-resources",
		Platform:      "darwin",
		BinarySubpath: filepath.Join("Contents", "Resources", "codex"),
	},
	{
		ID:            "windows-store",
		Platform:      "windows",
		BinarySubpath: filepath.Join("app", "resources", "codex.exe"),
	},
}

// WrapperOptions 定义生成 app-server / CLI 包装脚本所需的路径与行为选项。
type WrapperOptions struct {
	NodeExecPath                 string
	HelperScriptPath             string
	UpstreamBinaryPath           string
	StateFilePath                string
	RouteDefaultCLIThroughHelper bool
}

// WindowsHookLaunch 描述绕过 .cmd 直接拉起 Node 包装脚本的启动参数。
type WindowsHookLaunch struct {
	Command  string
	Args     []string
	HookPath string
}

// NormalizePlatform 把宿主或测试注入的平台名称统一成 darwin / windows / linux 等标准值。
func NormalizePlatform(platform string) string {
	switch strings.ToLower(strings.TrimSpace(platform)) {
	case "", "default":
		return runtime.GOOS
	case "macos", "osx", "darwin":
		return "darwin"
	case "win32", "win", "windows":
		return "windows"
	default:
		return strings.ToLower(strings.TrimSpace(platform))
	}
}

// NormalizeArch 把架构名称统一成 amd64 / arm64 等与 Node/Go 兼容的口径。
func NormalizeArch(arch string) string {
	switch strings.ToLower(strings.TrimSpace(arch)) {
	case "":
		return runtime.GOARCH
	case "x64", "x86_64", "amd64":
		return "amd64"
	case "aarch64", "arm64":
		return "arm64"
	default:
		return strings.ToLower(strings.TrimSpace(arch))
	}
}

// IsCodexDesktopBinary 判断给定路径是否位于 Codex 桌面应用（如 ChatGPT.app / Codex.app）包内。
func IsCodexDesktopBinary(binaryPath string) bool {
	trimmed := strings.TrimSpace(binaryPath)
	if trimmed == "" {
		return false
	}
	normalized := filepath.ToSlash(trimmed)
	for _, bundle := range CodexDesktopBundleNames {
		if strings.Contains(normalized, "/"+bundle+"/") || strings.HasPrefix(normalized, bundle+"/") {
			return true
		}
	}
	return false
}

// ResolveDesktopLayout 在给定 bundle 根目录与平台下匹配第一个存在的桌面端内部布局。
func ResolveDesktopLayout(root string, platform string, layouts []DesktopLayout) (DesktopLayout, string, bool) {
	cleanRoot := strings.TrimSpace(root)
	if cleanRoot == "" {
		return DesktopLayout{}, "", false
	}
	targetPlatform := NormalizePlatform(platform)
	activeLayouts := layouts
	if len(activeLayouts) == 0 {
		activeLayouts = CodexDesktopLayouts
	}
	for _, layout := range activeLayouts {
		if NormalizePlatform(layout.Platform) != targetPlatform {
			continue
		}
		candidate := filepath.Join(cleanRoot, layout.BinarySubpath)
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return layout, candidate, true
		}
	}
	return DesktopLayout{}, "", false
}

// ShellQuote 对 POSIX Shell 单引号参数进行安全转义。
func ShellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// PowerShellSingleQuote 对 PowerShell 单引号字面量进行转义。
func PowerShellSingleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "''") + "'"
}

// CmdSetValue 对 Windows cmd `set "NAME=VALUE"` 中的双引号进行转义。
func CmdSetValue(value string) string {
	return strings.ReplaceAll(value, `"`, `""`)
}

// FindCodexSubcommand 从 Codex CLI 参数中解析首个位置子命令（跳过全局带值选项）。
func FindCodexSubcommand(args []string) string {
	expectOptionValue := false
	for _, argument := range args {
		if expectOptionValue {
			expectOptionValue = false
			continue
		}
		if argument == "--" {
			return ""
		}
		if _, ok := codexGlobalValueOptionSet[argument]; ok {
			expectOptionValue = true
			continue
		}
		if strings.HasPrefix(argument, "-") {
			continue
		}
		return argument
	}
	return ""
}

// BuildCodexAppServerWrapperScript 构建 POSIX Shell 包装脚本，保持与 Node 版逐行契约一致。
func BuildCodexAppServerWrapperScript(marker string, options WrapperOptions) string {
	lines := []string{
		"#!/bin/sh",
		"# " + marker,
		"UPSTREAM=" + ShellQuote(options.UpstreamBinaryPath),
		"NODE_BIN=" + ShellQuote(options.NodeExecPath),
		"HELPER=" + ShellQuote(options.HelperScriptPath),
		"STATE_FILE=" + ShellQuote(options.StateFilePath),
		"AIH_SUBCOMMAND=",
		"AIH_EXPECT_OPTION_VALUE=0",
		`for AIH_ARG in "$@"; do`,
		`  if [ "$AIH_EXPECT_OPTION_VALUE" = "1" ]; then`,
		"    AIH_EXPECT_OPTION_VALUE=0",
		"    continue",
		"  fi",
		`  case "$AIH_ARG" in`,
		"    " + strings.Join(CodexGlobalValueOptions, "|") + ")",
		"      AIH_EXPECT_OPTION_VALUE=1",
		"      ;;",
		"    --)",
		"      break",
		"      ;;",
		"    --*=*|-*)",
		"      ;;",
		"    *)",
		`      AIH_SUBCOMMAND="$AIH_ARG"`,
		"      break",
		"      ;;",
		"  esac",
		"done",
		`if [ "$AIH_SUBCOMMAND" = "resume" ]; then`,
		`  exec "$NODE_BIN" "$HELPER" --run-cli-resume --upstream "$UPSTREAM" --state-file "$STATE_FILE" -- "$@"`,
		"fi",
		fmt.Sprintf(`if [ "$AIH_SUBCOMMAND" = "app-server" ] && [ "${%s:-}" = "1" ]; then`, CodexAppServerPassthroughEnv),
		fmt.Sprintf("  unset %s", CodexAppServerPassthroughEnv),
		`  exec "$UPSTREAM" "$@"`,
		"fi",
		`if [ "$AIH_SUBCOMMAND" = "app-server" ]; then`,
		`  exec "$NODE_BIN" "$HELPER" --upstream "$UPSTREAM" --state-file "$STATE_FILE" -- "$@"`,
		"fi",
	}
	if options.RouteDefaultCLIThroughHelper {
		lines = append(lines, `exec "$NODE_BIN" "$HELPER" --run-cli-default --upstream "$UPSTREAM" --state-file "$STATE_FILE" -- "$@"`)
	} else {
		lines = append(lines, `exec "$UPSTREAM" "$@"`)
	}
	lines = append(lines, "")
	return strings.Join(lines, "\n")
}

// BuildWindowsPowerShellWrapperScript 构建 Windows .ps1 包装脚本。
func BuildWindowsPowerShellWrapperScript(options WrapperOptions) string {
	quotedOpts := make([]string, len(CodexGlobalValueOptions))
	for i, opt := range CodexGlobalValueOptions {
		quotedOpts[i] = PowerShellSingleQuote(opt)
	}
	lines := []string{
		"#!/usr/bin/env pwsh",
		"# " + WrapperMarkerCLI,
		"$upstream = " + PowerShellSingleQuote(options.UpstreamBinaryPath),
		"$nodeBin = " + PowerShellSingleQuote(options.NodeExecPath),
		"if (-not (Test-Path -LiteralPath $nodeBin -PathType Leaf)) {",
		"  $nodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1",
		"  if ($nodeCommand) { $nodeBin = $nodeCommand.Source }",
		"}",
		"$helper = " + PowerShellSingleQuote(options.HelperScriptPath),
		"$stateFile = " + PowerShellSingleQuote(options.StateFilePath),
		"$forwardArgs = @($args)",
		"$valueOptions = @(" + strings.Join(quotedOpts, ", ") + ")",
		"$subcommand = $null",
		"$expectOptionValue = $false",
		"foreach ($arg in $forwardArgs) {",
		"  if ($expectOptionValue) { $expectOptionValue = $false; continue }",
		`  if ($arg -eq "--") { break }`,
		"  if ($valueOptions -contains $arg) { $expectOptionValue = $true; continue }",
		`  if ($arg.StartsWith("-")) { continue }`,
		"  $subcommand = $arg",
		"  break",
		"}",
		`if ($subcommand -eq "resume") {`,
		`  $proxyArgs = @($helper, "--run-cli-resume", "--upstream", $upstream, "--state-file", $stateFile, "--") + $forwardArgs`,
		"  if ($MyInvocation.ExpectingInput) {",
		"    $input | & $nodeBin @proxyArgs",
		"  } else {",
		"    & $nodeBin @proxyArgs",
		"  }",
		"  exit $LASTEXITCODE",
		"}",
		`if ($subcommand -eq "app-server") {`,
		fmt.Sprintf(`  if ($env:%s -eq "1") {`, CodexAppServerPassthroughEnv),
		fmt.Sprintf("    Remove-Item Env:%s -ErrorAction SilentlyContinue", CodexAppServerPassthroughEnv),
		"    & $upstream @forwardArgs",
		"    exit $LASTEXITCODE",
		"  }",
		`  $proxyArgs = @($helper, "--upstream", $upstream, "--state-file", $stateFile, "--") + $forwardArgs`,
		"  if ($MyInvocation.ExpectingInput) {",
		"    $input | & $nodeBin @proxyArgs",
		"  } else {",
		"    & $nodeBin @proxyArgs",
		"  }",
		"  exit $LASTEXITCODE",
		"}",
		`  $proxyArgs = @($helper, "--run-cli-default", "--upstream", $upstream, "--state-file", $stateFile, "--") + $forwardArgs`,
		"if ($MyInvocation.ExpectingInput) {",
		"  $input | & $nodeBin @proxyArgs",
		"} else {",
		"  & $nodeBin @proxyArgs",
		"}",
		"exit $LASTEXITCODE",
		"",
	}
	return strings.Join(lines, "\n")
}

// BuildWindowsCmdWrapperScript 构建 Windows .cmd/.bat 包装脚本，保留 REM aih-codex-cli-hook 与 UPSTREAM 变量契约。
func BuildWindowsCmdWrapperScript(options WrapperOptions) string {
	lines := []string{
		"@echo off",
		"REM " + WrapperMarkerCLI,
		"setlocal",
		fmt.Sprintf(`set "%s=%s"`, WrapperUpstreamVar, CmdSetValue(options.UpstreamBinaryPath)),
		fmt.Sprintf(`set "NODE_BIN=%s"`, CmdSetValue(options.NodeExecPath)),
		`if not exist "%NODE_BIN%" for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "NODE_BIN=%%~$PATH:I"`,
		fmt.Sprintf(`set "HELPER=%s"`, CmdSetValue(options.HelperScriptPath)),
		fmt.Sprintf(`set "STATE_FILE=%s"`, CmdSetValue(options.StateFilePath)),
		"call :AIH_FIND_SUBCOMMAND %*",
		"goto :AIH_DISPATCH",
		":AIH_FIND_SUBCOMMAND",
		`set "AIH_SUBCOMMAND="`,
		":AIH_SCAN_NEXT",
		`if "%~1"=="" exit /b 0`,
		`if "%~1"=="--" exit /b 0`,
	}
	for _, opt := range CodexGlobalValueOptions {
		lines = append(lines, fmt.Sprintf(`if /I "%%~1"=="%s" goto :AIH_SKIP_OPTION_VALUE`, opt))
	}
	lines = append(lines,
		`set "AIH_SCAN_ARG=%~1"`,
		`if "%AIH_SCAN_ARG:~0,1%"=="-" (`,
		"  shift",
		"  goto :AIH_SCAN_NEXT",
		")",
		`set "AIH_SUBCOMMAND=%~1"`,
		"exit /b 0",
		":AIH_SKIP_OPTION_VALUE",
		"shift",
		`if not "%~1"=="" shift`,
		"goto :AIH_SCAN_NEXT",
		":AIH_DISPATCH",
		`if /I "%AIH_SUBCOMMAND%"=="resume" (`,
		`  "%NODE_BIN%" "%HELPER%" --run-cli-resume --upstream "%UPSTREAM%" --state-file "%STATE_FILE%" -- %*`,
		"  exit /b %ERRORLEVEL%",
		")",
		`if /I "%AIH_SUBCOMMAND%"=="app-server" (`,
		fmt.Sprintf(`  if "%%%s%%"=="1" (`, CodexAppServerPassthroughEnv),
		fmt.Sprintf(`    set "%s="`, CodexAppServerPassthroughEnv),
		`    call "%UPSTREAM%" %*`,
		"    exit /b %ERRORLEVEL%",
		"  )",
		`  "%NODE_BIN%" "%HELPER%" --upstream "%UPSTREAM%" --state-file "%STATE_FILE%" -- %*`,
		"  exit /b %ERRORLEVEL%",
		")",
		`"%NODE_BIN%" "%HELPER%" --run-cli-default --upstream "%UPSTREAM%" --state-file "%STATE_FILE%" -- %*`,
		"exit /b %ERRORLEVEL%",
		"",
	)
	return strings.Join(lines, "\r\n")
}

// BuildCLIWrapperScript 构建 POSIX CLI 包装脚本。
func BuildCLIWrapperScript(options WrapperOptions) string {
	options.RouteDefaultCLIThroughHelper = true
	return BuildCodexAppServerWrapperScript(WrapperMarkerCLI, options)
}

// BuildCLIWrapperScriptForTarget 按目标文件扩展名选择对应的 POSIX / PowerShell / CMD 包装脚本。
func BuildCLIWrapperScriptForTarget(targetBinaryPath string, options WrapperOptions) string {
	ext := strings.ToLower(strings.TrimSpace(filepath.Ext(targetBinaryPath)))
	if _, ok := windowsPS1Extensions[ext]; ok {
		return BuildWindowsPowerShellWrapperScript(options)
	}
	if _, ok := windowsCmdExtensions[ext]; ok {
		return BuildWindowsCmdWrapperScript(options)
	}
	return BuildCLIWrapperScript(options)
}

// BuildAliasWrapperScript 生成转发到规范受管包装器的别名垫片。
func BuildAliasWrapperScript(targetBinaryPath string, canonicalTargetPath string) string {
	ext := strings.ToLower(strings.TrimSpace(filepath.Ext(targetBinaryPath)))
	if _, ok := windowsPS1Extensions[ext]; ok {
		return strings.Join([]string{
			"# " + WrapperAliasMarker,
			"& " + PowerShellSingleQuote(canonicalTargetPath) + " @args",
			"exit $LASTEXITCODE",
			"",
		}, "\r\n")
	}
	if _, ok := windowsCmdExtensions[ext]; ok {
		return strings.Join([]string{
			"@echo off",
			"REM " + WrapperAliasMarker,
			fmt.Sprintf(`call "%s" %%*`, CmdSetValue(canonicalTargetPath)),
			"exit /b %ERRORLEVEL%",
			"",
		}, "\r\n")
	}
	return strings.Join([]string{
		"#!/bin/sh",
		"# " + WrapperAliasMarker,
		"exec " + ShellQuote(canonicalTargetPath) + ` "$@"`,
		"",
	}, "\n")
}

// HasCLIWrapperMarkerLine 检查脚本文本是否包含独立的 CLI wrapper 注释标记行。
func HasCLIWrapperMarkerLine(content string) bool {
	return reCLIMarkerLine.MatchString(content)
}

// HasAliasWrapperMarkerLine 检查脚本文本是否包含独立的转发别名注释标记行。
func HasAliasWrapperMarkerLine(content string) bool {
	return reAliasMarkerLine.MatchString(content)
}

// ReadCmdSetVariable 从 Windows .cmd 包装脚本中提取指定 `set "VAR=VALUE"` 的值。
func ReadCmdSetVariable(body string, name string) string {
	cleanName := strings.TrimSpace(name)
	if cleanName == "" {
		return ""
	}
	pattern, err := regexp.Compile(fmt.Sprintf(reCmdSetVarPattern, regexp.QuoteMeta(cleanName)))
	if err != nil {
		return ""
	}
	matches := pattern.FindStringSubmatch(body)
	if len(matches) < 2 {
		return ""
	}
	return strings.TrimSpace(matches[1])
}

// ResolveWindowsCodexHookLaunch 在 Windows 下解析 CLI hook，绕过 .cmd 直接拉起 Node 助手。
func ResolveWindowsCodexHookLaunch(cliBin string, args []string, platform string, fallbackNodeExec string) *WindowsHookLaunch {
	if NormalizePlatform(platform) != "windows" {
		return nil
	}
	hookPath := strings.TrimSpace(cliBin)
	for depth := 0; depth < 3 && hookPath != ""; depth++ {
		ext := strings.ToLower(filepath.Ext(hookPath))
		if ext != ".cmd" && ext != ".bat" {
			return nil
		}
		raw, err := readFilePrefix(hookPath, 64*1024)
		if err != nil {
			return nil
		}
		body := string(raw)
		if strings.Contains(body, WrapperAliasMarker) {
			matches := reCmdAliasTarget.FindStringSubmatch(body)
			if len(matches) < 2 {
				return nil
			}
			target := strings.TrimSpace(matches[1])
			if !strings.HasSuffix(strings.ToLower(target), ".cmd") {
				return nil
			}
			hookPath = target
			continue
		}
		if !strings.Contains(body, WrapperMarkerCLI) {
			return nil
		}
		helper := ReadCmdSetVariable(body, "HELPER")
		upstream := ReadCmdSetVariable(body, WrapperUpstreamVar)
		stateFile := ReadCmdSetVariable(body, "STATE_FILE")
		if helper == "" || upstream == "" || stateFile == "" || !fileExists(helper) {
			return nil
		}
		configuredNode := ReadCmdSetVariable(body, "NODE_BIN")
		nodeBin := strings.TrimSpace(fallbackNodeExec)
		if configuredNode != "" && fileExists(configuredNode) {
			nodeBin = configuredNode
		}
		if nodeBin == "" {
			return nil
		}
		subcommand := strings.ToLower(FindCodexSubcommand(args))
		if subcommand == "app-server" {
			return nil
		}
		mode := "--run-cli-default"
		if subcommand == "resume" {
			mode = "--run-cli-resume"
		}
		launchArgs := make([]string, 0, 7+len(args))
		launchArgs = append(launchArgs, helper, mode, "--upstream", upstream, "--state-file", stateFile, "--")
		launchArgs = append(launchArgs, args...)
		return &WindowsHookLaunch{
			Command:  nodeBin,
			Args:     launchArgs,
			HookPath: hookPath,
		}
	}
	return nil
}

func readFilePrefix(filePath string, limit int) ([]byte, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	return io.ReadAll(io.LimitReader(file, int64(limit)))
}

func readTextFileSafe(filePath string) string {
	trimmed := strings.TrimSpace(filePath)
	if trimmed == "" {
		return ""
	}
	data, err := os.ReadFile(trimmed)
	if err != nil {
		return ""
	}
	return string(data)
}

func readFileMarkerPrefix(filePath string, marker string) bool {
	trimmed := strings.TrimSpace(filePath)
	if trimmed == "" {
		return false
	}
	prefix, err := readFilePrefix(trimmed, maxMarkerProbeBytes)
	if err != nil || bytes.IndexByte(prefix, 0) >= 0 {
		return false
	}
	return strings.Contains(string(prefix), marker)
}

func fileExists(filePath string) bool {
	if strings.TrimSpace(filePath) == "" {
		return false
	}
	_, err := os.Stat(filePath)
	return err == nil
}

func isRegularFile(filePath string) bool {
	if strings.TrimSpace(filePath) == "" {
		return false
	}
	info, err := os.Stat(filePath)
	return err == nil && !info.IsDir()
}

// copyExecutableSnapshot 原子复制可执行文件快照，保持原权限位。
func copyExecutableSnapshot(sourcePath string, destinationPath string) (os.FileInfo, error) {
	stat, err := os.Stat(sourcePath)
	if err != nil {
		return nil, err
	}
	content, err := os.ReadFile(sourcePath)
	if err != nil {
		return nil, err
	}
	perm := stat.Mode().Perm()
	if perm == 0 {
		perm = 0o755
	}
	if err := atomicWriteFile(destinationPath, content, perm); err != nil {
		return nil, err
	}
	return stat, nil
}

// writeWrapperFile 先断开潜在符号链接，再以 0o755 权限原子写入包装脚本，防止覆写链接目标。
func writeWrapperFile(targetBinaryPath string, wrapper string) error {
	if info, err := os.Lstat(targetBinaryPath); err == nil && info.Mode()&os.ModeSymlink != 0 {
		if rmErr := os.Remove(targetBinaryPath); rmErr != nil {
			return rmErr
		}
	}
	return atomicWriteFile(targetBinaryPath, []byte(wrapper), 0o755)
}

func atomicWriteFile(targetPath string, content []byte, perm os.FileMode) error {
	dir := filepath.Dir(targetPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(targetPath)+".aih-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()
	if _, err := tmp.Write(content); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, targetPath); err != nil {
		return err
	}
	cleanup = false
	_ = os.Chmod(targetPath, perm)
	return nil
}

func sha256Hex(content []byte) string {
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:])
}

func fileRevision(filePath string) string {
	trimmed := strings.TrimSpace(filePath)
	if trimmed == "" {
		return ""
	}
	content, err := os.ReadFile(trimmed)
	if err != nil {
		return ""
	}
	return sha256Hex(content)
}

// FileFingerprint 描述上游原始二进制的尺寸和毫秒级修改时间，用于检测升级漂移。
type FileFingerprint struct {
	Size    int64   `json:"size"`
	MtimeMs float64 `json:"mtimeMs"`
}

func readFileFingerprint(filePath string) *FileFingerprint {
	trimmed := strings.TrimSpace(filePath)
	if trimmed == "" {
		return nil
	}
	info, err := os.Stat(trimmed)
	if err != nil {
		return nil
	}
	return &FileFingerprint{
		Size:    info.Size(),
		MtimeMs: float64(info.ModTime().UnixNano()) / 1e6,
	}
}

func sameFingerprint(left *FileFingerprint, right *FileFingerprint) bool {
	if left == nil || right == nil {
		return false
	}
	return left.Size == right.Size && left.MtimeMs == right.MtimeMs
}

func classifyNonRetryableInstallError(err error) (string, bool) {
	if err == nil {
		return "", false
	}
	if errors.Is(err, os.ErrPermission) {
		return "EACCES", true
	}
	msg := strings.ToUpper(err.Error())
	for _, code := range []string{"EACCES", "EPERM", "EROFS"} {
		if strings.Contains(msg, code) {
			return code, true
		}
	}
	if strings.Contains(strings.ToLower(msg), "operation not permitted") || strings.Contains(strings.ToLower(msg), "read-only file system") {
		return "EPERM", true
	}
	return "", false
}

func extractExecQuotedTarget(content string) string {
	if m := reExecSingleQuoted.FindStringSubmatch(content); len(m) >= 2 {
		return strings.TrimSpace(strings.ReplaceAll(m[1], `'\''`, `'`))
	}
	if m := reExecDoubleQuoted.FindStringSubmatch(content); len(m) >= 2 {
		return strings.TrimSpace(m[1])
	}
	return ""
}

func extractPSAliasTarget(content string) string {
	if m := rePSSingleQuoted.FindStringSubmatch(content); len(m) >= 2 {
		return strings.TrimSpace(strings.ReplaceAll(m[1], "''", "'"))
	}
	if m := rePSDoubleQuoted.FindStringSubmatch(content); len(m) >= 2 {
		return strings.TrimSpace(m[1])
	}
	return ""
}
