package sshhost

import (
	"context"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// DefaultProbeTimeout 对应 Node 的 DEFAULT_TIMEOUT_MS。
const DefaultProbeTimeout = 12 * time.Second

// Target 是探测目标。
type Target struct {
	Label string
	Host  string
	User  string
	Port  int
}

// ProcessResult 是一次子进程执行结果。
type ProcessResult struct {
	Status   int
	Signal   string
	Stdout   string
	Stderr   string
	TimedOut bool
}

// Runner 执行一条外部命令；测试用 fake 实现，避免真连 SSH。
type Runner func(ctx context.Context, name string, args []string, timeout time.Duration) ProcessResult

// ProbeOptions 是探测参数。
type ProbeOptions struct {
	Timeout         time.Duration
	SSHIdentityFile string
	Runner          Runner
}

// ProbeResult 是 SSH 开发机连通性诊断结果（字段与 WebUI 返回体对齐）。
type ProbeResult struct {
	Kind             string
	Target           string
	Host             string
	User             string
	Port             int
	Status           string
	Platform         string
	Arch             string
	Commands         map[string]bool
	RepoChecked      bool
	RepoPresent      *bool
	RepoPath         string
	Stderr           string
	TimedOut         bool
	Recommendation   string
	BootstrapTarget  string
	BootstrapCommand string
}

// BuildRemoteProbeCommand 是 POSIX 探测脚本：平台、架构与常用命令是否在 PATH 里。
func BuildRemoteProbeCommand() string {
	return strings.Join([]string{
		`printf "platform=%s\\n" "$(uname -s 2>/dev/null || echo unknown)"`,
		`printf "arch=%s\\n" "$(uname -m 2>/dev/null || echo unknown)"`,
		`for c in node npm git aih; do if command -v "$c" >/dev/null 2>&1; then printf "%s=present\\n" "$c"; else printf "%s=missing\\n" "$c"; fi; done`,
	}, "; ")
}

// BuildWindowsRemoteProbeCommand 是 PowerShell 探测脚本的 -EncodedCommand 形式。
func BuildWindowsRemoteProbeCommand() string {
	script := "$ErrorActionPreference = 'SilentlyContinue'\n" +
		"Write-Output 'platform=Windows'\n" +
		"Write-Output ('arch=' + [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE'))\n" +
		"foreach ($CommandName in @('node', 'npm', 'git', 'aih')) {\n" +
		"  if (Get-Command $CommandName -ErrorAction SilentlyContinue) {\n" +
		"    Write-Output ($CommandName + '=present')\n" +
		"  } else {\n" +
		"    Write-Output ($CommandName + '=missing')\n" +
		"  }\n" +
		"}\n"
	return "powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand " + UTF16LEBase64(script)
}

// BuildSSHArgs 构造 ssh 批处理探测命令行；超时向上取整到秒，至少 1 秒。
func BuildSSHArgs(target Target, options ProbeOptions) []string {
	return buildSSHArgs(target, options, BuildRemoteProbeCommand())
}

// buildSSHArgs 用指定远端命令构造 ssh 参数。
func buildSSHArgs(target Target, options ProbeOptions, remoteCommand string) []string {
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = DefaultProbeTimeout
	}
	timeoutSeconds := int((timeout + time.Second - 1) / time.Second)
	if timeoutSeconds < 1 {
		timeoutSeconds = 1
	}
	args := []string{
		"-o", "BatchMode=yes",
		"-o", "ConnectTimeout=" + strconv.Itoa(timeoutSeconds),
		"-o", "StrictHostKeyChecking=accept-new",
	}
	identityFile := strings.TrimSpace(options.SSHIdentityFile)
	if identityFile != "" {
		args = append(args, "-i", identityFile)
	}
	if target.Port != 0 {
		args = append(args, "-p", strconv.Itoa(target.Port))
	}
	destination := target.Host
	if strings.TrimSpace(target.User) != "" {
		destination = target.User + "@" + target.Host
	}
	args = append(args, destination, remoteCommand)
	return args
}

// DetectAuthRequired 判断失败是否属于「SSH 通了但认证没过」。
func DetectAuthRequired(result ProcessResult) bool {
	if result.TimedOut {
		return false
	}
	stderr := strings.ToLower(strings.TrimSpace(result.Stderr))
	return strings.Contains(stderr, "permission denied") &&
		(strings.Contains(stderr, "password") ||
			strings.Contains(stderr, "keyboard-interactive") ||
			strings.Contains(stderr, "publickey"))
}

// ParseFacts 解析 key=value 行；空键与无等号的行忽略。
func ParseFacts(stdout string) map[string]string {
	facts := make(map[string]string)
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSuffix(line, "\r")
		index := strings.Index(line, "=")
		if index <= 0 {
			continue
		}
		facts[line[:index]] = line[index+1:]
	}
	return facts
}

// RecommendationFor 按状态与事实给出中文建议。
func RecommendationFor(status string, facts map[string]string) string {
	switch status {
	case "auth-required":
		return "SSH 可达，但需要认证；请检查私钥、agent 或密码。"
	case "unreachable":
		return "SSH 不可达；请检查主机地址、端口和防火墙。"
	}
	missing := make([]string, 0, 4)
	for _, name := range []string{"node", "npm", "git", "aih"} {
		if facts[name] != "present" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return "SSH 正常；远端缺少 " + strings.Join(missing, " / ") + "，部分功能可能不可用。"
	}
	return "SSH 连接正常。"
}

// ProbeSSHTarget 探测一台 SSH 开发机。
//
// 先跑 POSIX 脚本；非超时失败时再试 Windows PowerShell（远端默认 shell 是 cmd 或
// PowerShell 时 POSIX 脚本会失败），最后按退出码与 stderr 归类。
func ProbeSSHTarget(ctx context.Context, target Target, options ProbeOptions) ProbeResult {
	runner := options.Runner
	if runner == nil {
		runner = DefaultRunner
	}
	result := runner(ctx, "ssh", BuildSSHArgs(target, options), probeTimeout(options))
	facts := ParseFacts(result.Stdout)
	if result.Status != 0 && !result.TimedOut {
		windowsResult := runner(ctx, "ssh", buildSSHArgs(target, options, BuildWindowsRemoteProbeCommand()), probeTimeout(options))
		windowsFacts := ParseFacts(windowsResult.Stdout)
		if windowsResult.Status == 0 || windowsFacts["platform"] != "" {
			result = windowsResult
			facts = windowsFacts
		}
	}
	status := "unreachable"
	switch {
	case result.Status == 0:
		status = "reachable"
	case DetectAuthRequired(result):
		status = "auth-required"
	}
	port := target.Port
	if port == 0 {
		port = 22
	}
	label := target.Label
	if label == "" && target.User != "" {
		label = target.User + "@" + target.Host
	}
	if label == "" {
		label = target.Host
	}
	present := func(name string) bool { return facts[name] == "present" }
	return ProbeResult{
		Kind:     "ssh",
		Target:   label,
		Host:     target.Host,
		User:     target.User,
		Port:     port,
		Status:   status,
		Platform: strings.TrimSpace(facts["platform"]),
		Arch:     strings.TrimSpace(facts["arch"]),
		Commands: map[string]bool{
			"node": present("node"),
			"npm":  present("npm"),
			"git":  present("git"),
			"aih":  present("aih"),
		},
		RepoChecked:      false,
		RepoPresent:      nil,
		RepoPath:         "",
		Stderr:           truncateRunes(strings.TrimSpace(result.Stderr), 1000),
		TimedOut:         result.TimedOut,
		Recommendation:   RecommendationFor(status, facts),
		BootstrapTarget:  "",
		BootstrapCommand: "",
	}
}

// DefaultRunner 用 os/exec 执行命令；超时杀掉进程并返回 124。
func DefaultRunner(ctx context.Context, name string, args []string, timeout time.Duration) ProcessResult {
	if timeout <= 0 {
		timeout = DefaultProbeTimeout
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	command := exec.CommandContext(runCtx, name, args...)
	output := &strings.Builder{}
	errors := &strings.Builder{}
	command.Stdout = output
	command.Stderr = errors
	err := command.Run()
	result := ProcessResult{Stdout: output.String(), Stderr: errors.String()}
	if runCtx.Err() == context.DeadlineExceeded {
		result.Status = 124
		result.TimedOut = true
		return result
	}
	if err == nil {
		return result
	}
	if exitError, ok := err.(*exec.ExitError); ok {
		result.Status = exitError.ExitCode()
		if exitError.ExitCode() < 0 {
			result.Status = 1
		}
		return result
	}
	result.Status = 1
	if result.Stderr == "" {
		result.Stderr = fmt.Sprintf("%v", err)
	}
	return result
}

func probeTimeout(options ProbeOptions) time.Duration {
	if options.Timeout > 0 {
		return options.Timeout
	}
	return DefaultProbeTimeout
}
