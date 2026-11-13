package codexappserverapi

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/madou1217/ai_home/internal/runtime/codexhooks"
)

type stubAuthorizer struct {
	allow bool
}

func (a stubAuthorizer) Authorized(request *http.Request) bool {
	if a.allow {
		return true
	}
	return request != nil && request.Header.Get("Authorization") == "Bearer test-client-key"
}

func TestRewriteClientMessageAndResumePatch(t *testing.T) {
	t.Parallel()

	rawList := []byte(`{"id":1,"method":"thread/list","params":{"modelProviders":["openai"],"limit":20}}`)
	rewrittenList := RewriteClientMessage(rawList, "/Users/work/repo")
	var parsedList map[string]any
	if err := json.Unmarshal(rewrittenList, &parsedList); err != nil {
		t.Fatal(err)
	}
	params := parsedList["params"].(map[string]any)
	if params["cwd"] != "/Users/work/repo" || params["useStateDbOnly"] != true {
		t.Fatalf("thread/list 重写异常: %+v", params)
	}
	if mp := params["modelProviders"].([]any); len(mp) != 0 {
		t.Fatalf("modelProviders 应清空为 [], 实际 %+v", mp)
	}

	rawResume := []byte(`{"id":"req-9","method":"thread/resume","params":{"threadId":"thr-77","config":{"profile":"fast"}}}`)
	rewrittenResume := RewriteClientMessage(rawResume, "")
	var parsedResume map[string]any
	if err := json.Unmarshal(rewrittenResume, &parsedResume); err != nil {
		t.Fatal(err)
	}
	rParams := parsedResume["params"].(map[string]any)
	if _, hasConfig := rParams["config"]; hasConfig {
		t.Fatalf("仅剩 profile 的 config 应被整个删除, 实际 %+v", rParams)
	}

	tracker := NewResponseContextTracker()
	if !tracker.RememberThreadResumeRequest(rewrittenResume) {
		t.Fatal("RememberThreadResumeRequest 应返回 true")
	}
	resp := []byte(`{"id":"req-9","result":{"thread":{"id":"thr-77"}}}`)
	patched := tracker.PatchThreadResumeResponse(resp)
	var parsedResp map[string]any
	if err := json.Unmarshal(patched, &parsedResp); err != nil {
		t.Fatal(err)
	}
	threadIDs := parsedResp["result"].(map[string]any)["threadIds"].([]any)
	if len(threadIDs) != 1 || threadIDs[0] != "thr-77" {
		t.Fatalf("thread/resume 响应补丁异常: %+v", parsedResp)
	}
}

func TestBuildAppServerSpawnEnv(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	env := BuildAppServerSpawnEnv("", filepath.Join(root, "host"), []string{
		"PATH=/usr/bin",
		"AIH_CODEX_FLAGS=authPreflight=0",
	})
	mapped := make(map[string]string)
	for _, entry := range env {
		k, v, ok := strings.Cut(entry, "=")
		if ok {
			mapped[k] = v
		}
	}
	if mapped[codexhooks.CodexAppServerPassthroughEnv] != "1" {
		t.Fatalf("缺少直通标记: %+v", mapped)
	}
	parsedFlags := ParseCodexFlags(mapped[CodexFlagsEnv])
	if parsedFlags["authPreflight"] != "0" || parsedFlags["remoteProxy"] != "1" {
		t.Fatalf("AIH_CODEX_FLAGS 合并异常: %+v", parsedFlags)
	}
}

func TestAppServerHandlerWebSocketProxyRoundTrip(t *testing.T) {
	t.Parallel()
	root := t.TempDir()

	handler, err := NewAppServerHandler(AppServerDependencies{
		Authorizer:  stubAuthorizer{},
		AIHomeDir:   filepath.Join(root, "ai"),
		HostHomeDir: filepath.Join(root, "host"),
		ResolveCodex: func() (string, error) {
			return "/fake/bin/codex", nil
		},
		DialStdio: func(ctx context.Context, _ StdioProcessConfig) (*StdioSession, error) {
			inReader, inWriter := io.Pipe()
			outReader, outWriter := io.Pipe()
			go func() {
				defer func() {
					_ = inReader.Close()
					_ = outWriter.Close()
				}()
				scanner := bufio.NewScanner(inReader)
				for scanner.Scan() {
					var req map[string]any
					if json.Unmarshal(scanner.Bytes(), &req) != nil {
						continue
					}
					method, _ := req["method"].(string)
					var resp []byte
					switch method {
					case "thread/list":
						resp, _ = json.Marshal(map[string]any{
							"id":     req["id"],
							"result": map[string]any{"echoParams": req["params"]},
						})
					case "thread/resume":
						resp, _ = json.Marshal(map[string]any{
							"id":     req["id"],
							"result": map[string]any{"thread": map[string]any{"id": "thr-99"}},
						})
					}
					if len(resp) > 0 {
						_, _ = outWriter.Write(append(resp, '\n'))
					}
				}
			}()
			return &StdioSession{
				Stdin:  inWriter,
				Stdout: outReader,
				Close: func() error {
					_ = inWriter.Close()
					_ = outReader.Close()
					return nil
				},
			}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	srv := httptest.NewServer(handler)
	defer srv.Close()

	unauthReq, _ := http.NewRequest(http.MethodGet, srv.URL+AppServerProxyPath, nil)
	unauthResp, err := http.DefaultClient.Do(unauthReq)
	if err != nil {
		t.Fatal(err)
	}
	_ = unauthResp.Body.Close()
	if unauthResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("未鉴权升级状态码 = %d, 期望 401", unauthResp.StatusCode)
	}

	wsURL := strings.Replace(srv.URL, "http://", "ws://", 1) + AppServerProxyPath + "?aih_cwd=%2Ftmp%2Fproj"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer test-client-key"}},
	})
	if err != nil {
		t.Fatalf("WebSocket 连接失败: %v", err)
	}
	defer func() { _ = conn.CloseNow() }()

	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"id":1,"method":"thread/list","params":{}}`)); err != nil {
		t.Fatal(err)
	}
	_, msg1, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var res1 map[string]any
	if err := json.Unmarshal(msg1, &res1); err != nil {
		t.Fatal(err)
	}
	echoParams := res1["result"].(map[string]any)["echoParams"].(map[string]any)
	if echoParams["cwd"] != "/tmp/proj" || echoParams["useStateDbOnly"] != true {
		t.Fatalf("代理未注入 cwd/useStateDbOnly: %+v", echoParams)
	}

	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"id":2,"method":"thread/resume","params":{"threadId":"thr-99"}}`)); err != nil {
		t.Fatal(err)
	}
	_, msg2, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var res2 map[string]any
	if err := json.Unmarshal(msg2, &res2); err != nil {
		t.Fatal(err)
	}
	tids := res2["result"].(map[string]any)["threadIds"].([]any)
	if len(tids) != 1 || tids[0] != "thr-99" {
		t.Fatalf("代理未打上 threadIds 补丁: %+v", res2)
	}
}

func TestRemoteControlHelpersAndProxy(t *testing.T) {
	t.Parallel()

	sanitized := SanitizeTraceText(`Bearer secret.token.abc {"access_token":"tok123"} eyJhbGciOiJIUzI1NiJ9.payload.sig`, 500)
	if strings.Contains(sanitized, "secret.token") || strings.Contains(sanitized, "tok123") || strings.Contains(sanitized, "eyJhb") {
		t.Fatalf("Trace 脱敏失败: %q", sanitized)
	}

	var mu sync.Mutex
	var traces []map[string]any
	assembler := NewRemoteChunkAssembler(func(entry map[string]any) {
		mu.Lock()
		traces = append(traces, entry)
		mu.Unlock()
	})
	fullMsg := []byte(`{"id":"1","method":"thread/list","result":{"data":[{"id":"t-1","cwd":"/repo"}]}}`)
	part1 := base64.StdEncoding.EncodeToString(fullMsg[:len(fullMsg)/2])
	part2 := base64.StdEncoding.EncodeToString(fullMsg[len(fullMsg)/2:])
	assembler.Accept(map[string]any{
		"type":                 "server_message_chunk",
		"client_id":            "c1",
		"stream_id":            "s1",
		"seq_id":               float64(1),
		"segment_id":           float64(0),
		"segment_count":        float64(2),
		"message_size_bytes":   float64(len(fullMsg)),
		"message_chunk_base64": part1,
	}, "ws_test")
	assembler.Accept(map[string]any{
		"type":                 "server_message_chunk",
		"client_id":            "c1",
		"stream_id":            "s1",
		"seq_id":               float64(1),
		"segment_id":           float64(1),
		"segment_count":        float64(2),
		"message_size_bytes":   float64(len(fullMsg)),
		"message_chunk_base64": part2,
	}, "ws_test")
	mu.Lock()
	if len(traces) != 1 || traces[0]["summary"].(map[string]any)["type"] != "server_message_chunk_reassembled" {
		mu.Unlock()
		t.Fatalf("分片重组 trace 异常: %+v", traces)
	}
	mu.Unlock()

	root := t.TempDir()
	suppressPath := filepath.Join(root, "suppress.json")
	nowMs := int64(1700000000000)
	_ = os.WriteFile(suppressPath, []byte(`{"threads":[{"id":"thr-sup","expiresAt":1700000060000},{"id":"thr-old","expiresAt":1699999999000}]}`), 0o600)
	suppressed := ReadRemoteHydrationSuppressionState(suppressPath, nowMs)
	if _, ok := suppressed["thr-sup"]; !ok {
		t.Fatal("未过期线程应处于抑制集合")
	}
	if _, ok := suppressed["thr-old"]; ok {
		t.Fatal("已过期线程不应处于抑制集合")
	}
	if !ShouldSuppressRemoteHydrationEnvelope(map[string]any{
		"type":    "server_message",
		"message": map[string]any{"method": "thread/status/changed", "params": map[string]any{"threadId": "thr-sup"}},
	}, suppressed) {
		t.Fatal("命中抑制线程的 hydration 通知应被抑制")
	}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if IsUpgradeRequest(r) {
			conn, acceptErr := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
			if acceptErr != nil {
				return
			}
			defer func() { _ = conn.CloseNow() }()
			ctx := r.Context()
			_, data, readErr := conn.Read(ctx)
			if readErr != nil {
				return
			}
			_ = conn.Write(ctx, websocket.MessageText, data)
			_ = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"client_message","message":{"id":7,"method":"thread/list","params":{"modelProviders":["openai"]}}}`))
			_, _, _ = conn.Read(ctx)
			return
		}
		w.Header().Set("X-Request-Id", "req-upstream-1")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	rcHandler, err := NewRemoteControlHandler(RemoteControlDependencies{
		UpstreamOrigin:    upstream.URL,
		SuppressStateFile: suppressPath,
		Now:               func() time.Time { return time.UnixMilli(nowMs) },
	})
	if err != nil {
		t.Fatal(err)
	}
	proxySrv := httptest.NewServer(rcHandler)
	defer proxySrv.Close()

	httpResp, err := http.Get(proxySrv.URL + "/backend-api/wham/status")
	if err != nil {
		t.Fatal(err)
	}
	_ = httpResp.Body.Close()
	if httpResp.StatusCode != http.StatusOK || httpResp.Header.Get("X-Request-Id") != "req-upstream-1" {
		t.Fatalf("HTTP remote-control 转发异常: status=%d headers=%v", httpResp.StatusCode, httpResp.Header)
	}

	wsCtx, wsCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer wsCancel()
	wsConn, _, err := websocket.Dial(wsCtx, strings.Replace(proxySrv.URL, "http://", "ws://", 1)+"/backend-api/codex/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = wsConn.CloseNow() }()

	_ = wsConn.Write(wsCtx, websocket.MessageText, []byte(`{"type":"server_message","message":{"method":"thread/started","params":{"thread":{"id":"thr-sup"}}}}`))
	_ = wsConn.Write(wsCtx, websocket.MessageText, []byte(`{"type":"server_message","message":{"method":"thread/started","params":{"thread":{"id":"thr-pass"}}}}`))

	_, echoPass, err := wsConn.Read(wsCtx)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(echoPass), "thr-pass") {
		t.Fatalf("期待收到未被抑制的 thr-pass 转发帧, 实际 %s", string(echoPass))
	}
	_, rewrittenFrame, err := wsConn.Read(wsCtx)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(rewrittenFrame), `"useStateDbOnly":true`) {
		t.Fatalf("下游 client_message 未被改写: %s", string(rewrittenFrame))
	}
}
