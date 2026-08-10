package responseswebsocket_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/codex/responseswebsocket"
)

// TestDialerProjectsOfficialHeadersAndNegotiatesCompression 验证认证覆盖、官方
// Beta、关联头白名单和 permessage-deflate 都真实出现在握手中。
func TestDialerProjectsOfficialHeadersAndNegotiatesCompression(t *testing.T) {
	t.Parallel()

	observed := make(chan http.Header, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		observed <- request.Header.Clone()
		connection, err := websocket.Accept(
			response,
			request,
			&websocket.AcceptOptions{
				CompressionMode: websocket.CompressionContextTakeover,
			},
		)
		if err != nil {
			return
		}
		defer connection.CloseNow()
		messageType, payload, readErr := connection.Read(request.Context())
		if readErr == nil {
			_ = connection.Write(request.Context(), messageType, payload)
		}
	}))
	defer upstream.Close()

	credential, err := codexauth.NewAPIKeyAuth(codexauth.APIKeyInput{
		APIKey:  "database-secret",
		BaseURL: upstream.URL,
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	dialer, err := responseswebsocket.NewDialer(&http.Client{
		Timeout: 5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	})
	if err != nil {
		t.Fatalf("NewDialer() error = %v", err)
	}
	clientHeader := make(http.Header)
	clientHeader.Set("Authorization", "Bearer untrusted-client-key")
	clientHeader.Set("OpenAI-Beta", "untrusted-beta")
	clientHeader.Set("thread-id", "thread-1")
	clientHeader.Set("X-Untrusted", "must-not-pass")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection, response, err := dialer.Connect(
		ctx,
		credential,
		clientHeader,
		"127.0.0.1:1",
	)
	if err != nil {
		t.Fatalf("Connect() error = %v", err)
	}
	defer connection.CloseNow()
	if response == nil ||
		!strings.Contains(
			response.Header.Get("Sec-WebSocket-Extensions"),
			"permessage-deflate",
		) {
		t.Fatalf("upgrade response headers = %#v", response)
	}
	header := <-observed
	if header.Get("Authorization") != "Bearer database-secret" ||
		header.Get("OpenAI-Beta") != responseswebsocket.BetaHeaderValue ||
		header.Get("Originator") != "codex_cli_rs" ||
		header.Get("thread-id") != "thread-1" ||
		header.Get(responseswebsocket.HopHeader) != responseswebsocket.HopValue ||
		header.Get("X-Untrusted") != "" {
		t.Fatalf("upstream headers = %#v", header)
	}
	payload := []byte(`{"type":"response.create","model":"gpt-5.6-sol"}`)
	if err := connection.Write(ctx, websocket.MessageText, payload); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	messageType, echoed, err := connection.Read(ctx)
	if err != nil || messageType != websocket.MessageText || string(echoed) != string(payload) {
		t.Fatalf("Read() type=%v payload=%q error=%v", messageType, echoed, err)
	}
}

// TestDialerRejectsDirectSelfLoop 验证 API Key 自定义端点不能重新进入当前 Host。
func TestDialerRejectsDirectSelfLoop(t *testing.T) {
	t.Parallel()

	credential, err := codexauth.NewAPIKeyAuth(codexauth.APIKeyInput{
		APIKey:  "database-secret",
		BaseURL: "http://127.0.0.1:9527/v1",
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	dialer, err := responseswebsocket.NewDialer(http.DefaultClient)
	if err != nil {
		t.Fatalf("NewDialer() error = %v", err)
	}
	_, _, err = dialer.Connect(
		context.Background(),
		credential,
		nil,
		"127.0.0.1:9527",
	)
	if err != responseswebsocket.ErrSelfLoop {
		t.Fatalf("Connect(self loop) error = %v", err)
	}
}
