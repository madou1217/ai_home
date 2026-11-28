package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/serverconfig"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/autostart"
)

// 本文件由单一 owner 维护（2026-11-21 用户裁定），改动前先在 aih peer 上确认；
// 不要单方面删除 --graceful：它是用户要求的第二种模式，不是历史包袱。
//
// 生命周期语义：
//   - 默认 / --force：强制，立即换进程，不等在跑的会话；
//   - --graceful：进程级平滑——SIGTERM（Windows 走 /v0/management/shutdown），
//     等进程按自己的收尾预算退出后再拉起；
//   - 不引入服务端 drain 闸门（排空期 readyz 200 / 新推理 503，客户端分不清
//     “在重启”和“服务坏了”，2026-11-21 实测回归）。
//
// runServerLifecycle owns the common server lifecycle commands. Advanced
// serve/config variants still delegate to the legacy CLI until each command has
// a Go implementation.
func runServerLifecycle(ctx context.Context, arguments []string, runtime commandRuntime) (bool, error) {
	action := ""
	switch {
	case len(arguments) == 1 && arguments[0] == "serve":
		action = "start"
	case len(arguments) >= 1 && (arguments[0] == "server" || arguments[0] == "daemon"):
		if len(arguments) > 1 {
			action = strings.TrimSpace(arguments[1])
		} else {
			action = "start"
		}
	default:
		return false, nil
	}
	if action == "help" || action == "--help" || action == "-h" {
		showServerUsage(runtime)
		return true, nil
	}
	if action != "start" && action != "stop" && action != "restart" && action != "status" {
		return false, nil
	}
	// 生命周期有两种模式，默认强制：
	//   默认（或 --force）：立即换掉进程，不等里面在跑的会话；
	//   --graceful：只读地等 active_inference 归零再换（类似 nginx 的平滑重启）。
	//
	// 刻意不调用服务端 drain：排空期间 /readyz 仍是 200，而全部新推理返回 503，
	// 客户端分不清“在重启”和“服务坏了”（2026-11-21 实测回归）。等待只发生在
	// CLI 侧，服务端行为不变。
	graceful := false
	for _, argument := range arguments[2:] {
		switch {
		case argument == "--graceful" && (action == "restart" || action == "stop"):
			graceful = true
		case argument == "--force" && (action == "restart" || action == "stop"):
			graceful = false
		default:
			var message string
			switch action {
			case "start":
				message = "server start does not accept serve options; update server config first"
			case "stop", "restart":
				message = "server " + action + " 只接受 --graceful / --force"
			default:
				message = "server status does not accept serve options"
			}
			_, _ = fmt.Fprintf(runtime.stderr, "\x1b[31m[aih] %s\x1b[0m\n", message)
			return true, cliExitCode{code: 1}
		}
	}
	options, err := resolveAutostartOptionsLoose(runtime)
	if err != nil {
		return true, err
	}
	port := resolveServerPort(ctx, options.Home, runtime)
	// status/stop 只需要 label 和 pid；start/restart 在真正需要拉起新进程时
	// 才要求 server 二进制。start 命中已运行实例时不应因为解析不到二进制而失败。
	if action == "start" || action == "restart" {
		if action == "start" && serverReady(ctx, port) {
			_, _ = fmt.Fprintln(runtime.stdout, "[aih] server is already running")
			return true, nil
		}
		if strings.TrimSpace(options.ServerBinary) == "" {
			options, err = resolveAutostartOptions(runtime)
			if err != nil {
				return true, err
			}
		}
	}
	switch action {
	case "start":
		if serverReady(ctx, port) {
			_, _ = fmt.Fprintln(runtime.stdout, "[aih] server is already running")
			return true, nil
		}
		if _, err := autostart.Install(ctx, options); err != nil {
			return true, err
		}
		if !waitServerReady(ctx, port, serverReadyTimeout) {
			return true, fmt.Errorf("server started but /readyz did not answer on port %d within %s", port, serverReadyTimeout)
		}
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] server started (port=%d)\n", port)
	case "stop":
		if goruntime.GOOS == "windows" && !serverReady(ctx, port) && serverPID(options.Home) <= 0 {
			_, _ = fmt.Fprintln(runtime.stdout, "[aih] server is not running")
			return true, nil
		}
		if graceful {
			if err := stopServerGracefully(ctx, port, options, gracefulWaitTimeout); err != nil {
				return true, err
			}
			_ = autostart.Stop(ctx, options)
			_, _ = fmt.Fprintf(runtime.stdout, "[aih] server stopped (mode=%s)\n", modeLabel(graceful))
			return true, nil
		}
		if goruntime.GOOS == "windows" {
			windowsStopService(ctx, options)
		} else if err := autostart.StopWithMode(ctx, options, true); err != nil {
			return true, err
		}
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] server stopped (mode=%s)\n", modeLabel(graceful))
	case "restart":
		previousPID := serverPID(options.Home)
		var status autostart.Status
		var installErr error
		if graceful {
			// 平滑：先让进程按自己的收尾窗口退出（SIGTERM；Windows 走管理端点），
			// 确认进程消失后再拉起。服务端不会进入“readyz 200 但新推理 503”的状态。
			if err := stopServerGracefully(ctx, port, options, gracefulWaitTimeout); err != nil {
				return true, err
			}
			// 旧进程可能非 0 退出（收尾超时），launchd KeepAlive 会自己拉起；
			// 这时 Start 报 already running 不代表失败，以就绪 + pid 变化为准。
			if startErr := autostart.Start(ctx, options); startErr == nil {
				status, _ = autostart.StatusFor(ctx, options)
				status.Strategy = "graceful"
			}
		} else if goruntime.GOOS == "windows" {
			windowsStopService(ctx, options)
			installErr = autostart.Start(ctx, options)
			if installErr == nil {
				status, _ = autostart.StatusFor(ctx, options)
			}
		} else {
			status, installErr = autostart.Restart(ctx, options)
		}
		if installErr != nil {
			return true, installErr
		}
		// 作业注册成功不代表已经能服务：启动装配还需要时间，调用方紧接着发请求
		// 会拿到 connection refused。这里等到 /readyz 真正通过再报成功。
		// 不要求“应答者等于 launchd 报的那个 pid”：kickstart -k 之后 launchd 可能
		// 先起一个抢不到端口的实例、再重试一个，严格比对会把自己重试出来的新实例
		// 判成“别人占端口”。只要求：ready 为真，且应答的 pid 不是重启前那个。
		observedPID, ready := waitServerReadyOwned(ctx, port, options.Home, 0, serverReadyTimeout, runtime.stdout)
		if !ready {
			return true, fmt.Errorf("server restarted but /readyz did not answer on port %d within %s", port, serverReadyTimeout)
		}
		// 硬校验：旧进程还在应答 = 实际没换进程，不能报成功。
		if previousPID > 0 && observedPID == previousPID {
			return true, fmt.Errorf("server restart did not replace the supervised process (pid %d still serving port %d)", previousPID, port)
		}
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] server restarted (port=%d, pid=%d, strategy=%s, mode=%s)\n", port, observedPID, status.Strategy, modeLabel(graceful))
	case "status":
		status, _ := autostart.StatusFor(ctx, options)
		ready := serverReady(ctx, port)
		if ready {
			_, _ = fmt.Fprintf(runtime.stdout, "[aih] server is running (port=%d)\n", port)
			_, _ = fmt.Fprintln(runtime.stdout, "  ready: true")
		} else {
			_, _ = fmt.Fprintln(runtime.stdout, "[aih] server is not running")
		}
		_, _ = fmt.Fprintf(runtime.stdout, "  base_url: http://127.0.0.1:%d\n", port)
		_, _ = fmt.Fprintf(runtime.stdout, "  autostart: type=%s installed=%t loaded=%t\n",
			autostartType(), status.Installed, status.Loaded)
		if ready {
			if pid := serverPID(options.Home); pid > 0 {
				_, _ = fmt.Fprintf(runtime.stdout, "  pid_file: %s\n", filepath.Join(options.Home, "run", "go-server-runtime.json"))
				_, _ = fmt.Fprintf(runtime.stdout, "  pid: %d\n", pid)
			}
		}
	}
	return true, nil
}

func resolveServerPort(ctx context.Context, home string, runtime commandRuntime) int {
	if value := strings.TrimSpace(readEnv(runtime.lookupEnv, "AIH_SERVER_PORT")); value != "" {
		if port, err := strconv.Atoi(value); err == nil && serverconfig.IsValidPort(port) {
			return port
		}
	}
	path, err := appstate.DatabasePath(home)
	if err != nil {
		return serverconfig.DefaultPort
	}
	raw, found, err := appstate.ReadKV(ctx, path, appstate.KeyServerConfig)
	if err != nil || !found {
		return serverconfig.DefaultPort
	}
	var config map[string]any
	if json.Unmarshal([]byte(raw), &config) != nil {
		return serverconfig.DefaultPort
	}
	if number, ok := config["port"].(float64); ok && serverconfig.IsValidPort(number) {
		return int(number)
	}
	return serverconfig.DefaultPort
}

// serverReadyTimeout 覆盖本地服务完整装配（数据面 + 后台 worker）的耗时。
// gracefulWaitTimeout 是 --graceful 等存量推理流清零的上限。超时不改任何状态，
// 直接报错让调用方决定是否改用默认（强制）模式。
const gracefulWaitTimeout = 300 * time.Second

func modeLabel(graceful bool) string {
	if graceful {
		return "graceful"
	}
	return "force"
}

// stopServerGracefully 让受管进程按自己的收尾预算退出，并等它真正消失。
//
// macOS/Linux 用 SIGTERM；Windows 没有可用信号，改用受 Management Key 保护的
// /v0/management/shutdown（服务端先回 202，再走自己的收尾路径）。这不是
// “排空/暂停”：服务端照常对外服务到进程退出为止，不会出现 readyz 200 但
// 新推理全 503 的窗口。
func stopServerGracefully(ctx context.Context, port int, options autostart.Options, timeout time.Duration) error {
	pid := serverPID(options.Home)
	if pid <= 0 {
		return nil
	}
	// 运行态文件可能是崩溃后留下的旧记录，pid 也可能已被系统回收给无关进程：
	// 只对“确实是 aih-server 的那一个 pid”发信号。
	if !managedServerProcess(pid) {
		return nil
	}
	if goruntime.GOOS == "windows" {
		if err := requestServerShutdown(ctx, port, resolveManagementKey(options.Home)); err != nil {
			return fmt.Errorf("请求服务端优雅退出失败: %w", err)
		}
	} else if err := exec.Command("kill", "-TERM", strconv.Itoa(pid)).Run(); err != nil {
		// 进程可能恰好已经退出，交给下面的存活检查裁决。
		_ = err
	}
	if !waitProcessGone(pid, timeout) {
		return fmt.Errorf("pid %d 在 %s 内没有退出；如需立即结束请去掉 --graceful（强制模式）", pid, timeout)
	}
	return nil
}

func waitProcessGone(pid int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if !processAlive(pid) {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// managedServerProcess 校验 pid 确实是 aih-server，防止 pid 回收后误杀。
func managedServerProcess(pid int) bool {
	if pid <= 0 {
		return false
	}
	if goruntime.GOOS == "windows" {
		output, err := exec.Command("tasklist", "/FI", fmt.Sprintf("PID eq %d", pid), "/NH").Output()
		return err == nil && strings.Contains(strings.ToLower(string(output)), "aih-server")
	}
	output, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "command=").Output()
	if err != nil {
		return false
	}
	return strings.Contains(string(output), "aih-server")
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	if goruntime.GOOS == "windows" {
		return windowsProcessAlive(pid)
	}
	return exec.Command("kill", "-0", strconv.Itoa(pid)).Run() == nil
}

// requestServerShutdown 通过管理端点请求进程自己退出（Windows 的 graceful-stop）。
func requestServerShutdown(ctx context.Context, port int, managementKey string) error {
	key := strings.TrimSpace(managementKey)
	if key == "" {
		return fmt.Errorf("management key 不可用，无法请求优雅退出")
	}
	endpoint := fmt.Sprintf("http://127.0.0.1:%d/v0/management/shutdown", port)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, nil)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+key)
	client := &http.Client{Timeout: 10 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode != http.StatusAccepted && response.StatusCode != http.StatusOK {
		return fmt.Errorf("关闭端点返回 %d", response.StatusCode)
	}
	return nil
}

// serverReadyTimeout 覆盖本地服务从拉起到开始监听 /readyz 的耗时。
// Windows 首次启动要建库、跑扫描，可能明显慢于 macOS/Linux，预算放宽到 240s；
// 其余平台 90s 足够（就绪判定只看进程是否应答，不等账号/目录预热）。
var serverReadyTimeout = func() time.Duration {
	if goruntime.GOOS == "windows" {
		return 240 * time.Second
	}
	return 90 * time.Second
}()

func waitServerReady(ctx context.Context, port int, timeout time.Duration) bool {
	_, ready := waitServerReadyOwned(ctx, port, "", 0, timeout, nil)
	return ready
}

// waitServerReadyOwned 等 /readyz 通过，并在已知受管 pid 时要求应答者就是那个
// 进程。返回实际观察到的 pid（可能为 0）。wantPID<=0 时退化为纯就绪探测。
// out 非空时，等待超过几秒会打印一行进度，避免"看起来卡住"。
func waitServerReadyOwned(
	ctx context.Context,
	port int,
	home string,
	wantPID int,
	timeout time.Duration,
	out io.Writer,
) (int, bool) {
	start := time.Now()
	deadline := start.Add(timeout)
	announced := false
	observed := 0
	for {
		ready := serverReady(ctx, port)
		if ready {
			observed = 0
			if home != "" {
				observed = serverPID(home)
			}
			if wantPID <= 0 || observed == wantPID {
				return observed, true
			}
		}
		if !announced && out != nil && time.Since(start) > 3*time.Second {
			announced = true
			_, _ = fmt.Fprintf(out, "[aih] waiting for /readyz on port %d...\n", port)
		}
		if time.Now().After(deadline) {
			return observed, false
		}
		select {
		case <-ctx.Done():
			return observed, false
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func serverReady(ctx context.Context, port int) bool {
	client := &http.Client{Timeout: 2 * time.Second}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/readyz", port), nil)
	if err != nil {
		return false
	}
	response, err := client.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false
	}
	var payload map[string]any
	if json.NewDecoder(response.Body).Decode(&payload) != nil {
		return false
	}
	// 只看"进程在服务"，不看 ready：/readyz 的 ready 语义是"至少一个 Provider
	// 有启用账号"，空 home（全新安装、还没导入账号）永远 ready=false。把它当成
	// 启动失败会让 start/restart 在服务明明已经监听的情况下空等超时（真机：
	// 全新 home 上 start 报 90s 超时，紧接着 /readyz 已是 200）。
	if ok, _ := payload["ok"].(bool); !ok {
		return false
	}
	return true
}

func serverPID(home string) int {
	raw, err := os.ReadFile(filepath.Join(home, "run", "go-server-runtime.json"))
	if err != nil || len(raw) > 64*1024 {
		return 0
	}
	var identity map[string]any
	if json.Unmarshal(raw, &identity) != nil {
		return 0
	}
	if pid, ok := identity["pid"].(float64); ok {
		return int(pid)
	}
	return 0
}
