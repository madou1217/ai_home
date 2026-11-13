package aihserver

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/madou1217/ai_home/internal/transport/http/clientauth"
	"github.com/madou1217/ai_home/internal/transport/http/codexappserverapi"
)

func newTestRouterWithCodexAppServer(appServerHandler http.Handler) http.Handler {
	noop := http.NotFoundHandler()
	return newRouter(serverHandlers{
		accounts:          noop,
		models:            noop,
		gemini:            noop,
		blobs:             noop,
		tokenCount:        noop,
		images:            noop,
		clientProps:       noop,
		accountAuth:       noop,
		claudeRelayLeases: noop,
		inference:         noop,
		claudeNativeRelay: noop,
		codexAppServer:    appServerHandler,
	})
}

func TestCodexAppServerWSRouterAndHandlerIntegration(t *testing.T) {
	t.Parallel()

	authorizer, err := clientauth.NewAuthorizer(func() string { return "secret-client-key" })
	if err != nil {
		t.Fatal(err)
	}

	var logBuf bytes.Buffer
	handler, err := newCodexAppServerWSHandler(authorizer, handlerDependencies{
		AIHomeDir:   t.TempDir(),
		HostHomeDir: t.TempDir(),
		ErrorLog:    log.New(&logBuf, "", 0),
	})
	if err != nil {
		t.Fatal(err)
	}
	if handler == nil {
		t.Fatal("newCodexAppServerWSHandler 返回空处理器")
	}

	mux := newTestRouterWithCodexAppServer(handler)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// 普通 GET /（不带 WS Upgrade）应交给 handleRouteNotFound 返回 404，不影响未升级请求语义。
	plainRootResp, err := http.Get(srv.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	_ = plainRootResp.Body.Close()
	if plainRootResp.StatusCode != http.StatusNotFound {
		t.Fatalf("普通 GET / 状态码 = %d, 期望 404", plainRootResp.StatusCode)
	}

	// /v0/codex/app-server 未带 Bearer clientKey 时拒绝 401。
	unauthWSResp, err := http.Get(srv.URL + codexappserverapi.AppServerProxyPath)
	if err != nil {
		t.Fatal(err)
	}
	_ = unauthWSResp.Body.Close()
	if unauthWSResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("未授权 /v0/codex/app-server 状态码 = %d, 期望 401", unauthWSResp.StatusCode)
	}

	// 验证 ServeMux 精确模式 constants（GET /{$} 不拦截 /other）。
	exactMux := http.NewServeMux()
	missingHandler, err := codexappserverapi.NewAppServerHandler(codexappserverapi.AppServerDependencies{
		Authorizer: authorizer,
		ResolveCodex: func() (string, error) {
			return "", errors.New("codex missing")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	exactMux.Handle(codexAppServerRootPattern, missingHandler)
	exactMux.Handle(codexAppServerLegacyPattern, missingHandler)
	exactMux.HandleFunc("/", handleRouteNotFound)

	exactSrv := httptest.NewServer(exactMux)
	defer exactSrv.Close()

	otherResp, err := http.Get(exactSrv.URL + "/not-root")
	if err != nil {
		t.Fatal(err)
	}
	_ = otherResp.Body.Close()
	if otherResp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET /not-root 状态码 = %d, 期望 404", otherResp.StatusCode)
	}

	// 缺少 codex 可执行文件时 / 与 /v0/codex/app-server 均显式返回 503（零回退）。
	for _, path := range []string{"/", codexappserverapi.AppServerProxyPath} {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		wsURL := strings.Replace(exactSrv.URL, "http://", "ws://", 1) + path
		_, wsResp, dialErr := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
			HTTPHeader: http.Header{"Authorization": []string{"Bearer secret-client-key"}},
		})
		cancel()
		if dialErr == nil || wsResp == nil || wsResp.StatusCode != http.StatusServiceUnavailable {
			t.Fatalf("%s 缺少 codex 时状态码 = %v (err=%v), 期望 503", path, wsResp, dialErr)
		}
	}

	// 使用独立隔离子目录写入假的 codex 可执行脚本不污染并发环境，验证 router / 与 /v0/codex/app-server 升级分派。
	fakeDir := t.TempDir()
	fakeCodex := filepath.Join(fakeDir, "codex-fake")
	if err := os.WriteFile(fakeCodex, []byte("#!/bin/sh\nwhile IFS= read -r line; do\n  printf '%s\\n' \"$line\"\ndone\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	liveHandler, err := codexappserverapi.NewAppServerHandler(codexappserverapi.AppServerDependencies{
		Authorizer:          authorizer,
		AIHomeDir:           t.TempDir(),
		HostHomeDir:         t.TempDir(),
		StartupProbeTimeout: 20 * time.Millisecond,
		ResolveCodex:        func() (string, error) { return fakeCodex, nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	liveRouter := newTestRouterWithCodexAppServer(liveHandler)
	liveSrv := httptest.NewServer(liveRouter)
	defer liveSrv.Close()

	for _, path := range []string{"/", codexappserverapi.AppServerProxyPath} {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		wsURL := strings.Replace(liveSrv.URL, "http://", "ws://", 1) + path + "?aih_cwd=%2Ftmp%2Frouter-ws"
		conn, _, dialErr := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
			HTTPHeader: http.Header{"Authorization": []string{"Bearer secret-client-key"}},
		})
		if dialErr != nil {
			cancel()
			t.Fatalf("%s WS 握手失败: %v", path, dialErr)
		}
		if err := conn.Write(ctx, websocket.MessageText, []byte(`{"id":9,"method":"thread/list","params":{}}`)); err != nil {
			_ = conn.CloseNow()
			cancel()
			t.Fatal(err)
		}
		_, echoBytes, readErr := conn.Read(ctx)
		_ = conn.Close(websocket.StatusNormalClosure, "")
		cancel()
		if readErr != nil {
			t.Fatalf("%s 读取回显失败: %v", path, readErr)
		}
		var payload map[string]any
		if err := json.Unmarshal(echoBytes, &payload); err != nil {
			t.Fatal(err)
		}
		params := payload["params"].(map[string]any)
		if params["cwd"] != "/tmp/router-ws" || params["useStateDbOnly"] != true {
			t.Fatalf("%s 未按预期重写 thread/list: %+v", path, params)
		}
	}
}
