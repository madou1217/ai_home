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

func runQuotaScenario(t *testing.T, upstreamFrames []string) (*websocket.Conn, *attemptRecorder) {
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
			client, recorder := runQuotaScenario(t, frames)
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
	client, _ := runQuotaScenario(t, []string{
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
