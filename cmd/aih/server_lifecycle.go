package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/serverconfig"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/autostart"
)

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
	// 生命周期只有强制一种语义：立即结束旧进程再拉起。
	//
	// 平滑模式（切服务端 drain、CLI 侧只读等待、SIGTERM 收尾等待）已按用户要求
	// 整体移除：等待期间重启被无限期后延，客户端与 WebUI 无法区分“在重启”和
	// “服务坏了”（2026-11-21 实测回归）。不接受任何选项。
	for range arguments[2:] {
		var message string
		switch action {
		case "start":
			message = "server start does not accept serve options; update server config first"
		case "stop", "restart":
			message = "server " + action + " 不接受选项：只支持强制重启/停止（立即结束进程）"
		default:
			message = "server status does not accept serve options"
		}
		_, _ = fmt.Fprintf(runtime.stderr, "\x1b[31m[aih] %s\x1b[0m\n", message)
		return true, cliExitCode{code: 1}
	}
	options, err := resolveAutostartOptions(runtime)
	if err != nil {
		return true, err
	}
	port := resolveServerPort(ctx, options.Home, runtime)
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
		if goruntime.GOOS == "windows" {
			windowsStopService(ctx, options)
		} else if err := autostart.Stop(ctx, options); err != nil {
			return true, err
		}
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] server stopped")
	case "restart":
		previousPID := serverPID(options.Home)
		var status autostart.Status
		var installErr error
		if goruntime.GOOS == "windows" {
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
		// 会拿到 connection refused。这里等到 /readyz 真正通过再报成功，并且要求
		// 应答的进程就是刚拉起的那个 pid —— 否则端口被另一个（手工启动的）
		// aih-server 占着时，会把"旧进程还在应答"误报成重启成功。
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
		_, _ = fmt.Fprintf(runtime.stdout, "[aih] server restarted (port=%d, pid=%d, strategy=%s)\n", port, observedPID, status.Strategy)
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
// serverReadyTimeout 覆盖本地服务完整装配的耗时。Windows 上首次启动要建库、
// 跑扫描，实测超过 90s 才把 ready 置真；预算太短会把“重启成功但还在预热”
// 误报成失败（2026-11-21 真机：restart 90s 超时，紧接着 readyz 已 200）。
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
	ready, _ := payload["ready"].(bool)
	return ready
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
