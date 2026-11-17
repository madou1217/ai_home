// Package hostapps 提供宿主机「账号桌面实例 / CLI 实例」的进程事实。
//
// 与 Node lib/server/account-app-launcher.js 的 listRunningDesktopInstances /
// listRunningCliInstances 同口径：
//   - 桌面实例身份有两种：Electron 的 --user-data-dir，或改写进程标题的
//     provider 应用名（zcode / kiro）；macOS 上部分应用只把 user-data 放在
//     环境变量里，需要用 ps eww 反读。
//   - CLI 实例靠启动时写入的 AIH_ACCOUNT_APP=1 / AIH_PROVIDER_ACCOUNT_REF
//     标记识别，并沿父子关系收集同一 PTY 下的子进程。
//
// 本包只读进程事实：不启动、不结束进程，也不判断账号是否可用。
package hostapps

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

const (
	// PlatformMacOS / Windows / Linux 与 Go 的 GOOS 取值一致，调用方直接传 runtime.GOOS。
	PlatformMacOS   = "darwin"
	PlatformWindows = "windows"
	PlatformLinux   = "linux"

	// AccountAppMarkerEnv / ProviderAccountRefEnv 与 Node 的进程标记同名。
	AccountAppMarkerEnv   = "AIH_ACCOUNT_APP"
	ProviderAccountRefEnv = "AIH_PROVIDER_ACCOUNT_REF"
)

// ErrScannerUnavailable 表示当前平台没有可用的进程列举方式。
var ErrScannerUnavailable = errors.New("hostapps: 进程列举不可用")

// CommandRunner 执行一条宿主命令并返回 stdout；测试可注入假实现。
type CommandRunner func(ctx context.Context, name string, args ...string) ([]byte, error)

// Process 是一条进程事实。
type Process struct {
	PID         int
	PPID        int
	Name        string
	CommandLine string
	// UserDataDir 只在 macOS 环境变量反读时填写。
	UserDataDir string
}

// DesktopInstance 是一个带账号身份的桌面主进程。
type DesktopInstance struct {
	PID             int
	UserDataDir     string
	ApplicationName string
}

// CLIInstance 是一个 aih CLI 进程（含同一根进程下的子进程）。
type CLIInstance struct {
	PID          int
	PPID         int
	Provider     string
	CLIAccountID string
	AccountRef   string
	RootPID      int
	// NativeOwned marks a Go native lifecycle process or a family containing one.
	// Legacy process-tree shutdown must never signal these rows or descendants.
	NativeOwned bool
}

// EnvRule 描述「从进程环境变量反读 user-data 目录」的 provider 规则。
type EnvRule struct {
	EnvKey       string
	PathIncludes []string
}

// Scanner 是宿主进程扫描器。
type Scanner struct {
	Platform string
	// Run 为空时使用 exec.CommandContext。
	Run CommandRunner
	// EnvRules 是 macOS 上按可执行文件路径反读 user-data 的规则（来自 Provider 合同）。
	EnvRules []EnvRule
}

// NewScanner 创建扫描器；platform 传 runtime.GOOS。
func NewScanner(platform string) *Scanner {
	return &Scanner{Platform: strings.ToLower(strings.TrimSpace(platform))}
}

func (scanner *Scanner) run(ctx context.Context, name string, args ...string) ([]byte, error) {
	runner := scanner.Run
	if runner == nil {
		runner = func(ctx context.Context, name string, args ...string) ([]byte, error) {
			output, err := exec.CommandContext(ctx, name, args...).Output()
			if err == nil {
				return output, nil
			}
			var exitError *exec.ExitError
			if errors.As(err, &exitError) {
				return output, fmt.Errorf("hostapps: %s 退出码 %d: %w", name, exitError.ExitCode(), err)
			}
			return output, err
		}
	}
	return runner(ctx, name, args...)
}

// ListDesktopInstances 一次扫描列出所有带账号身份的桌面主进程。
//
// 扫描失败返回空切片与错误：调用方（入口探测）把它当作「当前没有运行中的账号」，
// 与 Node 的降级口径一致。
func (scanner *Scanner) ListDesktopInstances(ctx context.Context) ([]DesktopInstance, error) {
	if scanner == nil {
		return nil, ErrScannerUnavailable
	}
	var processes []Process
	var err error
	switch scanner.Platform {
	case PlatformWindows:
		processes, err = scanner.listWindowsProcesses(ctx, false)
	case PlatformMacOS, PlatformLinux:
		processes, err = scanner.listPosixProcesses(ctx, false)
	default:
		return nil, ErrScannerUnavailable
	}
	if err != nil {
		return nil, err
	}
	processes = filterDesktopMainProcesses(processes)
	if scanner.Platform == PlatformMacOS {
		processes = scanner.withMacUserDataDirs(ctx, processes)
	}
	return desktopInstances(processes), nil
}

func desktopInstances(processes []Process) []DesktopInstance {
	instances := make([]DesktopInstance, 0, len(processes))
	for _, process := range processes {
		userDataDir := parseUserDataDir(process.CommandLine)
		if userDataDir == "" {
			userDataDir = process.UserDataDir
		}
		applicationName := parseApplicationName(process.CommandLine)
		if userDataDir == "" && applicationName == "" {
			continue
		}
		instances = append(instances, DesktopInstance{
			PID:             process.PID,
			UserDataDir:     userDataDir,
			ApplicationName: applicationName,
		})
	}
	return instances
}

// ListCLIInstances 一次扫描列出所有带 aih 启动标记的 CLI 进程树节点。
func (scanner *Scanner) ListCLIInstances(ctx context.Context) ([]CLIInstance, error) {
	if scanner == nil {
		return nil, ErrScannerUnavailable
	}
	var processes []Process
	var err error
	switch scanner.Platform {
	case PlatformWindows:
		processes, err = scanner.listWindowsProcesses(ctx, true)
	case PlatformMacOS, PlatformLinux:
		processes, err = scanner.listPosixProcesses(ctx, true)
	default:
		return nil, ErrScannerUnavailable
	}
	if err != nil {
		return nil, err
	}
	return buildCLIInstances(processes), nil
}

// ListDesktopInstancesStrict is the deletion-only scan. Unlike the display path,
// an unreadable process table or macOS environment is not an empty result.
func (scanner *Scanner) ListDesktopInstancesStrict(ctx context.Context) ([]DesktopInstance, error) {
	processes, err := scanner.listProcessesStrict(ctx, false)
	if err != nil {
		return nil, err
	}
	processes = filterDesktopMainProcesses(processes)
	if scanner.Platform == PlatformMacOS {
		processes, err = scanner.withMacUserDataDirsStrict(ctx, processes)
		if err != nil {
			return nil, err
		}
	}
	return desktopInstances(processes), nil
}

// ListCLIInstancesStrict preserves NativeOwned and reads the untruncated POSIX
// environment carrying AIH_ACCOUNT_APP. It never terminates any process.
func (scanner *Scanner) ListCLIInstancesStrict(ctx context.Context) ([]CLIInstance, error) {
	processes, err := scanner.listProcessesStrict(ctx, true)
	if err != nil {
		return nil, err
	}
	return strictCLIInstances(processes, scanner.Platform)
}

func (scanner *Scanner) listProcessesStrict(ctx context.Context, withParent bool) ([]Process, error) {
	if scanner == nil || ctx == nil {
		return nil, ErrScannerUnavailable
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	switch scanner.Platform {
	case PlatformMacOS, PlatformLinux:
		// Only this user's processes can own this user's private projections.
		// Other users' unavailable environments must not block all deletions.
		uid := os.Getuid()
		if uid < 0 {
			return nil, ErrScannerUnavailable
		}
		args := []string{"-ww", "-U", strconv.Itoa(uid), "-o", "pid=,command="}
		if withParent {
			args = []string{"eww", "-U", strconv.Itoa(uid), "-o", "pid=,ppid=,command="}
		}
		output, err := scanner.run(ctx, "ps", args...)
		if err != nil {
			return nil, fmt.Errorf("%w: %w", ErrScannerUnavailable, err)
		}
		return parsePosixProcessesStrict(string(output), withParent)
	case PlatformWindows:
		fields := "ProcessId,Name,CommandLine"
		if withParent {
			fields = "ProcessId,ParentProcessId,Name,CommandLine"
		}
		script := "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process | Select-Object " + fields + ") | ConvertTo-Json -Compress"
		output, err := scanner.run(ctx, "powershell.exe", "-NoProfile", "-Command", script)
		if err != nil {
			return nil, fmt.Errorf("%w: %w", ErrScannerUnavailable, err)
		}
		processes, err := parseWindowsProcesses(output)
		if err != nil {
			return nil, err
		}
		if len(processes) == 0 {
			return nil, ErrScannerUnavailable
		}
		for _, process := range processes {
			// Protected OS services (smss/csrss/etc.) have no readable argv and
			// cannot hold an account projection. Provider executables and their
			// interpreters remain fail-closed when their identity is unreadable.
			if process.CommandLine == "" && mayHoldAccountProjection(process.Name) {
				return nil, fmt.Errorf("%w: process identity unreadable (pid=%d)", ErrScannerUnavailable, process.PID)
			}
		}
		return processes, nil
	default:
		return nil, ErrScannerUnavailable
	}
}

// mayHoldAccountProjection is only a guard for unreadable Windows argv, not
// an allowlist for readable processes: every readable process is still scanned.
func mayHoldAccountProjection(name string) bool {
	name = strings.ToLower(executableBase(strings.TrimSpace(name)))
	for _, suffix := range []string{".exe", ".cmd", ".bat"} {
		name = strings.TrimSuffix(name, suffix)
	}
	if name == "" || parseApplicationName(name) != "" {
		return true
	}
	switch name {
	case "node", "nodejs", "bun", "deno", "electron", "python", "python3", "pythonw",
		"powershell", "pwsh", "cmd", "wscript", "cscript", "bash", "zsh", "sh":
		return true
	}
	for _, token := range []string{
		"aih", "ai-home", "agy", "antigravity", "codex", "chatgpt", "claude", "gemini", "grok",
		"kiro", "kimi", "zcode", "cline", "qoder", "qwen", "opencode", "language_server",
		"codebuddy", "workbuddy", "windsurf", "trae", "cursor",
	} {
		if strings.Contains(name, token) {
			return true
		}
	}
	return false
}

// POSIX columns are whitespace-aligned. SplitN(line, " ", 3) drops rows with
// padded PPIDs; a deletion scan must neither skip those rows nor truncate argv.
func parsePosixProcessesStrict(output string, withParent bool) ([]Process, error) {
	processes := make([]Process, 0)
	seen := make(map[int]bool)
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		pidText, command, ok := cutProcessColumn(line)
		pid, pidErr := strconv.Atoi(pidText)
		if !ok || pidErr != nil || pid <= 0 || seen[pid] {
			return nil, fmt.Errorf("%w: invalid process row", ErrScannerUnavailable)
		}
		ppid := 0
		if withParent {
			var parentText string
			parentText, command, ok = cutProcessColumn(command)
			var parentErr error
			ppid, parentErr = strconv.Atoi(parentText)
			if !ok || parentErr != nil || ppid < 0 {
				return nil, fmt.Errorf("%w: invalid process parent (pid=%d)", ErrScannerUnavailable, pid)
			}
		}
		if command == "" || strings.ContainsRune(command, '\x00') {
			return nil, fmt.Errorf("%w: empty process identity (pid=%d)", ErrScannerUnavailable, pid)
		}
		seen[pid] = true
		processes = append(processes, Process{PID: pid, PPID: ppid, CommandLine: command})
	}
	if len(processes) == 0 {
		return nil, ErrScannerUnavailable
	}
	return processes, nil
}

func cutProcessColumn(line string) (string, string, bool) {
	text := strings.TrimSpace(line)
	end := strings.IndexAny(text, " \t")
	if end < 0 {
		return "", "", false
	}
	return text[:end], strings.TrimSpace(text[end:]), true
}

func (scanner *Scanner) listPosixProcesses(ctx context.Context, withParent bool) ([]Process, error) {
	args := []string{"-ax", "-o", "pid=,command="}
	if withParent {
		args = []string{"-ax", "-o", "pid=,ppid=,command="}
	}
	output, err := scanner.run(ctx, "ps", args...)
	if err != nil {
		return nil, err
	}
	return parsePosixProcesses(string(output), withParent), nil
}

func (scanner *Scanner) listWindowsProcesses(ctx context.Context, withParent bool) ([]Process, error) {
	script := "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress"
	if withParent {
		script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress"
	}
	output, err := scanner.run(ctx, "powershell.exe", "-NoProfile", "-Command", script)
	if err != nil {
		return nil, err
	}
	return parseWindowsProcesses(output)
}

func parsePosixProcesses(output string, withParent bool) []Process {
	lines := strings.Split(output, "\n")
	processes := make([]Process, 0, len(lines))
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.SplitN(line, " ", 3)
		if withParent {
			if len(fields) < 3 {
				continue
			}
			pid, pidErr := strconv.Atoi(strings.TrimSpace(fields[0]))
			ppid, ppidErr := strconv.Atoi(strings.TrimSpace(fields[1]))
			commandLine := strings.TrimSpace(fields[2])
			if pidErr != nil || ppidErr != nil || pid <= 0 {
				continue
			}
			processes = append(processes, Process{PID: pid, PPID: ppid, CommandLine: commandLine})
			continue
		}
		if len(fields) < 2 {
			continue
		}
		pid, pidErr := strconv.Atoi(strings.TrimSpace(fields[0]))
		commandLine := strings.TrimSpace(strings.Join(fields[1:], " "))
		if pidErr != nil || pid <= 0 {
			continue
		}
		processes = append(processes, Process{PID: pid, CommandLine: commandLine})
	}
	return processes
}

type windowsProcess struct {
	ProcessID       int    `json:"ProcessId"`
	ParentProcessID int    `json:"ParentProcessId"`
	Name            string `json:"Name"`
	CommandLine     string `json:"CommandLine"`
}

func parseWindowsProcesses(output []byte) ([]Process, error) {
	trimmed := strings.TrimSpace(string(output))
	if trimmed == "" {
		return nil, nil
	}
	var items []windowsProcess
	if strings.HasPrefix(trimmed, "{") {
		var single windowsProcess
		if err := json.Unmarshal([]byte(trimmed), &single); err != nil {
			return nil, fmt.Errorf("hostapps: 解析 Windows 进程失败: %w", err)
		}
		items = []windowsProcess{single}
	} else if err := json.Unmarshal([]byte(trimmed), &items); err != nil {
		return nil, fmt.Errorf("hostapps: 解析 Windows 进程失败: %w", err)
	}
	processes := make([]Process, 0, len(items))
	for _, item := range items {
		if item.ProcessID <= 0 {
			continue
		}
		processes = append(processes, Process{
			PID:         item.ProcessID,
			PPID:        item.ParentProcessID,
			Name:        strings.TrimSpace(item.Name),
			CommandLine: strings.TrimSpace(item.CommandLine),
		})
	}
	return processes, nil
}

// filterDesktopMainProcesses 排除 --type= 的 renderer / utility 子进程。
func filterDesktopMainProcesses(processes []Process) []Process {
	filtered := make([]Process, 0, len(processes))
	for _, process := range processes {
		if strings.Contains(process.CommandLine, "--type=") {
			continue
		}
		filtered = append(filtered, process)
	}
	return filtered
}
