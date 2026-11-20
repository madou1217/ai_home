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
	"github.com/madou1217/ai_home/internal/runtime/serverprobe"
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
	// 重启/停止默认强制：立即换进程，不等在跑的会话（脚本/自动化要的就是这个）。
	// 只有显式 --graceful 才切 drain、等存量推理流清零（类似 nginx 的平滑重启）。
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
			case "stop":
				message = "server stop 只接受 --graceful / --force"
			case "restart":
				message = "server restart 只接受 --graceful / --force"
			default:
				message = "server status does not accept serve options"
			}
			_, _ = fmt.Fprintf(runtime.stderr, "\x1b[31m[aih] %s\x1b[0m\n", message)
			return true, cliExitCode{code: 1}
		}
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
		if graceful {
			if err := drainBeforeStop(ctx, port, options, runtime); err != nil {
				return true, err
			}
			if goruntime.GOOS == "windows" {
				if err := requestServerShutdown(ctx, port, resolveManagementKey(options.Home)); err == nil {
					_ = waitServerStopped(ctx, port, gracefulStopTimeout)
				}
			}
		}
		if err := autostart.Stop(ctx, options); err != nil {
			return true, err
		}
		_, _ = fmt.Fprintln(runtime.stdout, "[aih] server stopped")
	case "restart":
		// 默认强制重启：立即换进程，不等在跑的会话（脚本/自动化要的就是这个）。
		// --graceful 才切 drain、等存量推理流清零后再换。
		managementKey := resolveManagementKey(options.Home)
		if graceful {
			if err := drainBeforeStop(ctx, port, options, runtime); err != nil {
				return true, err
			}
		}
		var status autostart.Status
		var installErr error
		if goruntime.GOOS == "windows" && graceful {
			// Windows 没有信号：用管理端点请进程自己退出（走收尾窗口），再拉起任务。
			if err := requestServerShutdown(ctx, port, managementKey); err != nil {
				return true, err
			}
			if !waitServerStopped(ctx, port, gracefulStopTimeout) {
				return true, fmt.Errorf("server did not stop within %s after graceful shutdown request", gracefulStopTimeout)
			}
			if startErr := autostart.Start(ctx, options); startErr != nil {
				return true, startErr
			}
			status, _ = autostart.StatusFor(ctx, options)
		} else {
			status, installErr = autostart.Restart(ctx, options, !graceful)
		}
		if installErr != nil {
			if graceful {
				_ = serverprobe.CancelDrain(ctx, port, managementKey)
			}
			return true, installErr
		}
		// 作业注册成功不代表已经能服务：启动装配还需要时间，调用方紧接着发请求
		// 会拿到 connection refused。这里等到 /readyz 真正通过再报成功，并且要求
		// 应答的进程就是刚拉起的那个 pid —— 否则端口被另一个（手工启动的）
		// aih-server 占着时，会把"旧进程还在应答"误报成重启成功。
		expectedPID := status.PID
		if expectedPID <= 0 {
			if latest, statusErr := autostart.StatusFor(ctx, options); statusErr == nil {
				expectedPID = latest.PID
			}
		}
		observedPID, ready := waitServerReadyOwned(ctx, port, options.Home, expectedPID, serverReadyTimeout, runtime.stdout)
		if !ready {
			if expectedPID > 0 && observedPID > 0 && observedPID != expectedPID {
				return true, fmt.Errorf("server restarted but port %d is answered by pid %d, not the supervised pid %d; another aih-server holds the port", port, observedPID, expectedPID)
			}
			return true, fmt.Errorf("server restarted but /readyz did not answer on port %d within %s", port, serverReadyTimeout)
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

// gracefulDrainWait 是 --graceful 模式等存量推理流清零的上限；超时则报错，
// 让调用方明确选择 --force，而不是无限期卡住。
const gracefulDrainWait = 300 * time.Second

// gracefulStopTimeout 是请求服务端优雅退出后等进程消失的上限。
const gracefulStopTimeout = 60 * time.Second

// drainBeforeStop 让服务端先停止接收新推理，等存量流跑完。默认（强制）不走这里。
func drainBeforeStop(ctx context.Context, port int, options autostart.Options, runtime commandRuntime) error {
	managementKey := resolveManagementKey(options.Home)
	active, drainErr := serverprobe.BeginDrain(ctx, port, managementKey)
	drained := drainErr == nil
	if drainErr != nil {
		// 旧服务端没有 drain 端点：退回只读计数，至少别在活跃时盲切。
		active = serverprobe.ActiveInference(ctx, port)
	}
	if active <= 0 {
		return nil
	}
	_, _ = fmt.Fprintf(runtime.stdout, "[aih] waiting for %d active inference stream(s) (max %s; use --force to skip)\n", active, gracefulDrainWait)
	deadline := time.Now().Add(gracefulDrainWait)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			if drained {
				_ = serverprobe.CancelDrain(ctx, port, managementKey)
			}
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
		active = serverprobe.ActiveInference(ctx, port)
		if active <= 0 {
			return nil
		}
	}
	if drained {
		_ = serverprobe.CancelDrain(ctx, port, managementKey)
	}
	return fmt.Errorf("still %d active inference stream(s) after %s; retry later or run without --graceful to restart immediately", active, gracefulDrainWait)
}

// serverReadyTimeout 覆盖本地服务完整装配（数据面 + 后台 worker）的耗时。
const serverReadyTimeout = 90 * time.Second

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
