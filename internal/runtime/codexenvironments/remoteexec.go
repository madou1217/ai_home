package codexenvironments

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/sshremote"
)

// RemoteExecServerOptions 描述远端 exec-server 的期望形态。
type RemoteExecServerOptions struct {
	Connection Connection
	HomeDir    string
	// Port 是远端监听端口；0 表示用 DefaultRemoteExecServerPort。
	Port int
	// CodexPath 是远端 codex 可执行文件路径；空值用 "codex"。
	CodexPath string
	// Platform 为空时自动探测。
	Platform Platform
}

// DefaultRemoteExecServerPort 与 DefaultRemoteExecServerAddress 保持一致。
const DefaultRemoteExecServerPort = 7788

// remoteStartScript 在远端启动一个脱离 SSH 会话的 exec-server。
//
// 三条约束，都是实测踩出来的：
//   - 必须 setsid：否则进程随 SSH 会话退出而终止；
//   - 必须重定向 stdin/stdout：SSH 关闭管道时默认会让进程收到 SIGHUP；
//   - 用 pid 文件做幂等：已经有一个在跑就直接复用，避免端口占用。
func remoteStartScript(port int, codexPath string) string {
	bin := strings.TrimSpace(codexPath)
	if bin == "" {
		bin = "codex"
	}
	dir := "/tmp/aih-codex-exec-server"
	return strings.Join([]string{
		"set -e",
		"mkdir -p " + dir,
		"PIDFILE=" + dir + "/" + strconv.Itoa(port) + ".pid",
		"LOGFILE=" + dir + "/" + strconv.Itoa(port) + ".log",
		"if [ -f \"$PIDFILE\" ] && kill -0 \"$(cat $PIDFILE)\" 2>/dev/null; then echo ALREADY_RUNNING; exit 0; fi",
		"setsid nohup " + shellSingleQuote(bin) + " exec-server --listen " +
			shellSingleQuote("ws://127.0.0.1:"+strconv.Itoa(port)) +
			" >> \"$LOGFILE\" 2>&1 < /dev/null &",
		"echo $! > \"$PIDFILE\"",
		"sleep 1",
		"if kill -0 \"$(cat $PIDFILE)\" 2>/dev/null; then echo STARTED; else echo FAILED; tail -5 \"$LOGFILE\" 2>/dev/null; exit 1; fi",
	}, "\n")
}

// Platform 是远端平台的稳定标识。
type Platform string

const (
	PlatformPOSIX   Platform = "posix"
	PlatformWindows Platform = "windows"
)

// DetectPlatform 探测远端平台。
//
// 不能靠 ssh_connections 猜：它没有平台字段，而 Windows 上跑 POSIX 脚本会得到
// "Environment variable -e not defined" 这种无关报错，排查成本很高。
func DetectPlatform(ctx context.Context, connection Connection, homeDir string) Platform {
	if _, err := runRemote(ctx, connection, homeDir, "uname -s"); err == nil {
		return PlatformPOSIX
	}
	return PlatformWindows
}

// remoteStartWindowsScript 在 Windows 上启动脱离 SSH 会话的 exec-server。
//
// 实测结论（本条是最贵的一条）：
//   - Start-Process + -RedirectStandardOutput 起的进程会随 SSH 会话结束被终止，
//     SSH 一断开端口就没了；
//   - Win32_Process.Create（WMI）创建的进程不绑定调用方会话，SSH 断开后仍在监听。
//
// 因此这里用 WMI 创建，并把输出重定向写进命令行（WMI 不提供重定向参数）。
func remoteStartWindowsScript(port int, codexPath string) string {
	bin := strings.TrimSpace(codexPath)
	if bin == "" {
		bin = "codex"
	}
	listen := "ws://127.0.0.1:" + strconv.Itoa(port)
	portText := strconv.Itoa(port)
	ps := strings.Join([]string{
		"$ErrorActionPreference='Stop'",
		"$d=(Join-Path $env:TEMP 'aih-codex-exec-server')",
		"New-Item -ItemType Directory -Force -Path $d | Out-Null",
		"$pidFile=Join-Path $d '" + portText + ".pid'",
		"$logFile=Join-Path $d '" + portText + ".log'",
		// 幂等：已有进程在跑就直接复用。
		"if (Test-Path $pidFile) { $old=Get-Content $pidFile -ErrorAction SilentlyContinue; if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) { 'ALREADY_RUNNING'; exit 0 } }",
		// 重定向交给 PowerShell 的 Start-Process 参数做不到（WMI 没有该参数），
		// 也不能在字符串里嵌引号交给 cmd——这里改用 PowerShell 的调用运算符，
		// 由 cmd 自己解析重定向。
		"$line='cmd.exe /c " + escapePowerShellSingle(bin) + " exec-server --listen " + listen + " >> %TEMP%\\aih-codex-exec-server\\" + portText + ".log 2>&1'",
		"$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$line}",
		"if ($r.ReturnValue -ne 0) { 'FAILED'; Write-Output ('rc=' + $r.ReturnValue); exit 1 }",
		"$r.ProcessId | Set-Content $pidFile",
		"Start-Sleep -Seconds 3",
		"$ok=Get-NetTCPConnection -LocalPort " + portText + " -State Listen -ErrorAction SilentlyContinue",
		"if ($ok) { 'STARTED' } else { 'FAILED'; Get-Content $logFile -Tail 5 -ErrorAction SilentlyContinue; exit 1 }",
	}, "; ")
	return "powershell -NoProfile -ExecutionPolicy Bypass -Command " + powershellQuote(ps)
}

// remoteStopWindowsScript 停掉 Windows 上由我们启动的进程；幂等。
func remoteStopWindowsScript(port int) string {
	ps := strings.Join([]string{
		"$pidFile=Join-Path (Join-Path $env:TEMP 'aih-codex-exec-server') '" + strconv.Itoa(port) + ".pid'",
		"if (Test-Path $pidFile) { $p = Get-Content $pidFile -ErrorAction SilentlyContinue; if ($p) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }; Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }",
		"'STOPPED'",
	}, "; ")
	return "powershell -NoProfile -ExecutionPolicy Bypass -Command " + powershellQuote(ps)
}

// powershellQuote 把整段脚本包成单参数，避免 cmd 把分号当命令分隔符。
func powershellQuote(script string) string {
	return "\"" + strings.ReplaceAll(script, "\"", "`\"") + "\""
}

// escapePowerShellSingle 用于单引号字符串内部的路径。
func escapePowerShellSingle(value string) string {
	return strings.ReplaceAll(value, "'", "''")
}

// remoteStopScript 停掉由 remoteStartScript 启动的进程；幂等。
func remoteStopScript(port int) string {
	dir := "/tmp/aih-codex-exec-server"
	return strings.Join([]string{
		"PIDFILE=" + dir + "/" + strconv.Itoa(port) + ".pid",
		"if [ -f \"$PIDFILE\" ]; then",
		"  PID=$(cat \"$PIDFILE\")",
		"  kill \"$PID\" 2>/dev/null || true",
		"  sleep 1",
		"  kill -9 \"$PID\" 2>/dev/null || true",
		"  rm -f \"$PIDFILE\"",
		"fi",
		"echo STOPPED",
	}, "\n")
}

// shellSingleQuote 是 POSIX 单引号引用。
func shellSingleQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// runRemote 用 AIH 自己的 SSH 凭据在远端执行一条命令。
func runRemote(ctx context.Context, connection Connection, homeDir, script string) (string, error) {
	config, err := toSSHConfig(connection, homeDir)
	if err != nil {
		return "", err
	}
	client, err := sshremote.Dial(ctx, config, 0)
	if err != nil {
		return "", err
	}
	defer func() { _ = client.Close() }()
	result, err := client.Run(ctx, script, 8*1024)
	output := TrimOutput(string(result.Stdout))
	if err != nil {
		return output, err
	}
	if result.Code != 0 {
		return output, fmt.Errorf("远端命令失败（exit %d）：%s", result.Code, TrimOutput(string(result.Stderr)))
	}
	return output, nil
}

// EnsureRemoteExecServer 确保远端有 exec-server 在监听指定端口。
//
// 返回 true 表示本次新启动，false 表示已在运行（幂等）。
func EnsureRemoteExecServer(ctx context.Context, options RemoteExecServerOptions) (bool, error) {
	if strings.TrimSpace(options.Connection.ID) == "" {
		return false, errors.New("需要 SSH 连接 ID")
	}
	port := options.Port
	if port <= 0 {
		port = DefaultRemoteExecServerPort
	}
	platform := options.Platform
	if platform == "" {
		platform = DetectPlatform(ctx, options.Connection, options.HomeDir)
	}
	script := remoteStartScript(port, options.CodexPath)
	if platform == PlatformWindows {
		script = remoteStartWindowsScript(port, options.CodexPath)
	}
	output, err := runRemote(ctx, options.Connection, options.HomeDir, script)
	if err != nil {
		return false, err
	}
	switch {
	case strings.Contains(output, "ALREADY_RUNNING"):
		return false, nil
	case strings.Contains(output, "STARTED"):
		return true, nil
	default:
		return false, fmt.Errorf("远端 exec-server 启动结果不明：%s", firstNonEmpty(output, "无输出"))
	}
}

// StopRemoteExecServer 停掉远端 exec-server；不存在时也算成功。
func StopRemoteExecServer(ctx context.Context, options RemoteExecServerOptions) error {
	port := options.Port
	if port <= 0 {
		port = DefaultRemoteExecServerPort
	}
	platform := options.Platform
	if platform == "" {
		platform = DetectPlatform(ctx, options.Connection, options.HomeDir)
	}
	script := remoteStopScript(port)
	if platform == PlatformWindows {
		script = remoteStopWindowsScript(port)
	}
	_, err := runRemote(ctx, options.Connection, options.HomeDir, script)
	return err
}

// windowsStartInvocation 产出 Start-Process 需要的 -FilePath 与 -ArgumentList。
//
// 一律经 cmd.exe /c 转发：npm/pnpm 的 shim 是 .CMD，直接 Start-Process 会报
// "%1 is not a valid Win32 application"；cmd.exe 则对所有形态都能起。
func windowsStartInvocation(bin string, port int) (string, string) {
	listen := "ws://127.0.0.1:" + strconv.Itoa(port)
	inner := bin + " exec-server --listen " + listen
	// 参数以单引号包裹，避免外层 PowerShell 解析路径里的反斜杠。
	return "'cmd.exe'", "'/c','" + escapePowerShellSingle(inner) + "'"
}
