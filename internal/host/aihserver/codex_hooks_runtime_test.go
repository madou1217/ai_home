package aihserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
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
