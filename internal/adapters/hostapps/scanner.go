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
	return instances, nil
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
