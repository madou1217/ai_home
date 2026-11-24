// Package autostart installs and removes the AI Home background service.
//
// It owns the launchd plist on macOS and the systemd user unit on Linux. The
// installed service always runs the Go aih-server directly; Node is not part of
// the service command.
package autostart

import (
	"bytes"
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	DefaultLabel   = "com.meadeo.ai_home"
	commandTimeout = 30 * time.Second
	// launchdShutdownWait 覆盖 plist 里的 ExitTimeOut（12s）加余量：旧进程还在
	// 退出时 launchd 会拒绝注册同名作业（Bootstrap failed: 5: Input/output error）。
	launchdShutdownWait = 40 * time.Second
	// launchdBootstrapWindow 是 bootstrap 的重试窗口，给 launchd 回收旧作业留时间。
	launchdBootstrapWindow = 20 * time.Second
)

var ErrUnsupportedPlatform = errors.New("autostart_platform_unsupported")

// ErrServiceLabelRequired 表示调用方没给出服务 label，无法定位受管作业。
var ErrServiceLabelRequired = errors.New("autostart_label_required")

// ServiceRestartCommand 是"在受管服务内重启进程"的唯一实现点，避免平台事实
// 在多个包里各推导一遍。
//
//   - macOS：`launchctl kickstart -k <target>`。它在**同一作业内**原子替换进程，
//     不存在先注销再注册的窗口。作为对比，`launchctl bootout` 是异步的（实测 9ms
//     返回），旧进程仍按 ExitTimeOut 存活最长 12s，这期间 `bootstrap` 必定返回
//     "Bootstrap failed: 5: Input/output error"。
//   - Linux：`systemctl --user restart <unit>`，本身就在同一 unit 内重启。
func ServiceRestartCommand(label string) (string, []string, error) {
	label = strings.TrimSpace(label)
	if label == "" {
		return "", nil, ErrServiceLabelRequired
	}
	switch runtime.GOOS {
	case "darwin":
		return "launchctl", []string{"kickstart", "-k", launchdDomain() + "/" + label}, nil
	case "linux":
		return "systemctl", []string{"--user", "restart", label + ".service"}, nil
	default:
		return "", nil, ErrUnsupportedPlatform
	}
}

// Start 在受管服务已安装但进程未运行时把它拉起来（重启的后半段）。
// 与 Install 分开：Install 会重建 plist/unit，Start 只负责启动。
func Start(ctx context.Context, options Options) error {
	options, err := normalize(options)
	if err != nil {
		return err
	}
	switch runtime.GOOS {
	case "darwin":
		_, err := run(ctx, "launchctl", "kickstart", launchdDomain()+"/"+options.Label)
		return err
	case "linux":
		_, err := run(ctx, "systemctl", "--user", "start", options.Label+".service")
		return err
	case "windows":
		_, err := run(ctx, "schtasks", "/Run", "/TN", options.Label)
		return err
	default:
		return ErrUnsupportedPlatform
	}
}

// ServiceJobLoaded 判断 label 是否已在服务管理器注册。平台差异收敛在这里，
// 调用方（CLI 重启、WebUI 重启按钮）不需要各自 switch。
func ServiceJobLoaded(ctx context.Context, label string) bool {
	label = strings.TrimSpace(label)
	if label == "" {
		return false
	}
	switch runtime.GOOS {
	case "darwin":
		_, err := run(ctx, "launchctl", "print", launchdDomain()+"/"+label)
		return err == nil
	case "linux":
		_, err := run(ctx, "systemctl", "--user", "cat", label+".service")
		return err == nil
	default:
		return false
	}
}

type Options struct {
	Label        string
	Home         string
	HostHome     string
	ServerBinary string
	WebDir       string
	LogFile      string
	// Args 非空时完全替代默认的 aih-server 启动参数（不含可执行文件本身）。
	Args []string
	// Env 是额外的服务环境变量；同名标准变量（HOME/PATH/AIH_HOME_DIR）会被覆盖。
	Env map[string]string
	// Description 用于 systemd unit；空值保持服务器默认文案。
	Description string
	// WorkingDir 是服务工作目录；空值使用可执行文件目录。
	WorkingDir string
}

type Status struct {
	Supported bool   `json:"supported"`
	Installed bool   `json:"installed"`
	Loaded    bool   `json:"loaded"`
	File      string `json:"file,omitempty"`
	Label     string `json:"label"`
	// PID 是服务管理器当前托管的进程号；0 表示拿不到（例如未运行）。
	// 调用方用它校验"端口上应答的进程"就是本次拉起的那个，避免假成功。
	PID int `json:"pid,omitempty"`
	// Strategy 记录本次安装实际走的路径，便于排查"重启为什么慢/为什么卡"：
	// in_place = 同一作业内重启进程；reinstall = 注销后重新注册。
	Strategy string `json:"strategy,omitempty"`
}

func normalize(options Options) (Options, error) {
	if strings.TrimSpace(options.Label) == "" {
		options.Label = DefaultLabel
	}
	if strings.TrimSpace(options.Home) == "" || strings.TrimSpace(options.HostHome) == "" {
		return options, errors.New("autostart_home_required")
	}
	home, err := filepath.Abs(options.Home)
	if err != nil {
		return options, err
	}
	hostHome, err := filepath.Abs(options.HostHome)
	if err != nil {
		return options, err
	}
	options.Home = filepath.Clean(home)
	options.HostHome = filepath.Clean(hostHome)
	server, err := filepath.Abs(strings.TrimSpace(options.ServerBinary))
	if err != nil || strings.TrimSpace(options.ServerBinary) == "" {
		return options, errors.New("autostart_server_binary_required")
	}
	options.ServerBinary = filepath.Clean(server)
	if info, err := os.Stat(options.ServerBinary); err != nil || info.IsDir() {
		return options, fmt.Errorf("autostart_server_binary_unavailable: %s", options.ServerBinary)
	}
	if strings.TrimSpace(options.WebDir) != "" {
		webDir, err := filepath.Abs(options.WebDir)
		if err != nil {
			return options, err
		}
		options.WebDir = filepath.Clean(webDir)
		if info, err := os.Stat(filepath.Join(options.WebDir, "index.html")); err != nil || info.IsDir() {
			options.WebDir = ""
		}
	}
	if strings.TrimSpace(options.LogFile) == "" {
		options.LogFile = filepath.Join(options.Home, "logs", "services", "background-supervisor.log")
	}
	if strings.TrimSpace(options.Description) == "" {
		options.Description = "AI Home local server"
	}
	if strings.TrimSpace(options.WorkingDir) == "" {
		options.WorkingDir = filepath.Dir(options.ServerBinary)
	} else if abs, err := filepath.Abs(options.WorkingDir); err == nil {
		options.WorkingDir = filepath.Clean(abs)
	}
	return options, nil
}

func serviceArgs(options Options) []string {
	server, args := serverCommand(options)
	command := append([]string{server}, args...)
	// macOS TCC attributes Screen Recording and Accessibility to the job's
	// responsible process. A stable launcher keeps that identity across server
	// upgrades, so the user grants the permissions once instead of on every
	// rebuild.
	if app := stableApp(options); app != "" {
		command = append(command, "--exit-with-parent")
		return append([]string{app, "--service", "--"}, command...)
	}
	if launcher := stableLauncher(options); launcher != "" {
		return append([]string{launcher, "--"}, command...)
	}
	return command
}

// stableApp returns the AI Home.app executable when it is installed. The app is
// the preferred TCC owner because it is a foreground bundle: the system can list
// it and prompt for Screen Recording and Accessibility without manual path entry.
func stableApp(options Options) string {
	if runtime.GOOS != "darwin" {
		return ""
	}
	candidate := filepath.Join(options.Home, "apps", "AI Home.app", "Contents", "MacOS", "ai-home")
	info, err := os.Stat(candidate)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&0o111 == 0 {
		return ""
	}
	return candidate
}

// stableLauncher returns the rarely changed parent process installed beside the
// AIH home. It is optional: installs without it keep running the server directly.
func stableLauncher(options Options) string {
	if runtime.GOOS != "darwin" {
		return ""
	}
	candidate := filepath.Join(options.Home, "bin", "aih-launch")
	info, err := os.Stat(candidate)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&0o111 == 0 {
		return ""
	}
	return candidate
}

func serverCommand(options Options) (string, []string) {
	if len(options.Args) > 0 {
		return options.ServerBinary, append([]string(nil), options.Args...)
	}
	args := []string{"--host", "127.0.0.1"}
	if options.WebDir != "" {
		args = append(args, "--web-dir", options.WebDir)
	}
	if port := strings.TrimSpace(os.Getenv("AIH_SERVER_PORT")); port != "" {
		args = append(args, "--port", port)
	}
	return options.ServerBinary, args
}

// serviceEnv 返回确定顺序的服务环境变量，额外 Env 覆盖标准值。
func serviceEnv(options Options) [][2]string {
	env := map[string]string{
		"HOME":         options.HostHome,
		"PATH":         os.Getenv("PATH"),
		"AIH_HOME_DIR": options.Home,
	}
	for key, value := range options.Env {
		if key = strings.TrimSpace(key); key != "" {
			env[key] = value
		}
	}
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	out := make([][2]string, 0, len(keys))
	for _, key := range keys {
		out = append(out, [2]string{key, env[key]})
	}
	return out
}

func Install(ctx context.Context, options Options) (Status, error) {
	return InstallWithMode(ctx, options, false)
}

// InstallWithMode 在安装/补装时区分强制与平滑：force=true 直接结束旧进程。
func InstallWithMode(ctx context.Context, options Options, force bool) (Status, error) {
	options, err := normalize(options)
	if err != nil {
		return Status{}, err
	}
	switch runtime.GOOS {
	case "darwin":
		return installLaunchd(ctx, options, force)
	case "linux":
		return installSystemd(ctx, options)
	case "windows":
		return installWindows(ctx, options)
	default:
		return Status{Label: options.Label}, ErrUnsupportedPlatform
	}
}

func Stop(ctx context.Context, options Options) error {
	return StopWithMode(ctx, options, false)
}

// StopWithMode 停止受管服务。force=true 在注销作业后立刻 SIGKILL 残留进程，
// 不等服务端收尾（默认 stop 的语义）；force=false 让进程按自己的收尾预算退出。
func StopWithMode(ctx context.Context, options Options, force bool) error {
	options, err := normalize(options)
	if err != nil {
		return err
	}
	switch runtime.GOOS {
	case "darwin":
		target := launchdDomain() + "/" + options.Label
		previous := launchdPIDs(ctx, target)
		// 先注销作业再杀进程：反过来的话 KeepAlive 会立刻把进程拉回来。
		_, _ = run(ctx, "launchctl", "bootout", target)
		for attempt := 0; attempt < 50; attempt++ {
			if _, err := run(ctx, "launchctl", "print", target); err != nil {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
		if force {
			for _, pid := range previous {
				_, _ = run(ctx, "kill", "-KILL", strconv.Itoa(pid))
			}
			return nil
		}
		waitProcessExit(previous, launchdShutdownWait)
		return nil
	case "linux":
		unit := options.Label + ".service"
		if force {
			// systemctl stop 会先 SIGTERM 再等 TimeoutStopSec，强制模式直接 SIGKILL。
			_, _ = run(ctx, "systemctl", "--user", "kill", "--signal=SIGKILL", unit)
		}
		_, err := run(ctx, "systemctl", "--user", "stop", unit)
		return err
	case "windows":
		_, _ = run(ctx, "schtasks", "/End", "/TN", options.Label)
		return nil
	default:
		return ErrUnsupportedPlatform
	}
}

func Uninstall(ctx context.Context, options Options) error {
	options, err := normalize(options)
	if err != nil {
		return err
	}
	switch runtime.GOOS {
	case "darwin":
		return uninstallLaunchd(ctx, options)
	case "linux":
		return uninstallSystemd(ctx, options)
	case "windows":
		return uninstallWindows(ctx, options)
	default:
		return ErrUnsupportedPlatform
	}
}

func StatusFor(ctx context.Context, options Options) (Status, error) {
	options, err := normalize(options)
	if err != nil {
		return Status{}, err
	}
	switch runtime.GOOS {
	case "darwin":
		return statusLaunchd(ctx, options)
	case "linux":
		return statusSystemd(ctx, options)
	case "windows":
		return statusWindows(options)
	default:
		return Status{Label: options.Label}, ErrUnsupportedPlatform
	}
}

func run(ctx context.Context, name string, args ...string) ([]byte, error) {
	op, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	cmd := exec.CommandContext(op, name, args...)
	cmd.Env = os.Environ()
	raw, err := cmd.CombinedOutput()
	if err != nil {
		return raw, fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, strings.TrimSpace(string(raw)))
	}
	return raw, nil
}

func atomicWrite(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".autostart-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(mode); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempName, path)
}

func xmlEscape(value string) string {
	var buffer bytes.Buffer
	_ = xml.EscapeText(&buffer, []byte(value))
	return buffer.String()
}

func plistPath(options Options) string {
	return filepath.Join(options.HostHome, "Library", "LaunchAgents", options.Label+".plist")
}

func launchdDomain() string {
	return fmt.Sprintf("gui/%d", os.Getuid())
}

func buildPlist(options Options) []byte {
	lines := []string{
		"<?xml version='1.0' encoding='UTF-8'?>",
		"<!DOCTYPE plist PUBLIC '-//Apple//DTD PLIST 1.0//EN' 'http://www.apple.com/DTDs/PropertyList-1.0.dtd'>",
		"<plist version='1.0'>",
		"  <dict>",
		"    <key>Label</key>",
		"    <string>" + xmlEscape(options.Label) + "</string>",
		"    <key>ProgramArguments</key>",
		"    <array>",
	}
	for _, argument := range serviceArgs(options) {
		lines = append(lines, "      <string>"+xmlEscape(argument)+"</string>")
	}
	lines = append(lines,
		"    </array>",
		"    <key>RunAtLoad</key>",
		"    <true/>",
		"    <key>KeepAlive</key>",
		"    <dict>",
		"      <key>SuccessfulExit</key>",
		"      <false/>",
		"    </dict>",
		"    <key>ExitTimeOut</key>",
		// 服务端退出前会等正在生成的回答收尾（最多 30s），这里必须给足，
		// 否则 launchd 会在推理流没写完时 SIGKILL，客户端表现为会话中断。
		"    <integer>45</integer>",
		"    <key>ProcessType</key>",
		"    <string>Standard</string>",
		"    <key>ThrottleInterval</key>",
		"    <integer>5</integer>",
		"    <key>StandardOutPath</key>",
		"    <string>"+xmlEscape(options.LogFile)+"</string>",
		"    <key>StandardErrorPath</key>",
		"    <string>"+xmlEscape(options.LogFile)+"</string>",
		// launchd 的默认 soft limit 是 256；Server 的 SSE/PTY/SQLite/插件子进程
		// 很快就会耗尽，表现为 accept: too many open files 与大量 5xx。
		"    <key>SoftResourceLimits</key>",
		"    <dict>",
		"      <key>NumberOfFiles</key>",
		"      <integer>65536</integer>",
		"    </dict>",
		"    <key>HardResourceLimits</key>",
		"    <dict>",
		"      <key>NumberOfFiles</key>",
		"      <integer>65536</integer>",
		"    </dict>",
		"    <key>EnvironmentVariables</key>",
		"    <dict>",
	)
	for _, item := range serviceEnv(options) {
		lines = append(lines, "      <key>"+xmlEscape(item[0])+"</key>")
		lines = append(lines, "      <string>"+xmlEscape(item[1])+"</string>")
	}
	lines = append(lines,
		"    </dict>",
		"  </dict>",
		"</plist>",
		"",
	)
	return []byte(strings.Join(lines, string(rune(10))))
}

func installLaunchd(ctx context.Context, options Options, force bool) (Status, error) {
	path := plistPath(options)
	domain := launchdDomain()
	target := domain + "/" + options.Label
	desired := buildPlist(options)
	// 作业已注册且 plist 未变时，重启只是在**同一作业内换进程**：
	// `launchctl kickstart -k` 原子替换，没有未注册窗口。
	// 真机实测（2026-11-20）：`launchctl bootout` 9ms 就返回，而旧进程会按
	// ExitTimeOut 继续存活最长 12s；这期间 `bootstrap` 一律返回
	// "Bootstrap failed: 5: Input/output error"，重试再多也只能等。
	if current, err := os.ReadFile(path); err == nil && bytes.Equal(current, desired) {
		// 只有强制重启才在作业内直接换进程；普通安装（force=false）保持
		// 原有的 bootout/bootstrap 流程，避免 install 顺手 SIGKILL 运行中的服务。
		if force && ServiceJobLoaded(ctx, options.Label) {
			if status, ok := kickstartLaunchd(ctx, target, options); ok {
				status.Strategy = "in_place"
				return status, nil
			}
		}
	}
	previous := launchdPIDs(ctx, target)
	if force {
		// 强制：先 SIGKILL，避免 bootout 之后还要等收尾窗口。
		for _, pid := range previous {
			_, _ = run(ctx, "kill", "-KILL", strconv.Itoa(pid))
		}
	}
	_, _ = run(ctx, "launchctl", "bootout", target)
	// bootout 只把作业从 launchd 注销，旧进程仍可能在优雅关闭（最长 10s）。
	// 只要旧进程还活着，launchctl bootstrap 就一律返回 Input/output error，
	// 重试再多也没用，所以先等进程真正退出。
	for attempt := 0; attempt < 50; attempt++ {
		if _, err := run(ctx, "launchctl", "print", target); err != nil {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if !force {
		waitProcessExit(previous, launchdShutdownWait)
	}
	if err := atomicWrite(path, buildPlist(options), 0600); err != nil {
		return Status{}, err
	}
	var bootstrapErr error
	deadline := time.Now().Add(launchdBootstrapWindow)
	for {
		if _, bootstrapErr = run(ctx, "launchctl", "bootstrap", domain, path); bootstrapErr == nil {
			break
		}
		if time.Now().After(deadline) {
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	if bootstrapErr != nil {
		// launchctl load is the legacy fallback for older launchd versions.
		if _, loadErr := run(ctx, "launchctl", "load", path); loadErr != nil {
			return Status{}, fmt.Errorf("launchctl bootstrap: %w; load: %v", bootstrapErr, loadErr)
		}
	}
	time.Sleep(time.Second)
	// bootstrap 成功后 RunAtLoad 已经拉起进程，这里**不能再 kickstart -k**：
	// 那会把刚起来的实例再杀一次，重启凭空多出一个"关停→启动"窗口（旧进程退出
	// 期间的上游请求会直接失联）。只有作业在、进程却没起来时才补一次启动。
	for attempt := 0; attempt < 20; attempt++ {
		raw, err := run(ctx, "launchctl", "print", target)
		if err != nil {
			_, _ = run(ctx, "launchctl", "bootstrap", domain, path)
			time.Sleep(500 * time.Millisecond)
			continue
		}
		if len(parseLaunchdPIDs(raw)) == 0 {
			_, _ = run(ctx, "launchctl", "kickstart", target)
			time.Sleep(500 * time.Millisecond)
			continue
		}
		time.Sleep(time.Second)
		if status, statusErr := statusLaunchd(ctx, options); statusErr == nil && status.Loaded && status.PID > 0 {
			status.Strategy = "reinstall"
			return status, nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return Status{}, fmt.Errorf("launchctl job did not stay loaded: %v", bootstrapErr)
}

// kickstartLaunchd 在已注册的 launchd 作业内原子重启进程。返回 ok=false 时由
// 调用方退回完整的 bootout → 等旧进程退出 → bootstrap 流程（例如作业已进入
// 异常状态、或 kickstart 被系统拒绝）。
// Restart 在同一作业内强制重启服务。
//
// 重启只有一种语义：立即结束旧进程再拉起。不存在“先关准入、等存量请求收尾”
// 的中间状态——那种状态会让服务端在 /readyz 仍返回就绪的同时对全部新推理
// 回 503，客户端无法区分“在重启”和“服务坏了”（2026-11-21 实测回归）。
// 进程自身的关闭路径仍按它自己的预算收尾，但重启动作不再等待它。
func Restart(ctx context.Context, options Options) (Status, error) {
	options, err := normalize(options)
	if err != nil {
		return Status{}, err
	}
	switch runtime.GOOS {
	case "darwin":
		return restartLaunchd(ctx, options)
	case "linux":
		return restartSystemd(ctx, options)
	case "windows":
		return restartWindows(ctx, options)
	default:
		return Status{}, ErrUnsupportedPlatform
	}
}

func restartLaunchd(ctx context.Context, options Options) (Status, error) {
	target := launchdDomain() + "/" + options.Label
	// 重启不比对 plist：plist 里带有调用方 PATH 等环境差异，逐次比较会把每次
	// restart 都降级成 bootout+bootstrap（慢且多一个未注册窗口）。真正的重新
	// 安装由 install/start 负责；restart 只在同一作业内换进程。
	if ServiceJobLoaded(ctx, options.Label) {
		if status, ok := kickstartLaunchd(ctx, target, options); ok {
			status.Strategy = "in_place"
			return status, nil
		}
	}
	return InstallWithMode(ctx, options, true)
}

func restartSystemd(ctx context.Context, options Options) (Status, error) {
	unit := options.Label + ".service"
	// 强制：直接 SIGKILL，不等服务端的收尾窗口。
	_, _ = run(ctx, "systemctl", "--user", "kill", "--signal=SIGKILL", unit)
	if _, err := run(ctx, "systemctl", "--user", "restart", unit); err != nil {
		return Status{}, err
	}
	status, err := statusSystemd(ctx, options)
	if err != nil {
		return Status{}, err
	}
	return status, nil
}

func restartWindows(ctx context.Context, options Options) (Status, error) {
	_, _ = run(ctx, "schtasks", "/End", "/TN", options.Label)
	// /End 对控制台程序是 TerminateProcess，返回即进程已消失；留一点窗口给句柄释放。
	time.Sleep(500 * time.Millisecond)
	if _, err := run(ctx, "schtasks", "/Run", "/TN", options.Label); err != nil {
		return Status{}, err
	}
	return statusWindows(options)
}

// kickstartLaunchd 强制重启已注册作业：kickstart -k 直接 SIGKILL 旧进程后
// 在同一作业内拉起，不等待服务端收尾，也不存在排空窗口。
func kickstartLaunchd(ctx context.Context, target string, options Options) (Status, bool) {
	name, args, err := ServiceRestartCommand(options.Label)
	if err != nil {
		return Status{}, false
	}
	before := launchdPIDs(context.Background(), target)
	if _, err := run(ctx, name, args...); err != nil {
		return Status{}, false
	}
	// kickstart 返回不代表新进程已在服务：等到作业报出与旧进程不同的 pid，
	// 否则"作业还在、进程没换"会被当成重启成功。
	deadline := time.Now().Add(launchdBootstrapWindow)
	for time.Now().Before(deadline) {
		if pid := firstPIDNotIn(launchdPIDs(context.Background(), target), before); pid > 0 {
			status, err := statusLaunchd(ctx, options)
			if err != nil {
				return Status{}, false
			}
			status.PID = pid
			return status, true
		}
		time.Sleep(500 * time.Millisecond)
	}
	return Status{}, false
}

func firstPIDNotIn(pids []int, previous []int) int {
	for _, pid := range pids {
		found := false
		for _, old := range previous {
			if pid == old {
				found = true
				break
			}
		}
		if !found {
			return pid
		}
	}
	return 0
}

func uninstallLaunchd(ctx context.Context, options Options) error {
	_, _ = run(ctx, "launchctl", "bootout", launchdDomain()+"/"+options.Label)
	if err := os.Remove(plistPath(options)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// launchdPIDs 读取 launchctl print 里的 pid，用于在重启前等待旧进程退出。
func launchdPIDs(ctx context.Context, target string) []int {
	raw, err := run(ctx, "launchctl", "print", target)
	if err != nil {
		return nil
	}
	return parseLaunchdPIDs(raw)
}

func parseLaunchdPIDs(raw []byte) []int {
	var pids []int
	for _, line := range strings.Split(string(raw), string(rune(10))) {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "pid = ") {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "pid = ")))
		if err == nil && pid > 0 {
			pids = append(pids, pid)
		}
	}
	return pids
}

// waitProcessExit 阻塞到给定进程全部消失或超时。launchd 的 bootstrap 在旧进程
// 存活期间必定失败，这里是重启可靠性的关键等待。多个 pid 共享同一个截止时间，
// 避免逐个 pid 各自计时而把最长等待放大成 N 倍。
func waitProcessExit(pids []int, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for _, pid := range pids {
		if pid <= 0 {
			continue
		}
		for processAlive(pid) && time.Now().Before(deadline) {
			time.Sleep(100 * time.Millisecond)
		}
	}
}

// processAlive 用信号 0 探测进程是否存在，避免每 100ms 起一个 kill 子进程。
func processAlive(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return process.Signal(syscall.Signal(0)) == nil
}

func statusLaunchd(ctx context.Context, options Options) (Status, error) {
	path := plistPath(options)
	status := Status{Supported: true, Label: options.Label, File: path}
	if _, err := os.Stat(path); err == nil {
		status.Installed = true
	}
	target := launchdDomain() + "/" + options.Label
	if raw, err := run(ctx, "launchctl", "print", target); err == nil {
		status.Loaded = true
		if pids := parseLaunchdPIDs(raw); len(pids) > 0 {
			status.PID = pids[0]
		}
	}
	return status, nil
}

func unitPath(options Options) string {
	return filepath.Join(options.HostHome, ".config", "systemd", "user", options.Label+".service")
}

func systemdQuote(value string) string {
	backslash := string(rune(92))
	quote := string(rune(34))
	value = strings.ReplaceAll(value, backslash, backslash+backslash)
	value = strings.ReplaceAll(value, quote, backslash+quote)
	value = strings.ReplaceAll(value, "%", "%%")
	return quote + value + quote
}

func buildUnit(options Options) []byte {
	args := serviceArgs(options)
	quoted := make([]string, 0, len(args))
	for _, argument := range args {
		quoted = append(quoted, systemdQuote(argument))
	}
	lines := []string{
		"[Unit]",
		"Description=" + options.Description,
		"After=network-online.target",
		"Wants=network-online.target",
		"",
		"[Service]",
		"Type=simple",
		"ExecStart=" + strings.Join(quoted, " "),
		"WorkingDirectory=" + options.WorkingDir,
		"Restart=always",
		"RestartSec=5",
		"TimeoutStopSec=45",
		"",
		"[Install]",
		"WantedBy=default.target",
	}
	for _, item := range serviceEnv(options) {
		insertAt := len(lines) - 3
		lines = append(lines, "")
		copy(lines[insertAt+1:], lines[insertAt:])
		lines[insertAt] = "Environment=" + systemdQuote(item[0]+"="+item[1])
	}
	return []byte(strings.Join(lines, string(rune(10))))
}

func windowsPaths(options Options) (serveScript, marker, startupDir, startupScript, launcherScript string) {
	runDir := filepath.Join(options.Home, "run")
	startupDir = filepath.Join(options.HostHome, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
	return filepath.Join(runDir, "aih-server-serve.cmd"),
		filepath.Join(runDir, "windows-autostart-task.json"),
		startupDir,
		filepath.Join(startupDir, options.Label+".vbs"),
		filepath.Join(startupDir, options.Label+".cmd")
}

func windowsQuote(value string) string {
	quote := string(rune(34))
	return quote + strings.ReplaceAll(value, quote, quote+quote) + quote
}

func windowsScriptCommand(options Options) string {
	args := serviceArgs(options)
	quoted := make([]string, 0, len(args))
	for _, argument := range args {
		quoted = append(quoted, windowsQuote(argument))
	}
	command := strings.Join(quoted, " ")
	if options.LogFile != "" {
		command += " >> " + windowsQuote(options.LogFile) + " 2>&1"
	}
	return command
}

func buildWindowsServeScript(options Options) []byte {
	crlf := string(rune(13)) + string(rune(10))
	lines := []string{
		"@echo off",
		"set " + windowsQuote("AIH_HOME_DIR="+options.Home),
		windowsScriptCommand(options),
		"",
	}
	return []byte(strings.Join(lines, crlf))
}

func buildWindowsVBS(options Options) []byte {
	crlf := string(rune(13)) + string(rune(10))
	pathValue := os.Getenv("PATH")
	command := windowsScriptCommand(options)
	lines := []string{
		"Option Explicit",
		"Dim shell, execObj",
		"Set shell = CreateObject(" + windowsQuote("WScript.Shell") + ")",
		"shell.Environment(" + windowsQuote("PROCESS") + ")(" + windowsQuote("PATH") + ") = " + windowsQuote(pathValue),
		"shell.Environment(" + windowsQuote("PROCESS") + ")(" + windowsQuote("AIH_HOME_DIR") + ") = " + windowsQuote(options.Home),
		"Set execObj = shell.Exec(" + windowsQuote("%ComSpec% /c "+windowsQuote(command)) + ")",
		"",
	}
	return []byte(strings.Join(lines, crlf))
}

func installWindows(ctx context.Context, options Options) (Status, error) {
	serveScript, marker, startupDir, startupScript, launcherScript := windowsPaths(options)
	if err := os.MkdirAll(filepath.Dir(serveScript), 0700); err != nil {
		return Status{}, err
	}
	if err := os.MkdirAll(filepath.Dir(options.LogFile), 0700); err != nil {
		return Status{}, err
	}
	if err := atomicWrite(serveScript, buildWindowsServeScript(options), 0600); err != nil {
		return Status{}, err
	}
	args := []string{"/Create", "/SC", "ONLOGON", "/TN", options.Label, "/TR", windowsQuote(serveScript), "/F"}
	if user := strings.TrimSpace(os.Getenv("USERNAME")); user != "" {
		args = append(args, "/RU", user, "/IT")
	}
	if _, err := run(ctx, "schtasks", args...); err != nil {
		_ = os.Remove(marker)
		// Fall back to the Startup folder only when Task Scheduler refuses.
		if startupErr := os.MkdirAll(startupDir, 0700); startupErr != nil {
			return Status{}, err
		}
		if startupErr := atomicWrite(startupScript, buildWindowsVBS(options), 0600); startupErr != nil {
			return Status{}, err
		}
		launcher := []byte("@echo off" + string(rune(13)) + string(rune(10)) + "cscript //nologo " + windowsQuote(startupScript) + string(rune(13)) + string(rune(10)))
		if startupErr := atomicWrite(launcherScript, launcher, 0600); startupErr != nil {
			return Status{}, err
		}
		return statusWindows(options)
	}
	// 计划任务只声明 ONLOGON 触发；安装流程必须当场拉起一次，否则安装器随后的
	// 启动验证没有任何进程可连。Linux/macOS 的安装路径本身就带 restart，Windows
	// 的 schtasks /Create 不带。这里不把 /Run 的失败直接判死：服务是否真的起来
	// 由安装器的启动验证统一决定（任务已运行时 /Run 也返回成功）。
	_, _ = run(ctx, "schtasks", "/Run", "/TN", options.Label)
	payload, _ := json.Marshal(map[string]string{"task": options.Label, "script": serveScript})
	body := append(payload, byte(rune(10)))
	if err := atomicWrite(marker, body, 0600); err != nil {
		return Status{}, err
	}
	return statusWindows(options)
}

func uninstallWindows(ctx context.Context, options Options) error {
	serveScript, marker, _, startupScript, launcherScript := windowsPaths(options)
	for _, file := range []string{serveScript, marker, startupScript, launcherScript} {
		if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	_, _ = run(ctx, "schtasks", "/End", "/TN", options.Label)
	_, _ = run(ctx, "schtasks", "/Delete", "/TN", options.Label, "/F")
	return nil
}

func statusWindows(options Options) (Status, error) {
	serveScript, marker, _, startupScript, _ := windowsPaths(options)
	status := Status{Supported: true, Label: options.Label}
	if _, err := os.Stat(marker); err == nil {
		status.Installed, status.Loaded, status.File = true, true, serveScript
	} else if _, err := os.Stat(startupScript); err == nil {
		status.Installed, status.Loaded, status.File = true, true, startupScript
	}
	return status, nil
}

func installSystemd(ctx context.Context, options Options) (Status, error) {
	if _, err := run(ctx, "systemctl", "--user", "--version"); err != nil {
		return Status{}, err
	}
	if err := atomicWrite(unitPath(options), buildUnit(options), 0600); err != nil {
		return Status{}, err
	}
	if _, err := run(ctx, "systemctl", "--user", "daemon-reload"); err != nil {
		return Status{}, err
	}
	if _, err := run(ctx, "systemctl", "--user", "enable", options.Label+".service"); err != nil {
		return Status{}, err
	}
	if _, err := run(ctx, "systemctl", "--user", "restart", options.Label+".service"); err != nil {
		return Status{}, err
	}
	return StatusFor(ctx, options)
}

func uninstallSystemd(ctx context.Context, options Options) error {
	_, _ = run(ctx, "systemctl", "--user", "disable", "--now", options.Label+".service")
	if err := os.Remove(unitPath(options)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	_, _ = run(ctx, "systemctl", "--user", "daemon-reload")
	return nil
}

func statusSystemd(ctx context.Context, options Options) (Status, error) {
	path := unitPath(options)
	status := Status{Supported: true, Label: options.Label, File: path}
	if _, err := os.Stat(path); err == nil {
		status.Installed = true
	}
	service := options.Label + ".service"
	if _, err := run(ctx, "systemctl", "--user", "is-active", service); err == nil {
		status.Loaded = true
	}
	if raw, err := run(ctx, "systemctl", "--user", "show", "-p", "MainPID", "--value", service); err == nil {
		if pid, convErr := strconv.Atoi(strings.TrimSpace(string(raw))); convErr == nil && pid > 0 {
			status.PID = pid
		}
	}
	return status, nil
}
