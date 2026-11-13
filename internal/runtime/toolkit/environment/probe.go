package environment

import (
	"context"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// ProbeResult 是单个工具的探测结果（字段与 Node probeEnvironmentTool 一致）。
type ProbeResult struct {
	Installed       bool     `json:"installed"`
	Version         string   `json:"version"`
	ExecutablePath  string   `json:"executablePath"`
	ManagedVersions []string `json:"managedVersions"`
}

// ProbeContext 交给工具自带的版本枚举函数（rustup / goenv）。
type ProbeContext struct {
	Host Host
}

var (
	// semverPattern 与 rust.js 的 SEMVER_PATTERN 一致。
	semverPattern = regexp.MustCompile(`(\d+\.\d+\.\d+[\w.-]*)`)
	// goVersionPattern 与 go.js 的 parseGoVersion 一致：go version go1.22.1 darwin/arm64。
	goVersionPattern = regexp.MustCompile(`\bgo(\d+\.\d+(?:\.\d+)?[\w.-]*)`)
	// gitVersionPattern 与 git.js 的 parseGitVersion 一致：git version 2.39.3 (Apple Git-145)。
	gitVersionPattern = regexp.MustCompile(`git version (\d+\.\d+(?:\.\d+)?)`)
	// rustupToolchainSuffix 去掉 rustup toolchain list 的 (default) / (active) 标注。
	rustupToolchainSuffix = regexp.MustCompile(`\s*\((?:default|active|override)[^)]*\)\s*`)
)

// FirstLine 取第一段非空行（Node firstLine）。
func FirstLine(value string) string {
	for _, line := range strings.Split(value, "\n") {
		trimmed := strings.TrimSpace(strings.TrimSuffix(line, "\r"))
		if trimmed != "" {
			return trimmed
		}
	}
	return ""
}

func parseSemver(output string) string {
	if match := semverPattern.FindStringSubmatch(output); match != nil {
		return match[1]
	}
	return FirstLine(output)
}

func parseGoVersion(output string) string {
	if match := goVersionPattern.FindStringSubmatch(output); match != nil {
		return match[1]
	}
	return FirstLine(output)
}

func parseGitVersion(output string) string {
	if match := gitVersionPattern.FindStringSubmatch(output); match != nil {
		return match[1]
	}
	return FirstLine(output)
}

// ParseVersion 按工具声明解析版本；未声明时取第一行。
func ParseVersion(spec ToolSpec, output string) string {
	if spec.ParseVersion != nil {
		return strings.TrimSpace(spec.ParseVersion(output))
	}
	return FirstLine(output)
}

func listRustupToolchains(ctx ProbeContext) []string {
	result := execProbe(context.Background(), ctx.Host, "rustup", []string{"toolchain", "list"})
	if !result.OK {
		return nil
	}
	lines := strings.Split(strings.ReplaceAll(result.Stdout, "\r\n", "\n"), "\n")
	versions := make([]string, 0, len(lines))
	for _, line := range lines {
		cleaned := strings.TrimSpace(rustupToolchainSuffix.ReplaceAllString(line, " "))
		if cleaned != "" {
			versions = append(versions, cleaned)
		}
	}
	return versions
}

func listGoenvVersions(ctx ProbeContext) []string {
	if ctx.Host.HomeDir == "" {
		return nil
	}
	return ListDirectories(ctx.Host, JoinPath(ctx.Host.Platform, ctx.Host.HomeDir, ".goenv", "versions"))
}

// ListDirectories 枚举目录下的子目录名（跳过隐藏目录），按版本号从新到旧排序。
//
// Node 用 localeCompare(..., {numeric:true}) 降序：v9 排在 v10 后面。Go 的字典序
// 会把 v9 排到 v10 前面，所以这里按数字段比较。
func ListDirectories(host Host, directory string) []string {
	if directory == "" || host.ReadDir == nil {
		return nil
	}
	names, err := host.ReadDir(directory)
	if err != nil {
		return nil
	}
	result := make([]string, 0, len(names))
	for _, name := range names {
		if name == "" || strings.HasPrefix(name, ".") {
			continue
		}
		result = append(result, name)
	}
	sort.SliceStable(result, func(left, right int) bool {
		return compareNatural(result[left], result[right]) > 0
	})
	return result
}

// compareNatural 按数字段比较版本串（v9.0.0 < v10.0.0）。
func compareNatural(left, right string) int {
	leftIndex, rightIndex := 0, 0
	for leftIndex < len(left) && rightIndex < len(right) {
		leftDigit := isDigit(left[leftIndex])
		rightDigit := isDigit(right[rightIndex])
		if leftDigit && rightDigit {
			leftStart, rightStart := leftIndex, rightIndex
			for leftIndex < len(left) && isDigit(left[leftIndex]) {
				leftIndex++
			}
			for rightIndex < len(right) && isDigit(right[rightIndex]) {
				rightIndex++
			}
			leftValue, _ := strconv.ParseUint(left[leftStart:leftIndex], 10, 64)
			rightValue, _ := strconv.ParseUint(right[rightStart:rightIndex], 10, 64)
			if leftValue != rightValue {
				if leftValue > rightValue {
					return 1
				}
				return -1
			}
			continue
		}
		leftChar := strings.ToLower(string(left[leftIndex]))
		rightChar := strings.ToLower(string(right[rightIndex]))
		if leftChar != rightChar {
			if leftChar > rightChar {
				return 1
			}
			return -1
		}
		leftIndex++
		rightIndex++
	}
	switch {
	case leftIndex < len(left):
		return 1
	case rightIndex < len(right):
		return -1
	}
	return 0
}

func isDigit(value byte) bool { return value >= '0' && value <= '9' }

// fileExists 是 Node probe.js fileExists 的等价实现。
func fileExists(host Host, target string) bool {
	if target == "" || host.Exists == nil {
		return false
	}
	return host.Exists(target)
}

func hostHome(host Host) string { return strings.TrimSpace(host.HomeDir) }

func homePath(host Host, parts ...string) string {
	home := hostHome(host)
	if home == "" {
		return ""
	}
	return JoinPath(host.Platform, append([]string{home}, parts...)...)
}

// resolveExecutablePath 复刻 Node：POSIX 用 which、Windows 用 where.exe，取第一行。
func resolveExecutablePath(ctx context.Context, host Host, command string) string {
	resolver := "which"
	if normalizePlatform(host.Platform) == PlatformWindows {
		resolver = "where.exe"
	}
	return FirstLine(probeValue(execProbe(ctx, host, resolver, []string{command})))
}

// resolveKnownPath 在插件声明的已知安装位置里找第一个存在的路径。
//
// 服务进程（launchd / systemd）的 PATH 往往不含用户级目录，安装成功后仍需
// 靠这里确认，否则状态校验会把成功判成失败。
func resolveKnownPath(host Host, knownPaths []string) string {
	windows := normalizePlatform(host.Platform) == PlatformWindows
	for _, raw := range knownPaths {
		value := strings.TrimSpace(raw)
		if value == "" {
			continue
		}
		base := value
		if !IsAbsPath(host.Platform, value) {
			base = homePath(host, value)
		}
		if base == "" {
			continue
		}
		candidates := []string{base}
		if windows && !strings.HasSuffix(strings.ToLower(base), ".exe") {
			candidates = []string{base + ".exe", base}
		}
		for _, candidate := range candidates {
			if fileExists(host, candidate) {
				return candidate
			}
		}
	}
	return ""
}

// probeCommand 先按 PATH 执行命令，失败再按已知安装位置兜底执行。
func probeCommand(ctx context.Context, host Host, command string, args []string, knownPaths []string) (RunResult, string) {
	fromPath := execProbe(ctx, host, command, args)
	if fromPath.OK {
		return fromPath, resolveExecutablePath(ctx, host, command)
	}
	knownPath := resolveKnownPath(host, knownPaths)
	if knownPath == "" {
		return fromPath, ""
	}
	fromKnown := execProbe(ctx, host, knownPath, args)
	if fromKnown.OK {
		return fromKnown, knownPath
	}
	return fromKnown, ""
}

// probeNVM：nvm 不是可执行命令，只认 ~/.nvm 目录与 versions/node 下的版本目录。
func probeNVM(host Host) ProbeResult {
	root := homePath(host, ".nvm")
	versions := ListDirectories(host, JoinPath(host.Platform, root, "versions", "node"))
	result := ProbeResult{Installed: fileExists(host, root), ExecutablePath: root, ManagedVersions: versions}
	if len(versions) > 0 {
		result.Version = countLabel(len(versions), "个 Node.js 版本")
	}
	return result
}

// probePyenv：命令探测成功即可用；命令缺失时 ~/.pyenv 存在也算已安装。
func probePyenv(ctx context.Context, host Host) ProbeResult {
	root := homePath(host, ".pyenv")
	versions := ListDirectories(host, JoinPath(host.Platform, root, "versions"))
	command := execProbe(ctx, host, "pyenv", []string{"--version"})
	executable := resolveExecutablePath(ctx, host, "pyenv")
	result := ProbeResult{
		Installed:       command.OK || fileExists(host, root),
		ManagedVersions: versions,
	}
	if value := probeValue(command); value != "" {
		result.Version = value
	} else if len(versions) > 0 {
		result.Version = countLabel(len(versions), "个 Python 版本")
	}
	if executable != "" {
		result.ExecutablePath = executable
	} else {
		result.ExecutablePath = root
	}
	return result
}

// probeConda：命令探测成功即可用；命令缺失时 ~/miniconda3、~/anaconda3 存在也算已安装。
func probeConda(ctx context.Context, host Host) ProbeResult {
	home := hostHome(host)
	command := execProbe(ctx, host, "conda", []string{"--version"})
	root := ""
	for _, candidate := range []string{
		JoinPath(host.Platform, home, "miniconda3"),
		JoinPath(host.Platform, home, "anaconda3"),
	} {
		if fileExists(host, candidate) {
			root = candidate
			break
		}
	}
	envRoots := make([]string, 0, 2)
	if root != "" {
		envRoots = append(envRoots, JoinPath(host.Platform, root, "envs"))
	}
	envRoots = append(envRoots, JoinPath(host.Platform, home, ".conda", "envs"))
	seen := map[string]struct{}{}
	versions := make([]string, 0)
	for _, directory := range envRoots {
		for _, name := range ListDirectories(host, directory) {
			if _, exists := seen[name]; exists {
				continue
			}
			seen[name] = struct{}{}
			versions = append(versions, name)
		}
	}
	// Node 用 Set 去重后再排序；这里保持目录枚举顺序（ListDirectories 已排序）。
	result := ProbeResult{
		Installed:       command.OK || root != "",
		ManagedVersions: versions,
	}
	if value := probeValue(command); value != "" {
		result.Version = value
	} else if root != "" {
		result.Version = "已安装"
	}
	if executable := resolveExecutablePath(ctx, host, "conda"); executable != "" {
		result.ExecutablePath = executable
	} else {
		result.ExecutablePath = root
	}
	return result
}

// Probe 探测一个工具的安装状态。
func Probe(ctx context.Context, spec ToolSpec, host Host) ProbeResult {
	switch spec.ProbeKind {
	case ProbeKindNVM:
		return probeNVM(host)
	case ProbeKindPyenv:
		return probePyenv(ctx, host)
	case ProbeKindConda:
		return probeConda(ctx, host)
	}
	command := strings.TrimSpace(spec.Command)
	if command == "" {
		return ProbeResult{}
	}
	args := spec.Args
	if len(args) == 0 {
		args = []string{"--version"}
	}
	result, executable := probeCommand(ctx, host, command, args, spec.KnownPaths)
	if !result.OK {
		return ProbeResult{}
	}
	managed := []string{}
	if spec.ListVersions != nil {
		for _, name := range spec.ListVersions(ProbeContext{Host: host}) {
			if strings.TrimSpace(name) != "" {
				managed = append(managed, name)
			}
		}
	}
	return ProbeResult{
		Installed:       true,
		Version:         ParseVersion(spec, probeValue(result)),
		ExecutablePath:  executable,
		ManagedVersions: managed,
	}
}

func countLabel(count int, unit string) string {
	return strconv.Itoa(count) + " " + unit
}

// RuntimeView 是运行时本体（Node detect*Environment）的探测结果。
type RuntimeView struct {
	ID                    string         `json:"id"`
	Name                  string         `json:"name"`
	Installed             bool           `json:"installed"`
	CurrentVersion        string         `json:"currentVersion"`
	ActivePath            string         `json:"activePath"`
	PackageManagerVersion string         `json:"packageManagerVersion"`
	PackageManagers       map[string]any `json:"packageManagers,omitempty"`
	Scope                 string         `json:"scope"`
	Source                string         `json:"source"`
	ProbeStatus           string         `json:"probeStatus"`
}

// probeStatus 对齐 Node：成功 available；没拿到退出码 error；其余 unavailable。
func probeStatus(result RunResult) string {
	if result.OK {
		return "available"
	}
	if result.ExitCode == nil {
		return "error"
	}
	return "unavailable"
}

// DetectNodeRuntime 复刻 Node detectNodeEnvironment：node + npm。
func DetectNodeRuntime(ctx context.Context, host Host) RuntimeView {
	versionProbe := execProbe(ctx, host, "node", []string{"--version"})
	npmProbe := execProbe(ctx, host, "npm", []string{"--version"})
	packageManagerVersion := FirstLine(probeValue(npmProbe))
	view := RuntimeView{
		ID: "node", Name: "Node.js",
		Installed:             versionProbe.OK,
		CurrentVersion:        FirstLine(probeValue(versionProbe)),
		PackageManagerVersion: packageManagerVersion,
		PackageManagers:       map[string]any{"npm": nil},
		Scope:                 "aih-server-process-path",
		Source:                "command-probe",
		ProbeStatus:           probeStatus(versionProbe),
	}
	if packageManagerVersion != "" {
		view.PackageManagers["npm"] = packageManagerVersion
	}
	if versionProbe.OK {
		view.ActivePath = resolveExecutablePath(ctx, host, "node")
	}
	return view
}

// DetectPythonRuntime 复刻 Node detectPythonEnvironment：python3 → python，pip3 → pip。
func DetectPythonRuntime(ctx context.Context, host Host) RuntimeView {
	python3 := execProbe(ctx, host, "python3", []string{"--version"})
	python := python3
	command := "python3"
	if !python3.OK {
		python = execProbe(ctx, host, "python", []string{"--version"})
		command = "python"
	}
	pip3 := execProbe(ctx, host, "pip3", []string{"--version"})
	pip := pip3
	if !pip3.OK {
		pip = execProbe(ctx, host, "pip", []string{"--version"})
	}
	firstPip := FirstLine(probeValue(pip))
	fields := strings.Fields(firstPip)
	managerVersion := firstPip
	if len(fields) > 1 {
		managerVersion = fields[1]
	}
	view := RuntimeView{
		ID: "python", Name: "Python",
		Installed:             python.OK,
		CurrentVersion:        FirstLine(probeValue(python)),
		PackageManagerVersion: managerVersion,
		Scope:                 "aih-server-process-path",
		Source:                "command-probe",
		ProbeStatus:           probeStatus(python),
	}
	if python.OK {
		view.ActivePath = resolveExecutablePath(ctx, host, command)
	}
	return view
}

// runtimeSpec 是 detectCommandRuntime 的输入。
type runtimeSpec struct {
	ID             string
	Name           string
	Command        string
	Args           []string
	KnownPaths     []string
	ParseVersion   func(string) string
	PackageCommand string
	PackageArgs    []string
	PackagePaths   []string
	PackageParse   func(string) string
}

// detectCommandRuntime 复刻 Node detectCommandRuntime。
func detectCommandRuntime(ctx context.Context, host Host, spec runtimeSpec) RuntimeView {
	runtimeResult, _ := probeCommand(ctx, host, spec.Command, spec.Args, spec.KnownPaths)
	managerResult := RunResult{}
	managerPath := ""
	if spec.PackageCommand != "" {
		managerResult, managerPath = probeCommand(ctx, host, spec.PackageCommand, spec.PackageArgs, spec.PackagePaths)
	}
	parse := spec.ParseVersion
	if parse == nil {
		parse = FirstLine
	}
	view := RuntimeView{
		ID: spec.ID, Name: spec.Name,
		Installed:      runtimeResult.OK,
		Scope:          "aih-server-process-path",
		Source:         "command-probe",
		ProbeStatus:    probeStatus(runtimeResult),
		CurrentVersion: "",
	}
	if runtimeResult.OK {
		view.CurrentVersion = parse(probeValue(runtimeResult))
		view.ActivePath = resolveExecutablePath(ctx, host, spec.Command)
	}
	if managerResult.OK {
		managerParse := spec.PackageParse
		if managerParse == nil {
			managerParse = FirstLine
		}
		view.PackageManagerVersion = managerParse(probeValue(managerResult))
		_ = managerPath
	}
	return view
}

// DetectRuntimes 探测五个运行时本体（顺序与 Node 插件注册顺序一致）。
func DetectRuntimes(ctx context.Context, host Host) map[string]RuntimeView {
	result := map[string]RuntimeView{}
	result["node"] = DetectNodeRuntime(ctx, host)
	result["python"] = DetectPythonRuntime(ctx, host)
	result["rust"] = detectCommandRuntime(ctx, host, runtimeSpec{
		ID: "rust", Name: "Rust", Command: "rustc", Args: []string{"--version"},
		KnownPaths:     []string{".cargo/bin/rustc"},
		ParseVersion:   parseSemver,
		PackageCommand: "cargo", PackageArgs: []string{"--version"},
		PackagePaths: []string{".cargo/bin/cargo"},
		PackageParse: parseSemver,
	})
	result["go"] = detectCommandRuntime(ctx, host, runtimeSpec{
		ID: "go", Name: "Go", Command: "go", Args: []string{"version"},
		KnownPaths:   []string{".local/go/bin/go", "/usr/local/go/bin/go", "C:\\Program Files\\Go\\bin\\go.exe"},
		ParseVersion: parseGoVersion,
	})
	result["git"] = detectCommandRuntime(ctx, host, runtimeSpec{
		ID: "git", Name: "Git", Command: "git", Args: []string{"--version"},
		KnownPaths:   []string{"/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git", "C:\\Program Files\\Git\\cmd\\git.exe"},
		ParseVersion: parseGitVersion,
	})
	return result
}
