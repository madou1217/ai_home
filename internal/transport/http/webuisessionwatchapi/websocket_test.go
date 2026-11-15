package webuisessionwatchapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/madou1217/ai_home/internal/runtime/sessionevents"
	"github.com/madou1217/ai_home/internal/transport/http/webuipublicalias"
)

type bearerAuthorizer struct {
	expectedToken string
}

func (auth bearerAuthorizer) Authorized(request *http.Request) bool {
	if request == nil {
		return false
	}
	raw := strings.TrimSpace(request.Header.Get("Authorization"))
	const prefix = "Bearer "
	if len(raw) <= len(prefix) || !strings.EqualFold(raw[:len(prefix)], prefix) {
		return false
	}
	return strings.TrimSpace(raw[len(prefix):]) == auth.expectedToken
}

func wsURLFromHTTP(httpURL string, path string) string {
	return "ws" + strings.TrimPrefix(httpURL, "http") + path
}

func TestSessionWatchWebSocketFirstFrameAuthAndRealtimeStream(t *testing.T) {
	hostHome := t.TempDir()
	aiHome := t.TempDir()
	projDir := filepath.Join(hostHome, ".claude", "projects", "proj-ws")
	if err := os.MkdirAll(projDir, 0o755); err != nil {
		t.Fatal(err)
	}
	transcript := filepath.Join(projDir, "sess-ws-1.jsonl")
	if err := os.WriteFile(transcript, []byte(`{"type":"user"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	bus := sessionevents.NewBus(sessionevents.BusOptions{
		HostHomeDir: hostHome,
		AIHomeDir:   aiHome,
		Debounce:    20 * time.Millisecond,
	})
	defer bus.Close()

	const secret = "mgmt-secret-key-0123456789abcdef"
	handler, err := NewHandler(Dependencies{
		Authorizer:          bearerAuthorizer{expectedToken: secret},
		Bus:                 bus,
		HostHomeDir:         hostHome,
		AIHomeDir:           aiHome,
		WSHeartbeatInterval: 40 * time.Millisecond,
		AuthTimeout:         2 * time.Second,
		WSWriteTimeout:      2 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.Handle("GET "+Path, handler)
	mux.Handle("GET "+WSPath, handler)
	mux.Handle("GET "+PublicWSPath, webuipublicalias.Rewrite("/v0/webui", "/v1/management/webui", handler))

	server := httptest.NewServer(mux)
	defer server.Close()

	// 1) 普通 SSE 请求不带 HTTP Authorization 头必须继续 401 拒绝。
	sseResp, err := server.Client().Get(server.URL + Path + "?provider=claude&sessionId=sess-ws-1")
	if err != nil {
		t.Fatal(err)
	}
	_ = sseResp.Body.Close()
	if sseResp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("无 HTTP Authorization 的 SSE 状态码 = %d, want 401", sseResp.StatusCode)
	}

	// 2) 浏览器 WebSocket 握手不带 HTTP Authorization 头（仅带同源 Origin），经首帧 Bearer 鉴权建连成功。
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	conn, _, err := websocket.Dial(ctx, wsURLFromHTTP(server.URL, PublicWSPath), &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Origin": []string{server.URL},
		},
	})
	if err != nil {
		t.Fatalf("WebSocket 握手失败: %v", err)
	}
	defer func() { _ = conn.CloseNow() }()

	authPayload, _ := json.Marshal(map[string]any{
		"authorization":  "Bearer " + secret,
		"provider":       "Claude",
		"sessionId":      "sess-ws-1",
		"projectDirName": "proj-ws",
	})
	if err := conn.Write(ctx, websocket.MessageText, authPayload); err != nil {
		t.Fatalf("发送首帧鉴权失败: %v", err)
	}

	readJSONFrame := func() map[string]any {
		t.Helper()
		msgType, raw, readErr := conn.Read(ctx)
		if readErr != nil {
			t.Fatalf("读取 WebSocket 帧失败: %v", readErr)
		}
		if msgType != websocket.MessageText {
			t.Fatalf("帧类型 = %v, want MessageText", msgType)
		}
		var doc map[string]any
		if uerr := json.Unmarshal(raw, &doc); uerr != nil {
			t.Fatalf("解析 JSON 帧失败: %v (%s)", uerr, string(raw))
		}
		return doc
	}

	connected := readJSONFrame()
	if connected["type"] != "connected" {
		t.Fatalf("首条服务端帧应为 connected, got=%v", connected)
	}

	// 3) Hook 事件实时推送 + 投影路径归并验证。
	projectedPath := filepath.Join(aiHome, "run", "auth-projections", "claude", "acct_ws", ".claude", "projects", "proj-ws")
	wantPath := filepath.Join(hostHome, ".claude", "projects", "proj-ws")
	bus.Publish(sessionevents.Session{
		Provider:       "claude",
		SessionID:      "sess-ws-1",
		ProjectDirName: "proj-ws",
		ProjectPath:    projectedPath,
	}, sessionevents.Event{
		Type:      "session:turn-completed",
		Source:    "official-hook",
		EventName: "Stop",
		Phase:     "turn-completed",
		RunID:     "run-ws-99",
	})

	hookFrame := readJSONFrame()
	if hookFrame["type"] != "update" ||
		hookFrame["eventType"] != "session:turn-completed" ||
		hookFrame["runId"] != "run-ws-99" ||
		hookFrame["projectPath"] != wantPath {
		t.Fatalf("Hook 推送帧不符: %v", hookFrame)
	}

	// 4) 真实会话文件追加触发 fsnotify -> WebSocket update 帧。
	f, err := os.OpenFile(transcript, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.WriteString(`{"type":"assistant"}` + "\n")
	_ = f.Close()

	fileFrame := readJSONFrame()
	if fileFrame["type"] != "update" || fileFrame["eventType"] != "session:file-changed" || fileFrame["source"] != "watcher" {
		t.Fatalf("fsnotify 文件变更帧不符: %v", fileFrame)
	}

	// 5) Bus 关闭时服务端主动以 1011 (StatusInternalError) 关闭连接。
	bus.Close()
	_, _, closeErr := conn.Read(ctx)
	if got := websocket.CloseStatus(closeErr); got != websocket.StatusInternalError {
		t.Fatalf("Bus 关闭后 WebSocket 关闭码 = %d, want 1011 (err=%v)", got, closeErr)
	}
}

func TestSessionWatchWebSocketRejectionsAndAuthTimeout(t *testing.T) {
	bus := sessionevents.NewBus(sessionevents.BusOptions{})
	defer bus.Close()

	const secret = "mgmt-secret-key-0123456789abcdef"
	handler, err := NewHandler(Dependencies{
		Authorizer:     bearerAuthorizer{expectedToken: secret},
		Bus:            bus,
		AuthTimeout:    120 * time.Millisecond,
		WSWriteTimeout: time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(handler)
	defer server.Close()

	t.Run("cross_origin_rejected_with_403", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_, resp, dialErr := websocket.Dial(ctx, wsURLFromHTTP(server.URL, WSPath), &websocket.DialOptions{
			HTTPHeader: http.Header{
				"Origin": []string{"https://evil.example.com"},
			},
		})
		if dialErr == nil {
			t.Fatal("跨源握手应当被拒绝")
		}
		if resp == nil || resp.StatusCode != http.StatusForbidden {
			status := 0
			if resp != nil {
				status = resp.StatusCode
			}
			t.Fatalf("跨源握手 HTTP 状态码 = %d, want 403 (err=%v)", status, dialErr)
		}
	})

	t.Run("invalid_bearer_closed_with_4401", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		conn, _, dialErr := websocket.Dial(ctx, wsURLFromHTTP(server.URL, WSPath), nil)
		if dialErr != nil {
			t.Fatal(dialErr)
		}
		defer func() { _ = conn.CloseNow() }()

		_ = conn.Write(ctx, websocket.MessageText, []byte(`{"authorization":"Bearer wrong","provider":"claude","sessionId":"s1"}`))
		_, _, readErr := conn.Read(ctx)
		if got := websocket.CloseStatus(readErr); got != wsStatusUnauthorized {
			t.Fatalf("错误密钥关闭码 = %d, want 4401 (err=%v)", got, readErr)
		}
	})

	t.Run("missing_params_and_non_object_json_closed_with_4400", func(t *testing.T) {
		for _, frame := range []string{
			`[]`,
			`not-json`,
			`{"authorization":"Bearer ` + secret + `","provider":"claude"}`,
		} {
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			conn, _, dialErr := websocket.Dial(ctx, wsURLFromHTTP(server.URL, WSPath), nil)
			if dialErr != nil {
				cancel()
				t.Fatal(dialErr)
			}
			_ = conn.Write(ctx, websocket.MessageText, []byte(frame))
			_, _, readErr := conn.Read(ctx)
			_ = conn.CloseNow()
			cancel()
			if got := websocket.CloseStatus(readErr); got != wsStatusBadRequest {
				t.Fatalf("frame=%q 关闭码 = %d, want 4400 (err=%v)", frame, got, readErr)
			}
		}
	})

	t.Run("silent_client_auth_timeout_closed_with_1008", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		conn, _, dialErr := websocket.Dial(ctx, wsURLFromHTTP(server.URL, WSPath), nil)
		if dialErr != nil {
			t.Fatal(dialErr)
		}
		defer func() { _ = conn.CloseNow() }()

		_, _, readErr := conn.Read(ctx)
		if got := websocket.CloseStatus(readErr); got != websocket.StatusPolicyViolation {
			t.Fatalf("鉴权超时关闭码 = %d, want 1008 (err=%v)", got, readErr)
		}
	})
}

func TestDrainCoalescedWatchBatchPreservesStateTransitions(t *testing.T) {
	ch := make(chan sessionevents.Event, 8)
	first := sessionevents.Event{Type: "session:file-changed", Source: "watcher", Reason: "r1"}
	ch <- sessionevents.Event{Type: "session:file-changed", Source: "watcher", Reason: "r2"}
	ch <- sessionevents.Event{Type: "session:turn-completed", Source: "official-hook", Phase: "turn-completed", RunID: "run-1"}
	ch <- sessionevents.Event{Type: "session:file-changed", Source: "watcher", Reason: "r3"}
	ch <- sessionevents.Event{Type: "session:file-changed", Source: "watcher", Reason: "r4"}

	batch := drainCoalescedWatchBatch(first, ch)
	if len(batch) != 3 {
		t.Fatalf("合并后批次长度 = %d, want 3 (%+v)", len(batch), batch)
	}
	if batch[0].Reason != "r2" || batch[1].RunID != "run-1" || batch[2].Reason != "r4" {
		t.Fatalf("合并批次内容异常: %+v", batch)
	}
}
