package codexresponsesws_test

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// 真实故障（2026-10-02）：账号周额度耗尽后错误帧被原样转给 Codex，Codex 报
// "You've hit your usage limit" 并停下，同组其他账号仍有额度却没换。
const usageLimitFrame = `{"type":"error","status":429,"error":{"type":"usage_limit_reached","message":"You've hit your usage limit.","resets_at":1790943446}}`

func runFailureScenario(t *testing.T, upstreamFrames []string) (*websocket.Conn, *attemptRecorder) {
	t.Helper()
	upstream := newWebSocketUpstream(t, func(connection *websocket.Conn) {
		readOneUpstreamRequest(t, connection)
		for _, frame := range upstreamFrames {
			writeUpstreamText(t, connection, frame)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_, _, _ = connection.Read(ctx)
	})
	recorder := &attemptRecorder{}
	handler := newTestHandler(t, upstream.URL, recorder)
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, _ := dialGateway(t, server.URL, nil)
	t.Cleanup(func() { client.CloseNow() })
	writeClientText(t, client, []byte(`{"type":"response.create","model":"gpt-5.6-sol","input":[]}`))
	return client, recorder
}

// 本轮尚未交出输出时额度耗尽：不转发错误，以 1011 关闭，让 Codex 新开连接重选账号；
// 账号按额度耗尽记入运行态（重新选号会跳过它）。只交出过 response.created 也一样。
func TestQuotaBeforeOutputClosesForReconnectInsteadOfRelaying(t *testing.T) {
	for name, frames := range map[string][]string{
		"error first":         {usageLimitFrame},
		"after preamble only": {`{"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}`, usageLimitFrame},
	} {
		t.Run(name, func(t *testing.T) {
			client, recorder := runFailureScenario(t, frames)
			_, payload, err := readClientMessage(t, client)
			if websocket.CloseStatus(err) != websocket.StatusInternalError {
				t.Fatalf("expected 1011 close without frames, got payload=%s err=%v", payload, err)
			}
			waitForAttempts(t, recorder, 0, 1)
			if kind := recorder.Failures()[0].RuntimeKind(); kind != runtimecore.FailureQuotaExhausted {
				t.Fatalf("failure kind = %v", kind)
			}
		})
	}
}

// 已交出输出后绝不换号重放：错误照旧透传。
func TestQuotaAfterOutputIsRelayed(t *testing.T) {
	delta := `{"type":"response.output_text.delta","item_id":"msg_1","output_index":0,"content_index":0,"delta":"partial"}`
	client, _ := runFailureScenario(t, []string{
		`{"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}`,
		delta,
		usageLimitFrame,
	})
	got := []string{}
	for len(got) < 3 {
		_, payload, err := readClientMessage(t, client)
		if err != nil {
			t.Fatalf("read after %d frames: %v", len(got), err)
		}
		got = append(got, string(payload))
	}
	if got[1] != delta || got[2] != usageLimitFrame {
		t.Fatalf("relayed frames = %v", got)
	}
}

func TestTransientFailureBeforeOutputClosesWithoutPreamble(t *testing.T) {
	for _, scenario := range []struct {
		name  string
		frame string
		kind  runtimecore.FailureKind
	}{
		{"capacity message", `{"type":"response.failed","response":{"error":{"message":"Selected model is at capacity. Please try a different model."}}}`, runtimecore.FailureModelOverloaded},
		{"capacity code", `{"type":"error","status":400,"error":{"code":"model_at_capacity"}}`, runtimecore.FailureModelOverloaded},
		{"rate limit", `{"type":"error","status":429,"error":{"code":"rate_limit_exceeded"}}`, runtimecore.FailureRateLimited},
		{"unavailable", `{"type":"error","status":503,"error":{"code":"server_error"}}`, runtimecore.FailureUpstreamUnavailable},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			client, recorder := runFailureScenario(t, []string{
				`{"type":"response.created","response":{"id":"failed_attempt","output":[]}}`,
				`{"type":"response.in_progress","response":{"output":[]}}`,
				scenario.frame,
			})
			_, payload, err := readClientMessage(t, client)
			if len(payload) != 0 || websocket.CloseStatus(err) != websocket.StatusInternalError {
				t.Fatalf("failed attempt escaped: payload=%s err=%v", payload, err)
			}
			waitForAttempts(t, recorder, 0, 1)
			if recorder.Failures()[0].RuntimeKind() != scenario.kind {
				t.Fatalf("failure kind = %s, want %s", recorder.Failures()[0].RuntimeKind(), scenario.kind)
			}
		})
	}
}

func TestCapacityAfterSemanticOutputRelaysOriginalError(t *testing.T) {
	const failure = `{"type":"response.failed","response":{"error":{"code":"model_at_capacity"}}}`
	for name, output := range map[string]string{
		"text":           `{"type":"response.output_text.delta","delta":"already visible"}`,
		"tool call":      `{"type":"response.output_item.added","item":{"type":"function_call","call_id":"already delivered"}}`,
		"created output": `{"type":"response.created","response":{"output":[{"type":"function_call","call_id":"already delivered"}]}}`,
	} {
		t.Run(name, func(t *testing.T) {
			client, recorder := runFailureScenario(t, []string{output, failure})
			for _, want := range []string{output, failure} {
				_, payload, err := readClientMessage(t, client)
				if err != nil || string(payload) != want {
					t.Fatalf("semantic output/error suppressed: payload=%s err=%v want=%s", payload, err, want)
				}
			}
			waitForAttempts(t, recorder, 0, 1)
		})
	}
}

// WebSocket 1000 只说明连接正常关闭，不能替代 Responses 的完成终态。
func TestNormalUpstreamCloseRequiresCompletedResponse(t *testing.T) {
	for _, scenario := range []struct {
		name      string
		frame     string
		closeCode websocket.StatusCode
		successes int
		failures  int
	}{
		{"before output", "", websocket.StatusInternalError, 0, 1},
		{"after output", `{"type":"response.output_text.delta","delta":"partial"}`, websocket.StatusNormalClosure, 0, 1},
		{"after completed", `{"type":"response.completed","response":{"id":"completed"}}`, websocket.StatusNormalClosure, 1, 0},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			upstream := newWebSocketUpstream(t, func(connection *websocket.Conn) {
				readOneUpstreamRequest(t, connection)
				if scenario.frame != "" {
					writeUpstreamText(t, connection, scenario.frame)
				}
				_ = connection.Close(websocket.StatusNormalClosure, "normal closure")
			})
			recorder := &attemptRecorder{}
			handler := newTestHandler(t, upstream.URL, recorder)
			server := httptest.NewServer(handler)
			defer server.Close()
			client, _ := dialGateway(t, server.URL, nil)
			defer client.CloseNow()
			writeClientText(t, client, []byte(`{"type":"response.create","model":"gpt-5.6-sol","input":[]}`))
			if scenario.frame != "" {
				_, payload, err := readClientMessage(t, client)
				if err != nil || string(payload) != scenario.frame {
					t.Fatalf("frame relay payload=%s err=%v", payload, err)
				}
			}
			_, _, err := readClientMessage(t, client)
			if websocket.CloseStatus(err) != scenario.closeCode {
				t.Fatalf("close status=%v want=%v err=%v", websocket.CloseStatus(err), scenario.closeCode, err)
			}
			waitForAttempts(t, recorder, scenario.successes, scenario.failures)
			if scenario.failures > 0 && recorder.Failures()[0].RuntimeKind() != runtimecore.FailureStreamDisconnected {
				t.Fatalf("failure kind=%s", recorder.Failures()[0].RuntimeKind())
			}
		})
	}
}
