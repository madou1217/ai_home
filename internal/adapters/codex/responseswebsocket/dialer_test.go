package responseswebsocket_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
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

// TestDialerSupportsAliasOnlyTLSUpstream 使用真实 TLS/Upgrade 验证非标准入口。
func TestDialerSupportsAliasOnlyTLSUpstream(t *testing.T) {
	t.Parallel()
	var mu sync.Mutex
	var paths []string
	var headers []http.Header
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths = append(paths, r.URL.Path)
		headers = append(headers, r.Header.Clone())
		mu.Unlock()
		if r.URL.Path != "/llm/api/v1/responses/ws" {
			http.NotFound(w, r)
			return
		}
		connection, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer connection.CloseNow()
		for {
			kind, data, err := connection.Read(r.Context())
			if err != nil {
				return
			}
			if connection.Write(r.Context(), kind, data) != nil {
				return
			}
		}
	}))
	defer upstream.Close()
	credential, err := codexauth.NewAPIKeyAuth(codexauth.APIKeyInput{
		APIKey: "database-secret", BaseURL: upstream.URL + "/llm/api/v1/",
	})
	if err != nil {
		t.Fatal(err)
	}
	client := upstream.Client() // 仅信任该测试证书，不关闭 TLS 校验。
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	dialer, err := responseswebsocket.NewDialer(client)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection, response, err := dialer.Connect(ctx, credential, http.Header{
		"Authorization": {"Bearer client-key"}, "Thread-Id": {"thread-fixture"},
		"Cookie": {"must-not-forward"},
	}, "")
	if err != nil {
		t.Fatal(err)
	}
	defer connection.CloseNow()
	if response.StatusCode != http.StatusSwitchingProtocols || response.TLS == nil {
		t.Fatal("未通过真实 TLS/101 建立连接")
	}
	for _, kind := range []websocket.MessageType{websocket.MessageText, websocket.MessageBinary} {
		for _, payload := range []string{
			`{"type":"response.create","input":[]}`,
			`{"type":"response.create","previous_response_id":"first-response","input":[{"type":"function_call_output","call_id":"tool-call","output":"fixture"}]}`,
		} {
			if err := connection.Write(ctx, kind, []byte(payload)); err != nil {
				t.Fatal(err)
			}
			actualKind, actual, err := connection.Read(ctx)
			if err != nil || actualKind != kind || string(actual) != payload {
				t.Fatalf("帧未原样转发: kind=%v error=%v", actualKind, err)
			}
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(paths, []string{"/llm/api/v1/responses", "/llm/api/v1/responses/ws"}) {
		t.Fatalf("握手路径 = %v", paths)
	}
	for _, header := range headers {
		if header.Get("Authorization") != "Bearer database-secret" ||
			header.Get("Thread-Id") != "thread-fixture" || header.Get("Cookie") != "" {
			t.Fatal("别名未保留同一账号和协议头边界")
		}
	}
}

// TestDialerAliasFailureBoundaries 验证仅 HTTP 404 可触发一次别名，其他错误不重试。
func TestDialerAliasFailureBoundaries(t *testing.T) {
	for _, status := range []int{404, 401, 403, 429, 500, 302} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			t.Parallel()
			var mu sync.Mutex
			var paths []string
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				paths = append(paths, r.URL.Path)
				mu.Unlock()
				w.Header().Set("Location", "/must-not-follow")
				w.WriteHeader(status)
			}))
			defer upstream.Close()
			credential, err := codexauth.NewAPIKeyAuth(codexauth.APIKeyInput{
				APIKey: "database-secret", BaseURL: upstream.URL + "/v1",
			})
			if err != nil {
				t.Fatal(err)
			}
			dialer, err := responseswebsocket.NewDialer(&http.Client{
				CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
			})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			connection, response, err := dialer.Connect(ctx, credential, nil, "")
			if err == nil || connection != nil || response == nil || response.StatusCode != status {
				t.Fatalf("Connect() 未返回原握手错误: %v", err)
			}
			expected := []string{"/v1/responses"}
			if status == http.StatusNotFound {
				expected = append(expected, "/v1/responses/ws")
			}
			mu.Lock()
			defer mu.Unlock()
			if !reflect.DeepEqual(paths, expected) {
				t.Fatalf("握手路径 = %v", paths)
			}
		})
	}
}

// TestDialerAliasRespectsCancellation 验证两次尝试共享调用方取消/截止时间。
func TestDialerAliasRespectsCancellation(t *testing.T) {
	t.Parallel()
	aliasStarted := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/responses" {
			http.NotFound(w, r)
			return
		}
		close(aliasStarted)
		<-r.Context().Done()
	}))
	defer upstream.Close()
	credential, err := codexauth.NewAPIKeyAuth(codexauth.APIKeyInput{
		APIKey: "database-secret", BaseURL: upstream.URL + "/v1",
	})
	if err != nil {
		t.Fatal(err)
	}
	dialer, err := responseswebsocket.NewDialer(upstream.Client())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go func() {
		select {
		case <-aliasStarted:
			cancel()
		case <-ctx.Done():
		}
	}()
	connection, _, err := dialer.Connect(ctx, credential, nil, "")
	if err == nil || connection != nil || ctx.Err() == nil {
		t.Fatalf("取消握手未生效: %v", err)
	}
}
