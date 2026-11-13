package webuitoolkitcoreapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/apps"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/mirrors"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/network"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/tools"
	"github.com/madou1217/ai_home/internal/transport/http/webuiopenappapi"
)

type stubAuth bool

func (a stubAuth) Authorized(*http.Request) bool { return bool(a) }

type stubExec struct {
	mu      sync.Mutex
	calls   []string
	handler func(ctx context.Context, command string, args []string, opts environment.ExecOptions) environment.RunResult
}

func (s *stubExec) Run(ctx context.Context, command string, args []string, opts environment.ExecOptions) environment.RunResult {
	s.mu.Lock()
	s.calls = append(s.calls, command+" "+strings.Join(args, " "))
	s.mu.Unlock()
	if s.handler != nil {
		return s.handler(ctx, command, args, opts)
	}
	return environment.RunResult{OK: true}
}

type stubLauncher struct {
	lastReq webuiopenappapi.Request
	result  webuiopenappapi.Result
	err     error
}

func (s *stubLauncher) Launch(_ context.Context, req webuiopenappapi.Request) (webuiopenappapi.Result, error) {
	s.lastReq = req
	return s.result, s.err
}

func doHTTP(t *testing.T, h http.Handler, method, target, body string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != "" {
		reader = bytes.NewReader([]byte(body))
	} else {
		reader = bytes.NewReader(nil)
	}
	req := httptest.NewRequest(method, target, reader)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeMap(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &m); err != nil {
		t.Fatalf("decode json (%s): %v", rec.Body.String(), err)
	}
	return m
}

func TestNewHandlerFailClosedAndAuth(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); err == nil {
		t.Fatal("expected NewHandler to fail without Authorizer")
	}
	h, err := NewHandler(Dependencies{Authorizer: stubAuth(false)})
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	rec := doHTTP(t, h, http.MethodGet, MirrorsPath, "")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d (%s)", rec.Code, rec.Body.String())
	}
}

func TestMirrorsProxyAndConnectivityRoutes(t *testing.T) {
	execStub := &stubExec{
		handler: func(_ context.Context, command string, args []string, _ environment.ExecOptions) environment.RunResult {
			line := command + " " + strings.Join(args, " ")
			switch {
			case strings.Contains(line, "npm config get registry"):
				return environment.RunResult{OK: true, Stdout: "https://registry.npmjs.org\n"}
			case strings.Contains(line, "npm config set registry"):
				return environment.RunResult{OK: true}
			case strings.Contains(line, "git config --global --get"):
				return environment.RunResult{OK: true, Stdout: "http://127.0.0.1:7890\n"}
			default:
				return environment.RunResult{OK: true}
			}
		},
	}

	mirrorsMgr := mirrors.NewManager(mirrors.Options{
		Platform: "linux",
		Exec:     execStub,
		ResolveHost: func(_ context.Context, _ string) ([]string, error) {
			return []string{"93.184.216.34"}, nil
		},
		RequestAdapter: func(_ context.Context, _ string, _ time.Duration) (int, error) {
			return 200, nil
		},
	})
	networkMgr := network.NewManager(network.Options{
		GOOS: "linux",
		Exec: execStub,
		ConnectivityAdapter: func(_ context.Context, _ string, _ string, _ string, _ time.Duration) (int, error) {
			return 200, nil
		},
	})

	h, err := NewHandler(Dependencies{
		Authorizer:     stubAuth(true),
		Platform:       "linux",
		Executor:       execStub,
		MirrorsManager: mirrorsMgr,
		NetworkManager: networkMgr,
	})
	if err != nil {
		t.Fatal(err)
	}

	if rec := doHTTP(t, h, http.MethodGet, MirrorsPath, ""); rec.Code != 200 {
		t.Fatalf("GET mirrors: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doHTTP(t, h, http.MethodPost, MirrorsSetPath, `{"type":"bad","url":"https://registry.npmjs.org"}`); rec.Code != 400 || decodeMap(t, rec)["error"] != "invalid_mirror_type" {
		t.Fatalf("POST mirrors/set invalid type: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doHTTP(t, h, http.MethodPost, MirrorsSetPath, `{"type":"npm","url":"https://registry.npmmirror.com"}`); rec.Code != 200 {
		t.Fatalf("POST mirrors/set npm: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doHTTP(t, h, http.MethodPost, MirrorsPingPath, `{}`); rec.Code != 400 || decodeMap(t, rec)["error"] != "url_required" {
		t.Fatalf("POST mirrors/ping empty: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doHTTP(t, h, http.MethodPost, MirrorsPingPath, `{"url":"https://registry.npmjs.org"}`); rec.Code != 200 {
		t.Fatalf("POST mirrors/ping ok: %d %s", rec.Code, rec.Body.String())
	}

	if rec := doHTTP(t, h, http.MethodGet, ProxyPath, ""); rec.Code != 200 {
		t.Fatalf("GET proxy: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doHTTP(t, h, http.MethodPost, ProxySetPath, `{"target":"unknown","proxyUrl":""}`); rec.Code != 400 || decodeMap(t, rec)["error"] != "invalid_proxy_target" {
		t.Fatalf("POST proxy/set invalid: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doHTTP(t, h, http.MethodPost, ProxySetPath, `{"target":"git","proxyUrl":"http://127.0.0.1:7890"}`); rec.Code != 200 {
		t.Fatalf("POST proxy/set ok: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doHTTP(t, h, http.MethodGet, ConnectivityPath+"?route=direct&refresh=1", ""); rec.Code != 200 {
		t.Fatalf("GET connectivity: %d %s", rec.Code, rec.Body.String())
	}
}

func TestManagedToolsServiceAndTerminalsRoutes(t *testing.T) {
	tmp := t.TempDir()
	hostHome := filepath.Join(tmp, "home")
	aiHome := filepath.Join(tmp, "aihome")
	binDir := filepath.Join(tmp, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	frpcBin := filepath.Join(binDir, "frpc")
	if err := os.WriteFile(frpcBin, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	execStub := &stubExec{
		handler: func(_ context.Context, command string, _ []string, _ environment.ExecOptions) environment.RunResult {
			if command == frpcBin {
				return environment.RunResult{OK: true, Stdout: "0.61.0\n"}
			}
			return environment.RunResult{OK: true}
		},
	}

	h, err := NewHandler(Dependencies{
		Authorizer:  stubAuth(true),
		Platform:    "linux",
		Arch:        "amd64",
		HostHomeDir: hostHome,
		AIHomeDir:   aiHome,
		Env:         map[string]string{"HOME": hostHome, "PATH": binDir},
		Executor:    execStub,
		LookPath: func(name string) (string, error) {
			if name == "frpc" {
				return frpcBin, nil
			}
			return "", os.ErrNotExist
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	// Tools list + config CRUD + service confirmation gate + create config + logs.
	if rec := doHTTP(t, h, http.MethodGet, ToolsPath, ""); rec.Code != 200 || decodeMap(t, rec)["ok"] != true {
		t.Fatalf("GET tools: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doHTTP(t, h, http.MethodPost, ToolsExecutePath, `{"toolId":"frpc","action":"install"}`); rec.Code != 428 || decodeMap(t, rec)["error"] != "confirmation_required" {
		t.Fatalf("expected 428 on unconfirmed tools/execute: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doHTTP(t, h, http.MethodGet, "/v1/management/webui/toolkit/tools/frpc/service", ""); rec.Code != 200 {
		t.Fatalf("GET frpc service: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doHTTP(t, h, http.MethodPost, "/v1/management/webui/toolkit/tools/frpc/service", `{"action":"start"}`); rec.Code != 428 {
		t.Fatalf("expected 428 unconfirmed service control: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doHTTP(t, h, http.MethodPost, "/v1/management/webui/toolkit/tools/frpc/service/config", `{}`); rec.Code != 200 {
		t.Fatalf("POST frpc service/config: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doHTTP(t, h, http.MethodPut, "/v1/management/webui/toolkit/tools/frpc/service/settings", `{"autoStart":false,"autoRestart":false}`); rec.Code != 200 {
		t.Fatalf("PUT frpc service/settings: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doHTTP(t, h, http.MethodGet, "/v1/management/webui/toolkit/tools/frpc/service/logs?lines=10", ""); rec.Code != 200 {
		t.Fatalf("GET frpc service/logs: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doHTTP(t, h, http.MethodPut, "/v1/management/webui/toolkit/tools/frpc/config", `{}`); rec.Code != 400 || decodeMap(t, rec)["error"] != "content_required" {
		t.Fatalf("expected 400 content_required: %d %s", rec.Code, rec.Body.String())
	}

	// Terminals list + plan + remote web_terminal_required + execute + SSE watch.
	if rec := doHTTP(t, h, http.MethodGet, TerminalsRootPath, ""); rec.Code != 200 || decodeMap(t, rec)["ok"] != true {
		t.Fatalf("GET /terminals: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doHTTP(t, h, http.MethodGet, ToolkitTerminalsPath, ""); rec.Code != 200 || decodeMap(t, rec)["ok"] != true {
		t.Fatalf("GET /toolkit/terminals: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doHTTP(t, h, http.MethodPost, TerminalsOpenPath, `{"terminalId":"system-default","transport":"webui"}`); rec.Code != 409 || decodeMap(t, rec)["error"] != "web_terminal_required" {
		t.Fatalf("expected 409 web_terminal_required: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doHTTP(t, h, http.MethodPost, TerminalsExecutePath, `{"terminalId":"wezterm","action":"install"}`); rec.Code != 428 {
		t.Fatalf("expected 428 unconfirmed terminals/execute: %d %s", rec.Code, rec.Body.String())
	}

	// Validate real HTTP SSE streaming on terminals job watch via httptest.Server.
	srv := httptest.NewServer(h)
	defer srv.Close()
	execRes := doHTTP(t, h, http.MethodPost, TerminalsExecutePath, `{"terminalId":"wezterm","action":"install","confirmed":true}`)
	if execRes.Code != 202 {
		t.Fatalf("expected 202 terminals/execute, got %d %s", execRes.Code, execRes.Body.String())
	}
	jobID, _ := decodeMap(t, execRes)["job"].(map[string]any)["id"].(string)
	if jobID == "" {
		t.Fatalf("missing job id in %s", execRes.Body.String())
	}
	watchResp, err := http.Get(srv.URL + "/v1/management/webui/toolkit/terminals/jobs/" + jobID + "/watch")
	if err != nil {
		t.Fatal(err)
	}
	defer watchResp.Body.Close()
	if !strings.HasPrefix(watchResp.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("expected SSE content-type, got %q", watchResp.Header.Get("Content-Type"))
	}
	scanner := bufio.NewScanner(watchResp.Body)
	var firstLines []string
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "data: ") {
			firstLines = append(firstLines, line)
			if len(firstLines) >= 2 {
				break
			}
		}
	}
	if len(firstLines) < 2 || !strings.Contains(firstLines[0], `"type":"connected"`) || !strings.Contains(firstLines[1], `"type":"terminal-job"`) {
		t.Fatalf("unexpected SSE frames: %v", firstLines)
	}
}

func TestAppsOpenPlanInstallAndSseWatch(t *testing.T) {
	tmp := t.TempDir()
	hostHome := filepath.Join(tmp, "home")
	aiHome := filepath.Join(tmp, "aihome")
	binDir := filepath.Join(tmp, "bin")

	var installedCli string
	execStub := &stubExec{
		handler: func(_ context.Context, command string, args []string, _ environment.ExecOptions) environment.RunResult {
			if strings.Contains(command, "npm") && len(args) > 0 && args[0] == "install" {
				_ = os.MkdirAll(binDir, 0o755)
				installedCli = filepath.Join(binDir, "codex")
				_ = os.WriteFile(installedCli, []byte("#!/bin/sh\n"), 0o755)
				return environment.RunResult{OK: true}
			}
			if command == installedCli {
				return environment.RunResult{OK: true, Stdout: "codex-cli 1.0.0\n"}
			}
			if strings.Contains(command, "npm") && len(args) > 0 && args[0] == "view" {
				return environment.RunResult{OK: true, Stdout: "2.0.0\n"}
			}
			return environment.RunResult{OK: true}
		},
	}

	// 创建临时 codex 配置文件，测试 GET/PUT /toolkit/apps/{appId}/config。
	codexCfg := filepath.Join(hostHome, ".codex", "config.toml")
	if err := os.MkdirAll(filepath.Dir(codexCfg), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(codexCfg, []byte("model = \"gpt-5\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	launcher := &stubLauncher{
		result: webuiopenappapi.Result{OK: false, Error: "cli_not_installed"},
	}
	lookPathFn := func(name string) (string, error) {
		if name == "codex" && installedCli != "" {
			return installedCli, nil
		}
		return "", os.ErrNotExist
	}

	h, err := NewHandler(Dependencies{
		Authorizer:  stubAuth(true),
		Platform:    "linux",
		Arch:        "amd64",
		NodeVersion: "v22.21.0",
		HostHomeDir: hostHome,
		AIHomeDir:   aiHome,
		Env:         map[string]string{"HOME": hostHome, "PATH": binDir},
		Executor:    execStub,
		LookPath:    lookPathFn,
		AppLauncher: launcher,
		DefaultAccountResolver: func(_ context.Context, provider string) string {
			if provider == "codex" {
				return "acct_default"
			}
			return ""
		},
		AppsBaseOpts: &apps.Options{
			HostHomeDir:      hostHome,
			AIHomeDir:        aiHome,
			Platform:         "linux",
			Arch:             "amd64",
			NodeVersion:      "v22.21.0",
			Env:              map[string]string{"HOME": hostHome, "PATH": binDir},
			Executor:         execStub,
			LookPath:         lookPathFn,
			ProbeVersions:    "sync",
			VerifyRetries:    1,
			VerifyRetryDelay: 0,
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	// 1. GET /toolkit/apps + GET/PUT config + check-update 404 for unknown.
	if rec := doHTTP(t, h, http.MethodGet, AppsPath, ""); rec.Code != 200 || decodeMap(t, rec)["ok"] != true {
		t.Fatalf("GET /apps: %d %s", rec.Code, rec.Body.String())
	}
	cfgGet := doHTTP(t, h, http.MethodGet, "/v1/management/webui/toolkit/apps/codex/config", "")
	if cfgGet.Code != 200 {
		t.Fatalf("GET app config: %d %s", cfgGet.Code, cfgGet.Body.String())
	}
	rev, _ := decodeMap(t, cfgGet)["revision"].(string)
	if cfgPut := doHTTP(t, h, http.MethodPut, "/v1/management/webui/toolkit/apps/codex/config", `{"content":"model = \"gpt-5-codex\"\n","revision":"`+rev+`"}`); cfgPut.Code != 200 {
		t.Fatalf("PUT app config: %d %s", cfgPut.Code, cfgPut.Body.String())
	}
	if rec := doHTTP(t, h, http.MethodPost, "/v1/management/webui/toolkit/apps/nonexistent/check-update", `{}`); rec.Code != 404 {
		t.Fatalf("expected 404 check-update unknown: %d %s", rec.Code, rec.Body.String())
	}

	// 2. Open CLI -> HostLauncher 报错 cli_not_installed 时应返回 428 installRequired + installAvailable=true。
	openMissing := doHTTP(t, h, http.MethodPost, "/v1/management/webui/toolkit/apps/codex/open", `{}`)
	if openMissing.Code != 428 {
		t.Fatalf("expected 428 on cli_not_installed, got %d %s", openMissing.Code, openMissing.Body.String())
	}
	missingBody := decodeMap(t, openMissing)
	if missingBody["installRequired"] != true || missingBody["installAvailable"] != true {
		t.Fatalf("expected installRequired/installAvailable in 428: %+v", missingBody)
	}
	if launcher.lastReq.AccountRef != "acct_default" {
		t.Fatalf("expected default account acct_default resolved, got %q", launcher.lastReq.AccountRef)
	}

	// 3. Plan + invalid empty action + AppInstall start + SSE watch.
	if rec := doHTTP(t, h, http.MethodPost, AppsPlanPath, `{"appId":"codex","action":""}`); rec.Code != 400 || decodeMap(t, rec)["error"] != "invalid_lifecycle_action" {
		t.Fatalf("expected 400 invalid_lifecycle_action on empty action: %d %s", rec.Code, rec.Body.String())
	}
	if rec := doHTTP(t, h, http.MethodPost, AppsPlanPath, `{"appId":"codex"}`); rec.Code != 200 || decodeMap(t, rec)["ok"] != true {
		t.Fatalf("POST /apps/plan: %d %s", rec.Code, rec.Body.String())
	}

	srv := httptest.NewServer(h)
	defer srv.Close()

	startRec := doHTTP(t, h, http.MethodPost, AppInstallPath, `{"appId":"codex","kind":"cli","action":"install"}`)
	if startRec.Code != 202 {
		t.Fatalf("POST /app-install: %d %s", startRec.Code, startRec.Body.String())
	}
	jobID, _ := decodeMap(t, startRec)["job"].(map[string]any)["id"].(string)
	if jobID == "" {
		t.Fatal("expected non-empty app-install job id")
	}
	watchResp, err := http.Get(srv.URL + "/v1/management/webui/app-install/jobs/" + jobID + "/watch")
	if err != nil {
		t.Fatal(err)
	}
	defer watchResp.Body.Close()
	scanner := bufio.NewScanner(watchResp.Body)
	var succeeded bool
	var sawConnected, sawInstallJob bool
	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		if strings.Contains(line, `"type":"connected"`) {
			sawConnected = true
		}
		if strings.Contains(line, `"type":"install-job"`) {
			sawInstallJob = true
		}
		if strings.Contains(line, `"status":"succeeded"`) {
			succeeded = true
			break
		}
	}
	if !sawConnected || !sawInstallJob || !succeeded {
		t.Fatalf("unexpected app-install SSE stream: connected=%v installJob=%v succeeded=%v", sawConnected, sawInstallJob, succeeded)
	}

	// 安装完成后的 check-update 应返回 available 2.0.0。
	checkUpd := doHTTP(t, h, http.MethodPost, "/v1/management/webui/toolkit/apps/codex/check-update", `{}`)
	if checkUpd.Code != 200 || decodeMap(t, checkUpd)["status"] != "available" {
		t.Fatalf("unexpected check-update after install: %d %s", checkUpd.Code, checkUpd.Body.String())
	}

	// Hooks 验证。
	if rec := doHTTP(t, h, http.MethodPost, AppsHooksPath, `{"providers":["codex"],"action":"bad"}`); rec.Code != 400 || decodeMap(t, rec)["error"] != "invalid_hook_action" {
		t.Fatalf("expected 400 invalid_hook_action: %d %s", rec.Code, rec.Body.String())
	}
}

// 确认 tools 包接口引用在编译期被覆蓋验证。
var _ = tools.ToolView{}
