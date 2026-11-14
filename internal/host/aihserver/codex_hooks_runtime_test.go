package aihserver

import (
	"bytes"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	goruntime "runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/codexhooks"
	"github.com/madou1217/ai_home/internal/runtime/sessionevents"
	"github.com/madou1217/ai_home/internal/transport/http/codexappserverapi"
)

type codexHooksTestAuthorizer struct {
	allow bool
}

func (a codexHooksTestAuthorizer) Authorized(*http.Request) bool { return a.allow }

func TestBuildWebUICodexHooksRoutes(t *testing.T) {
	t.Parallel()

	t.Run("缺少鉴权器时拒绝装配", func(t *testing.T) {
		t.Parallel()
		_, err := buildWebUICodexHooksRoutes(webuiRouteDependencies{
			AIHomeDir:   t.TempDir(),
			HostHomeDir: t.TempDir(),
		})
		if err == nil {
			t.Fatal("缺少 Authorizer 时应当返回错误")
		}
	})

	t.Run("ServeMux 路由注册与未授权拒绝及快照响应正常", func(t *testing.T) {
		t.Parallel()
		aiHomeDir := t.TempDir()
		hostHomeDir := t.TempDir()

		unauthRoutes, err := buildWebUICodexHooksRoutes(webuiRouteDependencies{
			Authorizer:  codexHooksTestAuthorizer{allow: false},
			AIHomeDir:   aiHomeDir,
			HostHomeDir: hostHomeDir,
		})
		if err != nil {
			t.Fatalf("buildWebUICodexHooksRoutes(unauth) error = %v", err)
		}
		muxUnauth := http.NewServeMux()
		for _, r := range unauthRoutes {
			muxUnauth.Handle(r.Pattern, r.Handler)
		}
		req401 := httptest.NewRequest(http.MethodGet, codexHooksStatusPath, nil)
		rec401 := httptest.NewRecorder()
		muxUnauth.ServeHTTP(rec401, req401)
		if rec401.Code != http.StatusUnauthorized {
			t.Fatalf("未授权状态码 = %d, want 401", rec401.Code)
		}

		routes, err := buildWebUICodexHooksRoutes(webuiRouteDependencies{
			Authorizer:  codexHooksTestAuthorizer{allow: true},
			AIHomeDir:   aiHomeDir,
			HostHomeDir: hostHomeDir,
		})
		if err != nil {
			t.Fatalf("buildWebUICodexHooksRoutes(auth) error = %v", err)
		}
		if len(routes) != 1 || routes[0].Pattern != "GET "+codexHooksStatusPath {
			t.Fatalf("unexpected routes: %+v", routes)
		}
		mux := http.NewServeMux()
		for _, r := range routes {
			mux.Handle(r.Pattern, r.Handler)
		}
		req := httptest.NewRequest(http.MethodGet, codexHooksStatusPath, nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("已授权状态码 = %d, want 200, body=%s", rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-store" {
			t.Fatalf("Cache-Control = %q, want no-store", got)
		}
		var payload map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Fatalf("unmarshal status JSON: %v", err)
		}
		if payload["ok"] != true {
			t.Fatalf("payload.ok = %v, want true", payload["ok"])
		}
		wantQueue := codexhooks.ResolveNotificationQueuePath(aiHomeDir)
		if payload["notificationQueuePath"] != wantQueue {
			t.Fatalf("notificationQueuePath = %v, want %q", payload["notificationQueuePath"], wantQueue)
		}
	})
}

func TestCodexHooksRuntimeLifecycleAndProxies(t *testing.T) {
	t.Parallel()

	aiHomeDir := t.TempDir()
	hostHomeDir := t.TempDir()
	binDir := filepath.Join(hostHomeDir, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatalf("mkdir bin: %v", err)
	}
	cliTarget := filepath.Join(binDir, "codex")
	if err := os.WriteFile(cliTarget, []byte("#!/bin/sh\necho fake-codex\n"), 0o755); err != nil {
		t.Fatalf("write fake codex binary: %v", err)
	}

	extRoot := filepath.Join(hostHomeDir, ".vscode", "extensions")
	extCodex := filepath.Join(extRoot, "openai.chatgpt-0.1.0", "bin", "macos-arm64", "codex")
	if err := os.MkdirAll(filepath.Dir(extCodex), 0o755); err != nil {
		t.Fatalf("mkdir vscode ext: %v", err)
	}
	if err := os.WriteFile(extCodex, []byte("#!/bin/sh\necho fake-vscode-codex\n"), 0o755); err != nil {
		t.Fatalf("write fake vscode codex: %v", err)
	}

	bus := sessionevents.NewBus(sessionevents.BusOptions{
		AIHomeDir:   aiHomeDir,
		HostHomeDir: hostHomeDir,
	})
	allowSys := false
	var mu sync.Mutex
	var logs []string
	appendLog := func(msg string) {
		mu.Lock()
		logs = append(logs, msg)
		mu.Unlock()
	}

	runtime, err := startCodexHooksDaemons(codexHooksDaemonOptions{
		AIHomeDir:                aiHomeDir,
		HostHomeDir:              hostHomeDir,
		EnableCLIHook:            true,
		EnableDesktopHook:        true,
		EnableVscodeHook:         true,
		EnableNotificationBridge: true,
		AllowSystemApplications:  &allowSys,
		ExtensionRoots:           []string{extRoot},
		PathEnv:                  binDir,
		TempDir:                  filepath.Join(aiHomeDir, "tmp"),
		SessionEventBus:          bus,
		LogInfo:                  appendLog,
		LogWarn:                  appendLog,
	})
	if err != nil {
		t.Fatalf("startCodexHooksDaemons() error = %v", err)
	}
	defer func() {
		if closeErr := runtime.Close(); closeErr != nil {
			t.Fatalf("runtime.Close() error = %v", closeErr)
		}
		if closeErr := runtime.Close(); closeErr != nil {
			t.Fatalf("idempotent runtime.Close() error = %v", closeErr)
		}
	}()

	if runtime.CLIService() == nil || runtime.DesktopService() == nil ||
		runtime.VscodeService() == nil || runtime.NotificationBridge() == nil {
		t.Fatal("期望所有子服务实例均已初始化")
	}

	// 验证 CLI wrapper 与 VSCode wrapper 均已安装到隔离测试目录。
	cliContent, err := os.ReadFile(cliTarget)
	if err != nil {
		t.Fatalf("read cli target: %v", err)
	}
	if !strings.Contains(string(cliContent), codexhooks.WrapperMarkerCLI) {
		t.Fatalf("CLI wrapper 缺少标记: %s", string(cliContent))
	}
	recheck := runtime.EnsureCLIInstalled()
	if !recheck.OK {
		t.Fatalf("EnsureCLIInstalled() = %+v", recheck)
	}

	// 验证带运行态的 status 路由返回 selfHeal 字段。
	routes, err := buildWebUICodexHooksRoutesWithRuntime(webuiRouteDependencies{
		Authorizer:  codexHooksTestAuthorizer{allow: true},
		AIHomeDir:   aiHomeDir,
		HostHomeDir: hostHomeDir,
	}, runtime)
	if err != nil {
		t.Fatalf("buildWebUICodexHooksRoutesWithRuntime() error = %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, codexHooksStatusPath, nil)
	rec := httptest.NewRecorder()
	routes[0].Handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status route code = %d", rec.Code)
	}
	var statusBody map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &statusBody); err != nil {
		t.Fatalf("unmarshal runtime status: %v", err)
	}
	selfHeal, ok := statusBody["selfHeal"].(map[string]any)
	if !ok || selfHeal["cli"] == nil || selfHeal["vscode"] == nil {
		t.Fatalf("selfHeal 状态不完整: %+v", statusBody["selfHeal"])
	}

	// 验证 app-server 代理、remote-control 代理及 WS 升级路径识别构造。
	appHandler, err := newCodexAppServerProxyHandler(codexHooksTestAuthorizer{allow: true}, aiHomeDir, hostHomeDir, nil)
	if err != nil || appHandler == nil {
		t.Fatalf("newCodexAppServerProxyHandler() = (%v, %v)", appHandler, err)
	}
	remoteHandler, err := newCodexRemoteControlProxyHandler("https://chatgpt.example.com", "", nil)
	if err != nil || remoteHandler == nil {
		t.Fatalf("newCodexRemoteControlProxyHandler() = (%v, %v)", remoteHandler, err)
	}

	wsReq := httptest.NewRequest(http.MethodGet, codexappserverapi.AppServerProxyPath, nil)
	wsReq.Header.Set("Upgrade", "websocket")
	wsReq.Header.Set("Connection", "Upgrade")
	if !shouldDispatchCodexAppServerUpgrade(wsReq) {
		t.Fatal("应当识别 /v0/codex/app-server WebSocket 升级请求")
	}
	nonWSReq := httptest.NewRequest(http.MethodGet, codexappserverapi.AppServerProxyPath, nil)
	if shouldDispatchCodexAppServerUpgrade(nonWSReq) {
		t.Fatal("普通 HTTP GET 不应被误判为 WebSocket 升级请求")
	}

	// 验证 NotificationBridge 正在运行且能在合理时间内关闭。
	done := make(chan struct{})
	go func() {
		_ = runtime.Close()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("runtime.Close() 超时")
	}
	mu.Lock()
	logCount := len(logs)
	mu.Unlock()
	if logCount == 0 {
		t.Fatal("期望运行时产生启动日志")
	}
}

func TestBuildCodexHooksDaemonOptions(t *testing.T) {
	t.Parallel()

	t.Run("默认值、receiver URL 派生与 EntryFilePath 解析 HelperScript", func(t *testing.T) {
		t.Parallel()
		repoDir := t.TempDir()
		entryPath := filepath.Join(repoDir, "bin", "ai-home.js")
		helperPath := filepath.Join(repoDir, "lib", "server", "codex-app-server-stdio-proxy.js")
		if err := os.MkdirAll(filepath.Dir(entryPath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Dir(helperPath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(entryPath, []byte("// entry"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(helperPath, []byte("// helper"), 0o644); err != nil {
			t.Fatal(err)
		}

		var logBuf bytes.Buffer
		logger := log.New(&logBuf, "", 0)
		bus := sessionevents.NewBus(sessionevents.BusOptions{AIHomeDir: filepath.Join(repoDir, "ai_home")})

		opts := buildCodexHooksDaemonOptions(
			Options{
				CodexHooks: CodexHooksOptions{
					EnableCLIHook:     true,
					EnableDesktopHook: true,
					NodeExecPath:      "/custom/bin/node",
					EntryFilePath:     entryPath,
				},
			},
			filepath.Join(repoDir, "ai_home"),
			"http://127.0.0.1:9527/",
			bus,
			logger,
		)

		if !opts.EnableCLIHook || !opts.EnableDesktopHook || !opts.EnableVscodeHook || !opts.EnableNotificationBridge {
			t.Fatalf("预期 Desktop 联动开启 VSCode 且默认开启 NotificationBridge: %+v", opts)
		}
		if opts.CLISelfHealInterval != 15*time.Second || opts.DesktopSelfHealInterval != 15*time.Second {
			t.Fatalf("默认自愈间隔应为 15s, 实际 cli=%v desktop=%v", opts.CLISelfHealInterval, opts.DesktopSelfHealInterval)
		}
		wantReceiver := "http://127.0.0.1:9527/v0/webui/session-events/provider-hook"
		if opts.ProviderHookReceiverURL != wantReceiver {
			t.Fatalf("ProviderHookReceiverURL = %q, want %q", opts.ProviderHookReceiverURL, wantReceiver)
		}
		if opts.NodeExecPath != "/custom/bin/node" || opts.HelperScriptPath != helperPath {
			t.Fatalf("NodeExecPath=%q HelperScriptPath=%q, want helper=%q", opts.NodeExecPath, opts.HelperScriptPath, helperPath)
		}
		if opts.TraceConfig == nil || !opts.TraceConfig.TraceRemoteControl || !opts.TraceConfig.RemoteControlProxy || opts.TraceConfig.TraceResponses {
			t.Fatalf("默认 TraceConfig 不符预期: %+v", opts.TraceConfig)
		}
		opts.LogInfo("info-msg")
		opts.LogWarn("warn-msg")
		if !strings.Contains(logBuf.String(), "info-msg") || !strings.Contains(logBuf.String(), "warn-msg") {
			t.Fatalf("LogInfo/LogWarn 未写入 logger: %q", logBuf.String())
		}
	})

	t.Run("显式覆盖 Trace、VSCode 独立开关、间隔钳位与 ReceiverURL", func(t *testing.T) {
		t.Parallel()
		disableFalse := false
		opts := buildCodexHooksDaemonOptions(
			Options{
				AIHomeDir:   "/tmp/ai_home",
				NodeBaseURL: "http://127.0.0.1:9527",
				CodexHooks: CodexHooksOptions{
					EnableDesktopHook:            true,
					EnableVscodeHook:             &disableFalse,
					CLISelfHealInterval:          200 * time.Millisecond,
					DesktopSelfHealInterval:      2 * time.Second,
					ProviderHookReceiverURL:      "http://127.0.0.1:19999/custom-hook",
					TraceFile:                    "/tmp/custom-trace.jsonl",
					TraceResponses:               true,
					TraceRemoteControl:           &disableFalse,
					RemoteControlProxy:           &disableFalse,
					RestartAppServerOnHookChange: true,
					HelperScriptPath:             "/opt/helper.js",
				},
			},
			"",
			"",
			nil,
			nil,
		)

		if !opts.EnableDesktopHook || opts.EnableVscodeHook {
			t.Fatalf("显式关闭 VSCode 开关应生效: %+v", opts)
		}
		if opts.CLISelfHealInterval != minCodexHooksSelfHealInterval || opts.DesktopSelfHealInterval != 2*time.Second {
			t.Fatalf("间隔钳位/透传错误: cli=%v desktop=%v", opts.CLISelfHealInterval, opts.DesktopSelfHealInterval)
		}
		if opts.ProviderHookReceiverURL != "http://127.0.0.1:19999/custom-hook" {
			t.Fatalf("显式 ReceiverURL 被覆盖: %q", opts.ProviderHookReceiverURL)
		}
		if opts.TraceConfig == nil || opts.TraceConfig.TraceFile != "/tmp/custom-trace.jsonl" ||
			!opts.TraceConfig.TraceResponses || opts.TraceConfig.TraceRemoteControl || opts.TraceConfig.RemoteControlProxy {
			t.Fatalf("显式 TraceConfig 不符预期: %+v", opts.TraceConfig)
		}
		if !opts.RestartAppServerOnHookChange || opts.AIHomeDir != "/tmp/ai_home" {
			t.Fatalf("RestartAppServerOnHookChange 或 AIHomeDir fallback 异常: %+v", opts)
		}
	})
}

func TestCodexHooksRuntimeTraceConfigAndRestartAndSelfHeal(t *testing.T) {
	if goruntime.GOOS != "darwin" {
		t.Skip("Desktop Hook bundle 激活测试仅针对 macOS 平台")
	}
	t.Parallel()

	root := t.TempDir()
	aiHome := filepath.Join(root, "ai_home")
	hostHome := filepath.Join(root, "host_home")
	helper := filepath.Join(root, "helper.js")
	if err := os.WriteFile(helper, []byte("// helper v1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	bundlePath := filepath.Join(hostHome, "Applications", "Codex.app")
	targetBin := filepath.Join(bundlePath, "Contents", "Resources", "codex")
	if err := os.MkdirAll(filepath.Dir(targetBin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(targetBin, []byte("#!/bin/sh\necho upstream-desktop-codex\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	layouts := []codexhooks.DesktopLayout{
		{
			ID:            "test-in-place",
			Platform:      "darwin",
			BinarySubpath: filepath.Join("Contents", "Resources", "codex"),
		},
	}
	allowSys := false
	desktopMain := filepath.Join(bundlePath, "Contents", "MacOS", "Codex")
	fakeProcs := []codexhooks.ProcessInfo{
		{PID: 101, ParentPID: 1, Command: desktopMain},
		{PID: 202, ParentPID: 101, Command: targetBin + " app-server --listen stdio://"},
	}

	var killMu sync.Mutex
	var killedPIDs []int
	recordKill := func(pid int) error {
		killMu.Lock()
		killedPIDs = append(killedPIDs, pid)
		killMu.Unlock()
		return nil
	}
	getKills := func() []int {
		killMu.Lock()
		defer killMu.Unlock()
		out := make([]int, len(killedPIDs))
		copy(out, killedPIDs)
		return out
	}
	clearKills := func() {
		killMu.Lock()
		killedPIDs = nil
		killMu.Unlock()
	}

	var logMu sync.Mutex
	var infoLogs []string
	appendInfo := func(msg string) {
		logMu.Lock()
		infoLogs = append(infoLogs, msg)
		logMu.Unlock()
	}

	// 1) 首次激活：写入 trace 默认配置并因 RestartRequired=true 重启运行中 app-server。
	rt1, err := startCodexHooksDaemons(codexHooksDaemonOptions{
		AIHomeDir:                    aiHome,
		HostHomeDir:                  hostHome,
		EnableDesktopHook:            true,
		EnableVscodeHook:             false,
		AllowSystemApplications:      &allowSys,
		DesktopRuntimeLayouts:        layouts,
		NodeExecPath:                 "/usr/local/bin/node",
		HelperScriptPath:             helper,
		ProviderHookReceiverURL:      "http://127.0.0.1:9527/v0/webui/session-events/provider-hook",
		DesktopSelfHealInterval:      10 * time.Second,
		RestartAppServerOnHookChange: false,
		TraceConfig: &codexhooks.DesktopTraceConfig{
			TraceRemoteControl: true,
			RemoteControlProxy: true,
		},
		ReadBundleMetadata: func(string) codexhooks.BundleMetadata {
			return codexhooks.BundleMetadata{AppVersion: "1.0.0", AppBuildVersion: "10"}
		},
		ReadCodexVersion: func(string) string { return "0.99.0" },
		ListProcesses:    func() ([]codexhooks.ProcessInfo, error) { return fakeProcs, nil },
		KillProcess:      recordKill,
		LogInfo:          appendInfo,
		LogWarn:          appendInfo,
	})
	if err != nil {
		t.Fatalf("startCodexHooksDaemons(1) error = %v", err)
	}
	_ = rt1.Close()

	kills1 := getKills()
	if len(kills1) != 1 || kills1[0] != 202 {
		t.Fatalf("首次安装 wrapper 应触发 app-server 重启 pid=202, 实际 %v", kills1)
	}
	state1 := rt1.DesktopService().ReadState()
	wantDefaultTrace := filepath.Join(aiHome, "logs", "codex", "mobile-trace.jsonl")
	if !state1.Enabled || !state1.TraceRemoteControl || !state1.RemoteControlProxy ||
		state1.TraceFile != wantDefaultTrace ||
		state1.ProviderHookReceiverURL != "http://127.0.0.1:9527/v0/webui/session-events/provider-hook" {
		t.Fatalf("DesktopHookState 未持久化默认 Trace/ReceiverURL: %+v", state1)
	}

	// 2) wrapper 健康且仅修改 Trace，策略为 false 时更新状态但不重启 app-server。
	clearKills()
	logMu.Lock()
	infoLogs = nil
	logMu.Unlock()
	customTrace1 := filepath.Join(root, "trace-1.jsonl")
	rt2, err := startCodexHooksDaemons(codexHooksDaemonOptions{
		AIHomeDir:                    aiHome,
		HostHomeDir:                  hostHome,
		EnableDesktopHook:            true,
		AllowSystemApplications:      &allowSys,
		DesktopRuntimeLayouts:        layouts,
		NodeExecPath:                 "/usr/local/bin/node",
		HelperScriptPath:             helper,
		ProviderHookReceiverURL:      "http://127.0.0.1:9527/v0/webui/session-events/provider-hook",
		DesktopSelfHealInterval:      10 * time.Second,
		RestartAppServerOnHookChange: false,
		TraceConfig: &codexhooks.DesktopTraceConfig{
			TraceFile:          customTrace1,
			TraceResponses:     true,
			TraceRemoteControl: true,
			RemoteControlProxy: true,
		},
		ReadBundleMetadata: func(string) codexhooks.BundleMetadata {
			return codexhooks.BundleMetadata{AppVersion: "1.0.0", AppBuildVersion: "10"}
		},
		ReadCodexVersion: func(string) string { return "0.99.0" },
		ListProcesses:    func() ([]codexhooks.ProcessInfo, error) { return fakeProcs, nil },
		KillProcess:      recordKill,
		LogInfo:          appendInfo,
		LogWarn:          appendInfo,
	})
	if err != nil {
		t.Fatalf("startCodexHooksDaemons(2) error = %v", err)
	}
	_ = rt2.Close()

	if kills2 := getKills(); len(kills2) != 0 {
		t.Fatalf("RestartAppServerOnHookChange=false 且 wrapper 无漂移时不应杀进程, 实际 %v", kills2)
	}
	state2 := rt2.DesktopService().ReadState()
	if !state2.TraceResponses || state2.TraceFile != customTrace1 {
		t.Fatalf("TraceConfig 更新未落盘: %+v", state2)
	}
	logMu.Lock()
	joinedLogs := strings.Join(infoLogs, "\n")
	logMu.Unlock()
	if !strings.Contains(joinedLogs, "reload disabled by hook change policy") {
		t.Fatalf("期望记录 reload disabled 日志, 实际:\n%s", joinedLogs)
	}

	// 3) RestartAppServerOnHookChange=true 且验证自愈漂移修复后重新应用 Trace 并重启 app-server。
	clearKills()
	customTrace2 := filepath.Join(root, "trace-2.jsonl")
	rt3, err := startCodexHooksDaemons(codexHooksDaemonOptions{
		AIHomeDir:                    aiHome,
		HostHomeDir:                  hostHome,
		EnableDesktopHook:            true,
		AllowSystemApplications:      &allowSys,
		DesktopRuntimeLayouts:        layouts,
		NodeExecPath:                 "/usr/local/bin/node",
		HelperScriptPath:             helper,
		ProviderHookReceiverURL:      "http://127.0.0.1:9527/v0/webui/session-events/provider-hook",
		DesktopSelfHealInterval:      1 * time.Second,
		RestartAppServerOnHookChange: true,
		TraceConfig: &codexhooks.DesktopTraceConfig{
			TraceFile:          customTrace2,
			TraceResponses:     false,
			TraceRemoteControl: true,
			RemoteControlProxy: true,
		},
		ReadBundleMetadata: func(string) codexhooks.BundleMetadata {
			return codexhooks.BundleMetadata{AppVersion: "1.0.0", AppBuildVersion: "10"}
		},
		ReadCodexVersion: func(string) string { return "0.99.0" },
		ListProcesses:    func() ([]codexhooks.ProcessInfo, error) { return fakeProcs, nil },
		KillProcess:      recordKill,
		LogInfo:          appendInfo,
		LogWarn:          appendInfo,
	})
	if err != nil {
		t.Fatalf("startCodexHooksDaemons(3) error = %v", err)
	}
	defer rt3.Close()

	if kills3 := getKills(); len(kills3) != 1 || kills3[0] != 202 {
		t.Fatalf("RestartAppServerOnHookChange=true 时 Trace 变更应触发重启, 实际 %v", kills3)
	}

	// 模拟客户端升级覆盖了包装器，等待 1s 自愈循环修复并再次重启 app-server。
	clearKills()
	if err := os.WriteFile(targetBin, []byte("#!/bin/sh\necho upstream-upgraded\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(4 * time.Second)
	repaired := false
	for time.Now().Before(deadline) {
		body, readErr := os.ReadFile(targetBin)
		killsRepair := getKills()
		if readErr == nil && strings.Contains(string(body), codexhooks.WrapperMarkerDesktop) && len(killsRepair) > 0 {
			repaired = true
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !repaired {
		body, _ := os.ReadFile(targetBin)
		t.Fatalf("自愈循环未在预期时间内修复 wrapper 并重启 app-server, kills=%v, target=%s", getKills(), string(body))
	}
	if err := rt3.Close(); err != nil {
		t.Fatalf("rt3.Close() error = %v", err)
	}
}
