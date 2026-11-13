// Package terminals 实现宿主机客户端终端（system-default、WezTerm、Warp、iTerm2、Windows Terminal、CMD）
// 的探测、安装/更新/卸载计划生成、本机终端窗口拉起及异步任务管理。
package terminals

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

const (
	PlatformMacOS   = "macos"
	PlatformWindows = "windows"
	PlatformLinux   = "linux"

	DefaultTerminalID = "system-default"
	DefaultTitle      = "AI Home 终端"
)

var (
	plainTokenRx    = regexp.MustCompile(`^[A-Za-z0-9_.:=/+\\-]+$`)
	winExtSuffixRx  = regexp.MustCompile(`\.[a-z0-9]+$`)
	winCmdSepRx     = regexp.MustCompile(`^[&|<>]+$`)
	winTokenPattern = regexp.MustCompile(`"([^"\\]*(?:\\.[^"\\]*)*)"|(\S+)`)
	winWtAliasRx    = regexp.MustCompile(`(?i)[\\/]WindowsApps[\\/]wt\.exe$`)
	winWtPkgExeRx   = regexp.MustCompile(`(?i)[\\/]WindowsApps[\\/].*[\\/]WindowsTerminal\.exe$`)
	winTerminalExe  = regexp.MustCompile(`(?i)[\\/]WindowsTerminal\.exe$`)
)

// LaunchSpec 描述一次拉起宿主客户端终端窗口的进程规格。
type LaunchSpec struct {
	TerminalID               string   `json:"terminalId"`
	File                     string   `json:"file"`
	Args                     []string `json:"args"`
	Title                    string   `json:"title,omitempty"`
	WindowsHide              *bool    `json:"windowsHide,omitempty"`
	WindowsVerbatimArguments bool     `json:"windowsVerbatimArguments,omitempty"`
	TerminalExecutable       string   `json:"terminalExecutable,omitempty"`
}

// Options 控制终端探测、生命周期规划、启动和异步任务注入依赖。
type Options struct {
	Platform    string
	Arch        string
	HostHomeDir string
	Env         map[string]string
	LookupEnv   func(string) string
	PathExists  func(string) bool
	Exec        environment.Executor
	Launcher    func(LaunchSpec) (int, error)
	Now         func() int64
}

// PlanSummary 是终端列表项中的轻量可执行计划摘要。
type PlanSummary struct {
	Action  string `json:"action"`
	Label   string `json:"label"`
	Command string `json:"command"`
}

// TerminalView 对齐 WebUI `/toolkit/terminals` 返回的单终端结构。
type TerminalView struct {
	ID             string        `json:"id"`
	Name           string        `json:"name"`
	Description    string        `json:"description"`
	SourceURL      string        `json:"sourceUrl"`
	Platform       string        `json:"platform"`
	Installed      bool          `json:"installed"`
	Default        bool          `json:"default"`
	ExecutablePath string        `json:"executablePath"`
	CanInstall     bool          `json:"canInstall"`
	CanUpdate      bool          `json:"canUpdate"`
	CanUninstall   bool          `json:"canUninstall"`
	CanLaunch      bool          `json:"canLaunch"`
	PackageManager string        `json:"packageManager"`
	Plans          []PlanSummary `json:"plans"`
}

// ListResult 是 `/terminals` 与 `/toolkit/terminals` 的响应体。
type ListResult struct {
	OK        bool           `json:"ok"`
	Platform  string         `json:"platform"`
	HomeDir   string         `json:"homeDir"`
	Terminals []TerminalView `json:"terminals"`
}

// Detection 描述单个终端插件的安装探测结果。
type Detection struct {
	Installed      bool
	ExecutablePath string
}

type platformExecutables struct {
	BinaryNames  []string
	ManagedPaths []string
	Paths        []string
}

type terminalPlugin struct {
	ID                        string
	Name                      string
	Description               string
	SourceURL                 string
	Default                   bool
	Platforms                 []string
	HiddenOnPlatforms         []string
	WindowsOrder              int
	HasWindowsOrder           bool
	WindowsDefaultWhenInstall bool
	WindowsFallbackDefault    bool
	Executables               map[string]platformExecutables
	Detect                    func(o Options) Detection
	BuildLaunch               func(command string, title string, o Options) *LaunchSpec
	BuildLifecycle            func(o Options, installedPath string) []rawLifecyclePlan
}

type rawLifecyclePlan struct {
	Action         string
	Label          string
	PackageManager string
	File           string
	Args           []string
}

func (o Options) withDefaults() Options {
	out := o
	if out.Now == nil {
		out.Now = func() int64 { return time.Now().UnixMilli() }
	}
	return out
}

// NormalizePlatform 将 GOOS / Node platform / 客户端名称规范为 macos / windows / linux。
func NormalizePlatform(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "darwin", "macos", "mac", "osx":
		return PlatformMacOS
	case "win32", "windows", "win":
		return PlatformWindows
	case "linux":
		return PlatformLinux
	default:
		return ""
	}
}

// NormalizeArchitecture 将 GOARCH / Node arch 规范为 arm64 / x64 / unknown。
func NormalizeArchitecture(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "arm64", "aarch64":
		return "arm64"
	case "amd64", "x86_64", "x64":
		return "x64"
	default:
		return "unknown"
	}
}

func (o Options) clientPlatform() string {
	if p := NormalizePlatform(o.Platform); p != "" {
		return p
	}
	if p := NormalizePlatform(runtime.GOOS); p != "" {
		return p
	}
	return PlatformLinux
}

func (o Options) clientArch() string {
	if a := NormalizeArchitecture(o.Arch); a != "unknown" {
		return a
	}
	requested := NormalizePlatform(o.Platform)
	host := NormalizePlatform(runtime.GOOS)
	if requested != "" && requested != host {
		return "unknown"
	}
	if v := firstNonEmpty(o.lookupEnv("PROCESSOR_ARCHITEW6432"), o.lookupEnv("PROCESSOR_ARCHITECTURE")); v != "" {
		if a := NormalizeArchitecture(v); a != "unknown" {
			return a
		}
	}
	return NormalizeArchitecture(runtime.GOARCH)
}

func (o Options) lookupEnv(key string) string {
	if o.Env != nil {
		if val, ok := o.Env[key]; ok {
			return val
		}
		// Windows 环境变量大小写不敏感。
		for k, v := range o.Env {
			if strings.EqualFold(k, key) {
				return v
			}
		}
	}
	if o.LookupEnv != nil {
		if val := o.LookupEnv(key); val != "" {
			return val
		}
	}
	if o.Env == nil && o.LookupEnv == nil {
		return os.Getenv(key)
	}
	return ""
}

func (o Options) hostHome() string {
	if v := strings.TrimSpace(o.HostHomeDir); v != "" {
		return v
	}
	if o.clientPlatform() == PlatformWindows {
		if v := strings.TrimSpace(o.lookupEnv("USERPROFILE")); v != "" {
			return v
		}
	}
	if v := strings.TrimSpace(o.lookupEnv("HOME")); v != "" {
		return v
	}
	if o.Env == nil && o.LookupEnv == nil {
		if h, err := os.UserHomeDir(); err == nil {
			return strings.TrimSpace(h)
		}
	}
	return ""
}

func (o Options) exists(candidate string) bool {
	trimmed := strings.TrimSpace(candidate)
	if trimmed == "" {
		return false
	}
	if o.PathExists != nil {
		return o.PathExists(trimmed)
	}
	// 先 Stat 再 Lstat，兼容 Windows Store AppExecutionAlias 的 0 字节 reparse point。
	if _, err := os.Stat(trimmed); err == nil {
		return true
	}
	if _, err := os.Lstat(trimmed); err == nil {
		return true
	}
	return false
}

func joinPlatformPath(platform string, parts ...string) string {
	filtered := make([]string, 0, len(parts))
	for _, p := range parts {
		if strings.TrimSpace(p) != "" {
			filtered = append(filtered, p)
		}
	}
	if len(filtered) == 0 {
		return ""
	}
	if platform == PlatformWindows {
		joined := filtered[0]
		for _, p := range filtered[1:] {
			joined = strings.TrimRight(joined, `\/`) + `\` + strings.TrimLeft(p, `\/`)
		}
		return cleanWindowsPath(joined)
	}
	return path.Join(filtered...)
}

func cleanWindowsPath(raw string) string {
	if raw == "" {
		return ""
	}
	converted := strings.ReplaceAll(raw, "/", `\`)
	// filepath.Clean on POSIX treats `\` as literal; normalize manually for cross-platform planning.
	parts := strings.Split(converted, `\`)
	stack := make([]string, 0, len(parts))
	for i, seg := range parts {
		if seg == "" && i > 0 {
			continue
		}
		if seg == "." {
			continue
		}
		if seg == ".." && len(stack) > 1 {
			stack = stack[:len(stack)-1]
			continue
		}
		stack = append(stack, seg)
	}
	return strings.Join(stack, `\`)
}

func normalizePlatformPath(platform string, raw string) string {
	if raw == "" {
		return ""
	}
	if platform == PlatformWindows {
		return cleanWindowsPath(raw)
	}
	return filepath.Clean(raw)
}

func findOnPath(names []string, o Options) string {
	platform := o.clientPlatform()
	pathEnv := firstNonEmpty(o.lookupEnv("PATH"), o.lookupEnv("Path"), o.lookupEnv("path"))
	sep := ":"
	if platform == PlatformWindows {
		sep = ";"
	}
	dirs := strings.Split(pathEnv, sep)
	for _, rawDir := range dirs {
		dir := strings.TrimSpace(rawDir)
		if dir == "" {
			continue
		}
		for _, rawName := range names {
			name := strings.TrimSpace(rawName)
			if name == "" {
				continue
			}
			candidate := joinPlatformPath(platform, dir, name)
			if o.exists(candidate) {
				return candidate
			}
			if platform == PlatformWindows && !winExtSuffixRx.MatchString(name) {
				exe := candidate + ".exe"
				if o.exists(exe) {
					return exe
				}
			}
		}
	}
	return ""
}

func findFirstExisting(paths []string, o Options) string {
	for _, candidate := range paths {
		if strings.TrimSpace(candidate) != "" && o.exists(candidate) {
			return candidate
		}
	}
	return ""
}

func resolveLifecycleExecutable(names []string, fallbackPaths []string, o Options) string {
	if found := findOnPath(names, o); found != "" {
		return found
	}
	return findFirstExisting(fallbackPaths, o)
}

func resolveTerminalExecutable(plugin terminalPlugin, resolvePkg func(Options) string, o Options) string {
	platform := o.clientPlatform()
	cfg, ok := plugin.Executables[platform]
	if !ok {
		return ""
	}
	home := o.hostHome()
	localApp := strings.TrimSpace(o.lookupEnv("LOCALAPPDATA"))
	if localApp == "" && home != "" {
		localApp = joinPlatformPath(platform, home, "AppData", "Local")
	}
	expand := func(raw []string) []string {
		out := make([]string, 0, len(raw))
		for _, item := range raw {
			if strings.Contains(item, "{hostHomeDir}") && home == "" {
				continue
			}
			if strings.Contains(item, "{localAppData}") && localApp == "" {
				continue
			}
			expanded := strings.ReplaceAll(item, "{hostHomeDir}", home)
			expanded = strings.ReplaceAll(expanded, "{localAppData}", localApp)
			if expanded != "" {
				out = append(out, normalizePlatformPath(platform, expanded))
			}
		}
		return out
	}
	if managed := findFirstExisting(expand(cfg.ManagedPaths), o); managed != "" {
		return managed
	}
	if resolvePkg != nil {
		if pkgExe := resolvePkg(o); pkgExe != "" {
			return pkgExe
		}
	}
	if pathExe := findOnPath(cfg.BinaryNames, o); pathExe != "" {
		return pathExe
	}
	return findFirstExisting(expand(cfg.Paths), o)
}

func runSyncCommand(ctx context.Context, o Options, file string, args ...string) (string, error) {
	if o.Exec != nil {
		res := o.Exec.Run(ctx, file, args, environment.ExecOptions{Timeout: environment.DefaultProbeTimeout})
		if !res.OK {
			return res.Stdout, errors.New(firstNonEmpty(res.Message, res.Stderr, "command_failed"))
		}
		return res.Stdout, nil
	}
	cmd := exec.CommandContext(ctx, file, args...)
	out, err := cmd.Output()
	return string(out), err
}

// ShellQuote 按目标平台转义命令参数用于展示或 Shell 拼接。
func ShellQuote(value string, platform string) string {
	if platform == PlatformWindows {
		return `"` + strings.ReplaceAll(value, `"`, `\"`) + `"`
	}
	return `'` + strings.ReplaceAll(value, `'`, `'\''`) + `'`
}

func renderCommand(file string, args []string, platform string) string {
	parts := make([]string, 0, 1+len(args))
	parts = append(parts, ShellQuote(file, platform))
	for _, arg := range args {
		parts = append(parts, ShellQuote(arg, platform))
	}
	return strings.Join(parts, " ")
}

func BuildInteractiveShellCommand(o Options) string {
	platform := o.clientPlatform()
	if platform == PlatformWindows {
		return "echo AI Home terminal"
	}
	fallback := "/bin/bash"
	if platform == PlatformMacOS {
		fallback = "/bin/zsh"
	}
	shell := firstNonEmpty(strings.TrimSpace(o.lookupEnv("SHELL")), fallback)
	return "exec " + ShellQuote(shell, platform) + " -l"
}

func escapeAppleScriptString(value string) string {
	s := strings.ReplaceAll(value, `\`, `\\`)
	return strings.ReplaceAll(s, `"`, `\"`)
}

func escapeCmdTitle(value string) string {
	return strings.ReplaceAll(value, `"`, `'`)
}

func buildWindowsCmdLaunchSpec(command string, newConsole bool, title string) LaunchSpec {
	line := `"` + command + `"`
	if newConsole {
		line = `start "` + escapeCmdTitle(title) + `" cmd.exe /d /s /k "` + command + `"`
	}
	hide := true
	return LaunchSpec{
		File:                     "cmd.exe",
		Args:                     []string{"/d", "/s", "/c", line},
		Title:                    title,
		WindowsHide:              &hide,
		WindowsVerbatimArguments: true,
	}
}

func tokenizeWindowsTerminalCommand(command string) []string {
	matches := winTokenPattern.FindAllStringSubmatch(command, -1)
	tokens := make([]string, 0, len(matches))
	for _, m := range matches {
		token := strings.TrimSpace(firstNonEmpty(m[1], m[2]))
		if token != "" {
			tokens = append(tokens, token)
		}
	}
	return tokens
}

func quoteWindowsStartToken(value string) string {
	if value == "" {
		return `""`
	}
	if winCmdSepRx.MatchString(value) {
		var b strings.Builder
		for _, r := range value {
			b.WriteByte('^')
			b.WriteRune(r)
		}
		return b.String()
	}
	if plainTokenRx.MatchString(value) {
		return value
	}
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func buildWindowsTerminalStartLine(executable string, title string, command string) string {
	startExecutable := executable
	if winWtAliasRx.MatchString(executable) {
		startExecutable = "wt.exe"
	}
	childArgs := []string{"-w", "new", "new-tab", "--title", title, "cmd.exe", "/d", "/s", "/k"}
	childArgs = append(childArgs, tokenizeWindowsTerminalCommand(command)...)
	rendered := make([]string, 0, len(childArgs))
	for _, a := range childArgs {
		rendered = append(rendered, quoteWindowsStartToken(a))
	}
	return `start "" ` + quoteWindowsStartToken(startExecutable) + " " + strings.Join(rendered, " ")
}

func supportsPlatform(plugin terminalPlugin, platform string) bool {
	for _, p := range plugin.Platforms {
		if p == platform {
			return true
		}
	}
	return false
}

func isHiddenOnPlatform(plugin terminalPlugin, platform string) bool {
	for _, p := range plugin.HiddenOnPlatforms {
		if p == platform {
			return true
		}
	}
	return false
}

// ListClientTerminals 列出当前平台受支持的客户端终端，探测安装态、默认标记和生命周期计划。
func ListClientTerminals(opts Options) ListResult {
	o := opts.withDefaults()
	platform := o.clientPlatform()
	homeDir := o.hostHome()
	plugins := allTerminalPlugins()
	type entryWrap struct {
		view   TerminalView
		plugin terminalPlugin
		index  int
	}
	wraps := make([]entryWrap, 0, len(plugins))
	shellCmd := BuildInteractiveShellCommand(o)

	for idx, plugin := range plugins {
		if !supportsPlatform(plugin, platform) {
			continue
		}
		det := Detection{Installed: false}
		if plugin.Detect != nil {
			det = plugin.Detect(o)
		}
		var plans []rawLifecyclePlan
		if plugin.BuildLifecycle != nil {
			plans = plugin.BuildLifecycle(o, det.ExecutablePath)
		}
		actionSet := make(map[string]bool, len(plans))
		summaries := make([]PlanSummary, 0, len(plans))
		pkgManager := ""
		for i, plan := range plans {
			act := strings.TrimSpace(plan.Action)
			actionSet[act] = true
			if i == 0 {
				pkgManager = strings.TrimSpace(plan.PackageManager)
			}
			summaries = append(summaries, PlanSummary{
				Action:  act,
				Label:   plan.Label,
				Command: renderCommand(plan.File, plan.Args, platform),
			})
		}
		canLaunch := false
		if plugin.BuildLaunch != nil && plugin.BuildLaunch(shellCmd, DefaultTitle, o) != nil {
			canLaunch = true
		}
		view := TerminalView{
			ID:             plugin.ID,
			Name:           plugin.Name,
			Description:    plugin.Description,
			SourceURL:      plugin.SourceURL,
			Platform:       platform,
			Installed:      det.Installed,
			Default:        plugin.Default,
			ExecutablePath: det.ExecutablePath,
			CanInstall:     !det.Installed && actionSet["install"],
			CanUpdate:      det.Installed && actionSet["update"],
			CanUninstall:   det.Installed && actionSet["uninstall"],
			CanLaunch:      canLaunch,
			PackageManager: pkgManager,
			Plans:          summaries,
		}
		wraps = append(wraps, entryWrap{view: view, plugin: plugin, index: idx})
	}

	if platform == PlatformWindows {
		visible := make([]entryWrap, 0, len(wraps))
		for _, w := range wraps {
			if !isHiddenOnPlatform(w.plugin, PlatformWindows) {
				visible = append(visible, w)
			}
		}
		sort.SliceStable(visible, func(i, j int) bool {
			li, ri := visible[i], visible[j]
			lo := 1<<30 - 1
			if li.plugin.HasWindowsOrder {
				lo = li.plugin.WindowsOrder
			}
			ro := 1<<30 - 1
			if ri.plugin.HasWindowsOrder {
				ro = ri.plugin.WindowsOrder
			}
			if lo != ro {
				return lo < ro
			}
			return li.index < ri.index
		})
		out := make([]TerminalView, 0, len(visible))
		defaultAssigned := false
		for _, w := range visible {
			v := w.view
			v.Default = false
			out = append(out, v)
		}
		for i, w := range visible {
			if w.plugin.WindowsDefaultWhenInstall && out[i].Installed {
				out[i].Default = true
				defaultAssigned = true
				break
			}
		}
		if !defaultAssigned {
			for i, w := range visible {
				if w.plugin.WindowsFallbackDefault {
					out[i].Default = true
					break
				}
			}
		}
		return ListResult{
			OK:        true,
			Platform:  platform,
			HomeDir:   homeDir,
			Terminals: out,
		}
	}

	out := make([]TerminalView, 0, len(wraps))
	for _, w := range wraps {
		out = append(out, w.view)
	}
	return ListResult{
		OK:        true,
		Platform:  platform,
		HomeDir:   homeDir,
		Terminals: out,
	}
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
