package aihserver_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/madou1217/ai_home/internal/adapters/codex/responseswebsocket"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

// TestServerRoutesCodexResponsesWebSocketThroughDatabaseAccount 验证真实 Go Host
// 的 mux、aih.db 模型倒排、统一 Recruiter、数据库凭据和 WS 上游完整闭环。
func TestServerRoutesCodexResponsesWebSocketThroughDatabaseAccount(t *testing.T) {
	t.Parallel()

	upstreamHeaders := make(chan http.Header, 1)
	upstreamFrame := make(chan []byte, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		upstreamHeaders <- request.Header.Clone()
		connection, err := websocket.Accept(response, request, nil)
		if err != nil {
			return
		}
		defer connection.CloseNow()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		messageType, payload, err := connection.Read(ctx)
		if err != nil || messageType != websocket.MessageText {
			return
		}
		upstreamFrame <- append([]byte(nil), payload...)
		_ = connection.Write(
			ctx,
			websocket.MessageText,
			[]byte(`{"type":"response.completed","response":{"id":"resp_host_ws"}}`),
		)
	}))
	defer upstream.Close()

	baseURL, client := startTestServer(t)
	payload, err := json.Marshal(map[string]any{
		"provider_id": "codex",
		"auth": map[string]string{
			"kind":     "api_key",
			"api_key":  "synthetic-host-ws-key",
			"base_url": upstream.URL,
		},
	})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	created := performRequest(
		t,
		client,
		http.MethodPost,
		baseURL+accountsapi.CollectionPath,
		testManagementKey,
		payload,
	)
	assertStatus(t, created, http.StatusCreated)
	waitForServerModels(t, client, baseURL, []string{"gpt-5.6-sol"})

	header := make(http.Header)
	header.Set("Authorization", "Bearer "+testClientKey)
	header.Set("thread-id", "host-thread")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection, response, err := websocket.Dial(
		ctx,
		baseURL+"/v1/responses",
		&websocket.DialOptions{HTTPHeader: header},
	)
	if err != nil {
		t.Fatalf("websocket.Dial() response=%#v error=%v", response, err)
	}
	defer connection.CloseNow()
	requestFrame := []byte(
		`{"type":"response.create","model":"gpt-5.6-sol","input":[],"host_unknown":true}`,
	)
	if err := connection.Write(
		ctx,
		websocket.MessageText,
		requestFrame,
	); err != nil {
		t.Fatalf("connection.Write() error = %v", err)
	}
	messageType, responseFrame, err := connection.Read(ctx)
	if err != nil ||
		messageType != websocket.MessageText ||
		string(responseFrame) != `{"type":"response.completed","response":{"id":"resp_host_ws"}}` {
		t.Fatalf("connection.Read() type=%v payload=%s error=%v", messageType, responseFrame, err)
	}
	if got := <-upstreamFrame; string(got) != string(requestFrame) {
		t.Fatalf("upstream frame = %s", got)
	}
	headers := <-upstreamHeaders
	if headers.Get("Authorization") != "Bearer synthetic-host-ws-key" ||
		headers.Get("OpenAI-Beta") != responseswebsocket.BetaHeaderValue ||
		headers.Get("thread-id") != "host-thread" ||
		headers.Get(responseswebsocket.HopHeader) != responseswebsocket.HopValue {
		t.Fatalf("upstream headers = %#v", headers)
	}
}
