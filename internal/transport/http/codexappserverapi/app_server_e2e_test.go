package codexappserverapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/runtime/codexappserverws"
)

type stubAccountStoreForAPI struct {
	def  accountcore.ProviderDefault
	cred accountapp.Credential
}

func (s stubAccountStoreForAPI) GetProviderDefault(_ context.Context, _ string) (accountcore.ProviderDefault, error) {
	return s.def, nil
}

func (s stubAccountStoreForAPI) GetCredential(_ context.Context, _ accountcore.AccountRef) (accountapp.Credential, error) {
	return s.cred, nil
}

// TestHelperFakeCodexAppServerBinary 通过自重入子进程模拟真实 codex app-server --listen stdio:// 行为。
func TestHelperFakeCodexAppServerBinary(t *testing.T) {
	if os.Getenv("GO_WANT_APP_SERVER_WS_HELPER") != "1" {
		return
	}
	mode := os.Getenv("GO_APP_SERVER_WS_HELPER_MODE")
	if mode == "fast-exit" {
		_, _ = fmt.Fprintln(os.Stderr, "startup boom")
		os.Exit(1)
	}
	_, _ = fmt.Fprintln(os.Stderr, "fake codex app-server booted")
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		var req map[string]any
		if json.Unmarshal(scanner.Bytes(), &req) != nil {
			continue
		}
		method, _ := req["method"].(string)
		switch method {
		case "thread/list":
			resp, _ := json.Marshal(map[string]any{
				"id": req["id"],
				"result": map[string]any{
					"echoParams":   req["params"],
					"remoteProxy":  codexappserverws.ParseCodexFlags(os.Getenv(CodexFlagsEnv))["remoteProxy"],
					"args":         os.Args[1:],
					"homeEnv":      os.Getenv("HOME"),
					"openAIApiKey": os.Getenv("OPENAI_API_KEY"),
					"openAIBase":   os.Getenv("OPENAI_BASE_URL"),
				},
			})
			// 使用 \r\n 验证代理对 CRLF 行分隔与空行的兼容解析。
			_, _ = fmt.Fprintf(os.Stdout, "%s\r\n\r\n", string(resp))
		case "thread/resume":
			resp, _ := json.Marshal(map[string]any{
				"id":     req["id"],
				"result": map[string]any{"thread": map[string]any{"id": "thr-e2e-9"}},
			})
			_, _ = fmt.Fprintf(os.Stdout, "%s\n", string(resp))
		case "thread/start":
			resp, _ := json.Marshal(map[string]any{
				"id":     req["id"],
				"result": map[string]any{"echoParams": req["params"]},
			})
			_, _ = fmt.Fprintf(os.Stdout, "%s\n", string(resp))
		}
	}
	os.Exit(0)
}

func TestAppServerHandlerEdgeStatusCodes(t *testing.T) {
	t.Parallel()

	t.Run("路径不匹配回404_非GET回405_未授权回401_缺升级头回426_缺二进制回503", func(t *testing.T) {
		t.Parallel()
		handler, err := NewAppServerHandler(AppServerDependencies{
			Authorizer:  stubAuthorizer{},
			AIHomeDir:   t.TempDir(),
			HostHomeDir: t.TempDir(),
			ResolveCodex: func() (string, error) {
				return "", errors.New("codex missing")
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		srv := httptest.NewServer(handler)
		defer srv.Close()

		resp404, err := http.Get(srv.URL + "/other/path")
		if err != nil {
			t.Fatal(err)
		}
		_ = resp404.Body.Close()
		if resp404.StatusCode != http.StatusNotFound {
			t.Fatalf("/other/path status = %d, want 404", resp404.StatusCode)
		}

		resp405, err := http.Post(srv.URL+"/", "application/json", nil)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp405.Body.Close()
		if resp405.StatusCode != http.StatusMethodNotAllowed {
			t.Fatalf("POST / status = %d, want 405", resp405.StatusCode)
		}

		unauthReq, _ := http.NewRequest(http.MethodGet, srv.URL+"/", nil)
		resp401, err := http.DefaultClient.Do(unauthReq)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp401.Body.Close()
		if resp401.StatusCode != http.StatusUnauthorized || resp401.Header.Get("WWW-Authenticate") != "Bearer" {
			t.Fatalf("401 status=%d www-auth=%q", resp401.StatusCode, resp401.Header.Get("WWW-Authenticate"))
		}

		nonWSReq, _ := http.NewRequest(http.MethodGet, srv.URL+"/", nil)
		nonWSReq.Header.Set("Authorization", "Bearer test-client-key")
		resp426, err := http.DefaultClient.Do(nonWSReq)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp426.Body.Close()
		if resp426.StatusCode != http.StatusUpgradeRequired {
			t.Fatalf("non-upgrade status = %d, want 426", resp426.StatusCode)
		}

		wsURL := strings.Replace(srv.URL, "http://", "ws://", 1) + "/"
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_, wsResp, dialErr := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
			HTTPHeader: http.Header{"Authorization": []string{"Bearer test-client-key"}},
		})
		if dialErr == nil {
			t.Fatal("缺少 codex 二进制时 WS 握手不应成功")
		}
		if wsResp == nil || wsResp.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("缺少二进制时状态码 = %v, 期望 503", wsResp)
		}
	})
}

func TestAppServerHandlerSubprocessEndToEnd(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell wrapper 测试脚本仅在类 Unix 环境执行")
	}

	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	hostHome := filepath.Join(root, "host")
	aiHome := filepath.Join(root, "ai")

	fastExitWrapper := filepath.Join(root, "codex-fast-exit")
	scriptFast := fmt.Sprintf("#!/bin/sh\necho startup boom >&2\nexit 1\n")
	if err := os.WriteFile(fastExitWrapper, []byte(scriptFast), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Run("子进程启动失败或秒退在握手前返回502", func(t *testing.T) {
		nonExec := filepath.Join(root, "non-exec-codex")
		if err := os.WriteFile(nonExec, []byte("nope"), 0o644); err != nil {
			t.Fatal(err)
		}
		badHandler, err := NewAppServerHandler(AppServerDependencies{
			AIHomeDir:    aiHome,
			HostHomeDir:  hostHome,
			ResolveCodex: func() (string, error) { return nonExec, nil },
		})
		if err != nil {
			t.Fatal(err)
		}
		badSrv := httptest.NewServer(badHandler)
		defer badSrv.Close()
		badCtx, badCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer badCancel()
		_, badResp, badDialErr := websocket.Dial(badCtx, strings.Replace(badSrv.URL, "http://", "ws://", 1)+"/", nil)
		if badDialErr == nil || badResp == nil || badResp.StatusCode != http.StatusBadGateway {
			t.Fatalf("不可执行二进制应立即返回 502 Bad Gateway, resp=%+v err=%v", badResp, badDialErr)
		}

		handler, err := NewAppServerHandler(AppServerDependencies{
			AIHomeDir:           aiHome,
			HostHomeDir:         hostHome,
			StartupProbeTimeout: 500 * time.Millisecond,
			ResolveCodex:        func() (string, error) { return fastExitWrapper, nil },
		})
		if err != nil {
			t.Fatal(err)
		}
		srv := httptest.NewServer(handler)
		defer srv.Close()

		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_, resp, dialErr := websocket.Dial(ctx, strings.Replace(srv.URL, "http://", "ws://", 1)+"/", nil)
		if dialErr == nil || resp == nil || resp.StatusCode != http.StatusBadGateway {
			t.Fatalf("子进程秒退应返回 502 Bad Gateway, resp=%+v err=%v", resp, dialErr)
		}
	})

	liveWrapper := filepath.Join(root, "codex-live")
	scriptLive := fmt.Sprintf("#!/bin/sh\nexport GO_WANT_APP_SERVER_WS_HELPER=1\nexport GO_APP_SERVER_WS_HELPER_MODE=live\nexec %q -test.run='^TestHelperFakeCodexAppServerBinary$' -- \"$@\"\n", exe)
	if err := os.WriteFile(liveWrapper, []byte(scriptLive), 0o755); err != nil {
		t.Fatal(err)
	}

	t.Run("根路径真实子进程双向WS转发_账号环境注入_profile剥离与resume补丁", func(t *testing.T) {
		ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
		if err != nil {
			t.Fatal(err)
		}
		def, err := accountcore.NewProviderDefault("codex", ref, time.UnixMilli(1700000000000))
		if err != nil {
			t.Fatal(err)
		}
		cred, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
			APIKey:  "sk-e2e-account",
			BaseURL: "https://e2e.openai.test/v1",
		})
		if err != nil {
			t.Fatal(err)
		}

		var logMu sync.Mutex
		var debugLogs []string
		handler, err := NewAppServerHandler(AppServerDependencies{
			Authorizer:          stubAuthorizer{},
			AIHomeDir:           aiHome,
			HostHomeDir:         hostHome,
			AccountStore:        stubAccountStoreForAPI{def: def, cred: cred},
			StartupProbeTimeout: 20 * time.Millisecond,
			ResolveCodex:        func() (string, error) { return liveWrapper, nil },
			LogDebug: func(msg string) {
				logMu.Lock()
				debugLogs = append(debugLogs, msg)
				logMu.Unlock()
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		srv := httptest.NewServer(handler)
		defer srv.Close()

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		wsURL := strings.Replace(srv.URL, "http://", "ws://", 1) + "/?aih_cwd=%2Frepo%2Fapp"
		conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
			HTTPHeader: http.Header{"Authorization": []string{"Bearer test-client-key"}},
		})
		if err != nil {
			t.Fatalf("根路径 WebSocket 握手失败: %v", err)
		}
		defer func() { _ = conn.CloseNow() }()

		// 1. thread/list 校验 cwd、useStateDbOnly、remoteProxy、HostHome 与默认账号 API Key 注入。
		if err := conn.Write(ctx, websocket.MessageText, []byte(`{"id":1,"method":"thread/list","params":{"modelProviders":["openai"]}}`)); err != nil {
			t.Fatal(err)
		}
		_, frame1, err := conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var msg1 map[string]any
		if err := json.Unmarshal(frame1, &msg1); err != nil {
			t.Fatal(err)
		}
		res1 := msg1["result"].(map[string]any)
		echo1 := res1["echoParams"].(map[string]any)
		if echo1["cwd"] != "/repo/app" || echo1["useStateDbOnly"] != true {
			t.Fatalf("thread/list 重写异常: %+v", echo1)
		}
		if res1["remoteProxy"] != "1" || res1["homeEnv"] != hostHome ||
			res1["openAIApiKey"] != "sk-e2e-account" || res1["openAIBase"] != "https://e2e.openai.test/v1" {
			t.Fatalf("子进程环境注入异常: %+v", res1)
		}

		// 2. thread/start 剥离 config.profile。
		if err := conn.Write(ctx, websocket.MessageText, []byte(`{"id":2,"method":"thread/start","params":{"config":{"profile":"p1","sandbox":"workspace-write"}}}`)); err != nil {
			t.Fatal(err)
		}
		_, frame2, err := conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var msg2 map[string]any
		if err := json.Unmarshal(frame2, &msg2); err != nil {
			t.Fatal(err)
		}
		cfg2 := msg2["result"].(map[string]any)["echoParams"].(map[string]any)["config"].(map[string]any)
		if _, hasProfile := cfg2["profile"]; hasProfile || cfg2["sandbox"] != "workspace-write" {
			t.Fatalf("thread/start config.profile 剥离异常: %+v", cfg2)
		}

		// 3. thread/resume 响应缺失 threadIds 时由代理自动补齐。
		if err := conn.Write(ctx, websocket.MessageText, []byte(`{"id":3,"method":"thread/resume","params":{"threadId":"thr-e2e-9"}}`)); err != nil {
			t.Fatal(err)
		}
		_, frame3, err := conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var msg3 map[string]any
		if err := json.Unmarshal(frame3, &msg3); err != nil {
			t.Fatal(err)
		}
		tids := msg3["result"].(map[string]any)["threadIds"].([]any)
		if len(tids) != 1 || tids[0] != "thr-e2e-9" {
			t.Fatalf("thread/resume 补丁异常: %+v", msg3)
		}

		_ = conn.Close(websocket.StatusNormalClosure, "done")
		srv.Close()

		logMu.Lock()
		joined := strings.Join(debugLogs, "\n")
		logMu.Unlock()
		if !strings.Contains(joined, "fake codex app-server booted") {
			t.Fatalf("stderr 调试日志未收到子进程输出: %q", joined)
		}
	})
}
