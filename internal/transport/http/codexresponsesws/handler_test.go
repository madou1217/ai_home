package codexresponsesws_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/madou1217/ai_home/application/codexwebsocket"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/codex/responseswebsocket"
	"github.com/madou1217/ai_home/internal/transport/http/codexresponsesws"
)

const syntheticClientKey = "synthetic-client-key"

// TestHandlerRelaysTwoTurnsWithoutReencodingFrames 验证未知字段、双轮连接、
// previous_response_id、压缩协商和成功终态都通过真实 WS 链路。
func TestHandlerRelaysTwoTurnsWithoutReencodingFrames(t *testing.T) {
	t.Parallel()

	requests := make(chan []byte, 2)
	upstream := newWebSocketUpstream(t, func(connection *websocket.Conn) {
		for index := 1; index <= 2; index++ {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			messageType, payload, err := connection.Read(ctx)
			cancel()
			if err != nil || messageType != websocket.MessageText {
				return
			}
			requests <- append([]byte(nil), payload...)
			created := fmt.Sprintf(
				`{"type":"response.created","response":{"id":"resp_%d"},"future":{"kept":true}}`,
				index,
			)
			completed := fmt.Sprintf(
				`{"type":"response.completed","response":{"id":"resp_%d"}}`,
				index,
			)
			writeUpstreamText(t, connection, created)
			writeUpstreamText(t, connection, completed)
		}
	})
	recorder := &attemptRecorder{}
	handler := newTestHandler(t, upstream.URL, recorder)
	server := httptest.NewServer(handler)
	defer server.Close()

	client, response := dialGateway(t, server.URL, nil)
	defer client.CloseNow()
	if response == nil || !strings.Contains(
		response.Header.Get("Sec-WebSocket-Extensions"),
		"permessage-deflate",
	) {
		t.Fatalf("client upgrade headers = %#v", response)
	}
	first := []byte(`{"type":"response.create","model":"gpt-5.6-sol","input":[],"future":{"opaque":1}}`)
	second := []byte(`{"type":"response.create","model":"gpt-5.6-sol","previous_response_id":"resp_1","input":[{"type":"message"}],"future":{"opaque":2}}`)
	writeClientText(t, client, first)
	firstEvents := readUntilCompleted(t, client)
	writeClientText(t, client, second)
	secondEvents := readUntilCompleted(t, client)
	if got := <-requests; string(got) != string(first) {
		t.Fatalf("first upstream frame = %s", got)
	}
	if got := <-requests; string(got) != string(second) {
		t.Fatalf("second upstream frame = %s", got)
	}
	if firstEvents[0] != `{"type":"response.created","response":{"id":"resp_1"},"future":{"kept":true}}` ||
		secondEvents[0] != `{"type":"response.created","response":{"id":"resp_2"},"future":{"kept":true}}` {
		t.Fatalf("relayed events first=%q second=%q", firstEvents, secondEvents)
	}
	waitForAttempts(t, recorder, 2, 0)
}

// TestHandlerClassifiesWrapped429BeforeRelaying 验证真实 WS error 帧在客户端
// 可见前写入账号模型级限流状态，正文仍保持原样。
func TestHandlerClassifiesWrapped429BeforeRelaying(t *testing.T) {
	t.Parallel()

	errorFrame := `{"type":"error","status":429,"error":{"code":"rate_limit_exceeded","message":"upstream-private"},"headers":{"retry-after":"3"}}`
	upstream := newWebSocketUpstream(t, func(connection *websocket.Conn) {
		readOneUpstreamRequest(t, connection)
		writeUpstreamText(t, connection, errorFrame)
	})
	recorder := &attemptRecorder{}
	handler := newTestHandler(t, upstream.URL, recorder)
	server := httptest.NewServer(handler)
	defer server.Close()
	client, _ := dialGateway(t, server.URL, nil)
	defer client.CloseNow()
	writeClientText(t, client, []byte(
		`{"type":"response.create","model":"gpt-5.6-sol","input":[]}`,
	))
	messageType, payload, err := readClientMessage(t, client)
	if err != nil || messageType != websocket.MessageText || string(payload) != errorFrame {
		t.Fatalf("error relay type=%v payload=%s error=%v", messageType, payload, err)
	}
	waitForAttempts(t, recorder, 0, 1)
	failure := recorder.Failures()[0]
	if failure.RuntimeKind() != runtimecore.FailureRateLimited ||
		failure.RetryAfter() != 3*time.Second {
		t.Fatalf("failure = %#v", failure)
	}
}

// TestHandlerDoesNotRecordWarmupFailure 验证 generate:false 预热不改变账号运行态。
func TestHandlerDoesNotRecordWarmupFailure(t *testing.T) {
	t.Parallel()

	upstream := newWebSocketUpstream(t, func(connection *websocket.Conn) {
		readOneUpstreamRequest(t, connection)
		writeUpstreamText(
			t,
			connection,
			`{"type":"error","status":429,"error":{"code":"rate_limit_exceeded"}}`,
		)
	})
	recorder := &attemptRecorder{}
	handler := newTestHandler(t, upstream.URL, recorder)
	server := httptest.NewServer(handler)
	defer server.Close()
	client, _ := dialGateway(t, server.URL, nil)
	defer client.CloseNow()
	writeClientText(t, client, []byte(
		`{"type":"response.create","model":"gpt-5.6-sol","generate":false,"input":[]}`,
	))
	_, _, _ = readClientMessage(t, client)
	time.Sleep(20 * time.Millisecond)
	if recorder.SuccessCount() != 0 || len(recorder.Failures()) != 0 {
		t.Fatalf("warmup recorder successes=%d failures=%d", recorder.SuccessCount(), len(recorder.Failures()))
	}
}

// TestHandlerRejectsUnauthorizedAndCrossOriginBeforeUpgrade 验证凭据与 Origin
// 校验都发生在 101 和账号选择前。
func TestHandlerRejectsUnauthorizedAndCrossOriginBeforeUpgrade(t *testing.T) {
	t.Parallel()

	recorder := &attemptRecorder{}
	handler := newTestHandler(t, "http://127.0.0.1:1", recorder)
	server := httptest.NewServer(handler)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, response, err := websocket.Dial(ctx, server.URL, nil)
	if err == nil || response == nil || response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthorized response=%#v error=%v", response, err)
	}
	header := make(http.Header)
	header.Set("Authorization", "Bearer "+syntheticClientKey)
	header.Set("Origin", "https://evil.example")
	_, response, err = websocket.Dial(ctx, server.URL, &websocket.DialOptions{
		HTTPHeader: header,
	})
	if err == nil || response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin response=%#v error=%v", response, err)
	}
}

// TestHandlerRejectsBinaryAndOversizedFirstFrames 验证二进制业务帧与解压后超大
// 消息使用标准 Close code 失败关闭，不进入账号选择。
func TestHandlerRejectsBinaryAndOversizedFirstFrames(t *testing.T) {
	t.Parallel()

	recorder := &attemptRecorder{}
	handler := newTestHandler(t, "http://127.0.0.1:1", recorder)
	server := httptest.NewServer(handler)
	defer server.Close()

	t.Run("binary", func(t *testing.T) {
		client, _ := dialGateway(t, server.URL, nil)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := client.Write(ctx, websocket.MessageBinary, []byte{1, 2, 3}); err != nil {
			t.Fatalf("Write(binary) error = %v", err)
		}
		messageType, payload, err := client.Read(ctx)
		if err != nil || messageType != websocket.MessageText ||
			!strings.Contains(string(payload), "unsupported_frame_type") {
			t.Fatalf("binary rejection type=%v payload=%s error=%v", messageType, payload, err)
		}
		_ = client.CloseNow()
	})

	t.Run("message too big", func(t *testing.T) {
		client, _ := dialGateway(t, server.URL, nil)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		payload := make([]byte, codexresponsesws.MaxMessageBytes+1)
		for index := range payload {
			payload[index] = 'x'
		}
		if err := client.Write(ctx, websocket.MessageText, payload); err != nil {
			t.Fatalf("Write(too big) error = %v", err)
		}
		_, _, err := client.Read(ctx)
		if websocket.CloseStatus(err) != websocket.StatusMessageTooBig {
			t.Fatalf("Read(too big) error = %v status=%v", err, websocket.CloseStatus(err))
		}
		_ = client.CloseNow()
	})
}

// TestHandlerPropagatesUpstreamCloseAndRecordsIncomplete 验证上游关闭码/原因对称
// 传播，未完成真实请求按断流提交而不是伪造成功。
func TestHandlerPropagatesUpstreamCloseAndRecordsIncomplete(t *testing.T) {
	t.Parallel()

	upstream := newWebSocketUpstream(t, func(connection *websocket.Conn) {
		readOneUpstreamRequest(t, connection)
		_ = connection.Close(websocket.StatusGoingAway, "rotate connection")
	})
	recorder := &attemptRecorder{}
	handler := newTestHandler(t, upstream.URL, recorder)
	server := httptest.NewServer(handler)
	defer server.Close()
	client, _ := dialGateway(t, server.URL, nil)
	defer client.CloseNow()
	writeClientText(t, client, []byte(
		`{"type":"response.create","model":"gpt-5.6-sol","input":[]}`,
	))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err := client.Read(ctx)
	var closeError websocket.CloseError
	if !errors.As(err, &closeError) ||
		closeError.Code != websocket.StatusGoingAway ||
		closeError.Reason != "rotate connection" {
		t.Fatalf("client close error = %v", err)
	}
	waitForAttempts(t, recorder, 0, 1)
}

// TestHandlerRejectsConcurrentTurnsWithoutBlamingAccount 验证同连接并发
// response.create 属于客户端协议错误，不写账号 cooldown。
func TestHandlerRejectsConcurrentTurnsWithoutBlamingAccount(t *testing.T) {
	t.Parallel()

	firstSeen := make(chan struct{}, 1)
	upstream := newWebSocketUpstream(t, func(connection *websocket.Conn) {
		readOneUpstreamRequest(t, connection)
		firstSeen <- struct{}{}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_, _, _ = connection.Read(ctx)
	})
	recorder := &attemptRecorder{}
	handler := newTestHandler(t, upstream.URL, recorder)
	server := httptest.NewServer(handler)
	defer server.Close()
	client, _ := dialGateway(t, server.URL, nil)
	defer client.CloseNow()
	request := []byte(`{"type":"response.create","model":"gpt-5.6-sol","input":[]}`)
	writeClientText(t, client, request)
	<-firstSeen
	writeClientText(t, client, request)
	messageType, payload, err := readClientMessage(t, client)
	if err != nil || messageType != websocket.MessageText ||
		!strings.Contains(string(payload), "concurrent_response_create") {
		t.Fatalf("concurrent rejection type=%v payload=%s error=%v", messageType, payload, err)
	}
	time.Sleep(20 * time.Millisecond)
	if recorder.SuccessCount() != 0 || len(recorder.Failures()) != 0 {
		t.Fatalf("concurrent recorder successes=%d failures=%d", recorder.SuccessCount(), len(recorder.Failures()))
	}
}

// TestHandlerRejectsBinaryUpstreamAsMalformedWithoutCooldown 验证上游二进制业务
// 帧以 1003 关闭，并提交 no-state-change 的 malformed 分类。
func TestHandlerRejectsBinaryUpstreamAsMalformedWithoutCooldown(t *testing.T) {
	t.Parallel()

	upstream := newWebSocketUpstream(t, func(connection *websocket.Conn) {
		readOneUpstreamRequest(t, connection)
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = connection.Write(ctx, websocket.MessageBinary, []byte{1, 2, 3})
	})
	recorder := &attemptRecorder{}
	handler := newTestHandler(t, upstream.URL, recorder)
	server := httptest.NewServer(handler)
	defer server.Close()
	client, _ := dialGateway(t, server.URL, nil)
	defer client.CloseNow()
	writeClientText(t, client, []byte(
		`{"type":"response.create","model":"gpt-5.6-sol","input":[]}`,
	))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err := client.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusUnsupportedData {
		t.Fatalf("binary upstream close = %v status=%v", err, websocket.CloseStatus(err))
	}
	waitForAttempts(t, recorder, 0, 1)
	if recorder.Failures()[0].RuntimeKind() != runtimecore.FailureMalformedResponse {
		t.Fatalf("binary upstream failure = %#v", recorder.Failures()[0])
	}
}

// TestHandlerDoesNotRecordNormalUpstreamClose 验证没有完成事件的 1000 仍是正常
// 连接关闭语义，不把健康账号误记为断流失败。
func TestHandlerDoesNotRecordNormalUpstreamClose(t *testing.T) {
	t.Parallel()

	upstream := newWebSocketUpstream(t, func(connection *websocket.Conn) {
		readOneUpstreamRequest(t, connection)
		_ = connection.Close(websocket.StatusNormalClosure, "done")
	})
	recorder := &attemptRecorder{}
	handler := newTestHandler(t, upstream.URL, recorder)
	server := httptest.NewServer(handler)
	defer server.Close()
	client, _ := dialGateway(t, server.URL, nil)
	defer client.CloseNow()
	writeClientText(t, client, []byte(
		`{"type":"response.create","model":"gpt-5.6-sol","input":[]}`,
	))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err := client.Read(ctx)
	if websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Fatalf("normal upstream close = %v status=%v", err, websocket.CloseStatus(err))
	}
	time.Sleep(20 * time.Millisecond)
	if recorder.SuccessCount() != 0 || len(recorder.Failures()) != 0 {
		t.Fatalf("normal close recorder successes=%d failures=%d", recorder.SuccessCount(), len(recorder.Failures()))
	}
}

// TestHandlerCloseTerminatesHijackedSessions 验证显式关闭不会遗留 net/http
// 无法管理的 WS 连接，并拒绝后续 Upgrade。
func TestHandlerCloseTerminatesHijackedSessions(t *testing.T) {
	t.Parallel()

	requestSeen := make(chan struct{}, 1)
	upstream := newWebSocketUpstream(t, func(connection *websocket.Conn) {
		readOneUpstreamRequest(t, connection)
		requestSeen <- struct{}{}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _, _ = connection.Read(ctx)
	})
	handler := newTestHandler(t, upstream.URL, &attemptRecorder{})
	server := httptest.NewServer(handler)
	defer server.Close()
	client, _ := dialGateway(t, server.URL, nil)
	writeClientText(t, client, []byte(
		`{"type":"response.create","model":"gpt-5.6-sol","input":[]}`,
	))
	<-requestSeen
	if err := handler.Close(); err != nil {
		t.Fatalf("Handler.Close() error = %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _, err := client.Read(ctx)
	if err == nil {
		t.Fatal("client remained open after Handler.Close()")
	}
	_ = client.CloseNow()
	_, response, err := websocket.Dial(ctx, server.URL, &websocket.DialOptions{
		HTTPHeader: authorizationHeader(),
	})
	if err == nil || response == nil || response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("post-close response=%#v error=%v", response, err)
	}
}

func newTestHandler(
	t *testing.T,
	upstreamBaseURL string,
	recorder *attemptRecorder,
) *codexresponsesws.Handler {
	t.Helper()
	credential, err := codexauth.NewAPIKeyAuth(codexauth.APIKeyInput{
		APIKey:  "synthetic-upstream-key",
		BaseURL: upstreamBaseURL,
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	capabilities, err := inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
		inference.CapabilityStreaming,
	)
	if err != nil {
		t.Fatalf("NewCapabilitySet() error = %v", err)
	}
	route, err := inferencegateway.NewRoute(
		inference.ProviderCodex,
		inference.ProtocolCodexResponses,
		"gpt-5.6-sol",
		capabilities,
	)
	if err != nil {
		t.Fatalf("NewRoute() error = %v", err)
	}
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	selection, err := codexwebsocket.NewSelection(route, accountRef, credential)
	if err != nil {
		t.Fatalf("NewSelection() error = %v", err)
	}
	dialer, err := responseswebsocket.NewDialer(&http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	})
	if err != nil {
		t.Fatalf("NewDialer() error = %v", err)
	}
	handler, err := codexresponsesws.NewHandler(codexresponsesws.Dependencies{
		Authorizer:     bearerAuthorizer{},
		Selector:       selectionStub{selection: selection},
		Upstream:       dialer,
		Attempts:       recorder,
		ModelRefreshes: modelRefreshStub{},
		Clock: func() time.Time {
			return time.Date(2026, 8, 10, 8, 0, 0, 0, time.UTC)
		},
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	t.Cleanup(func() {
		_ = handler.Close()
	})
	return handler
}

func newWebSocketUpstream(
	t *testing.T,
	run func(connection *websocket.Conn),
) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.URL.Path != "/responses" ||
			request.Header.Get("Authorization") != "Bearer synthetic-upstream-key" ||
			request.Header.Get("OpenAI-Beta") != responseswebsocket.BetaHeaderValue {
			http.Error(response, "invalid upstream handshake", http.StatusBadRequest)
			return
		}
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
		run(connection)
	}))
	t.Cleanup(server.Close)
	return server
}

func dialGateway(
	t *testing.T,
	baseURL string,
	extra http.Header,
) (*websocket.Conn, *http.Response) {
	t.Helper()
	header := authorizationHeader()
	for name, values := range extra {
		header[name] = append([]string(nil), values...)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	connection, response, err := websocket.Dial(ctx, baseURL, &websocket.DialOptions{
		HTTPHeader:      header,
		CompressionMode: websocket.CompressionContextTakeover,
	})
	if err != nil {
		t.Fatalf("websocket.Dial() error = %v response=%#v", err, response)
	}
	return connection, response
}

func authorizationHeader() http.Header {
	header := make(http.Header)
	header.Set("Authorization", "Bearer "+syntheticClientKey)
	return header
}

func writeClientText(
	t *testing.T,
	client *websocket.Conn,
	payload []byte,
) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := client.Write(ctx, websocket.MessageText, payload); err != nil {
		t.Fatalf("client.Write() error = %v", err)
	}
}

func writeUpstreamText(
	t *testing.T,
	connection *websocket.Conn,
	payload string,
) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := connection.Write(ctx, websocket.MessageText, []byte(payload)); err != nil {
		t.Errorf("upstream.Write() error = %v", err)
	}
}

func readOneUpstreamRequest(t *testing.T, connection *websocket.Conn) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	messageType, _, err := connection.Read(ctx)
	if err != nil || messageType != websocket.MessageText {
		t.Errorf("upstream.Read() type=%v error=%v", messageType, err)
	}
}

func readClientMessage(
	t *testing.T,
	client *websocket.Conn,
) (websocket.MessageType, []byte, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return client.Read(ctx)
}

func readUntilCompleted(t *testing.T, client *websocket.Conn) []string {
	t.Helper()
	events := make([]string, 0, 2)
	for len(events) < 8 {
		messageType, payload, err := readClientMessage(t, client)
		if err != nil || messageType != websocket.MessageText {
			t.Fatalf("client.Read() type=%v payload=%s error=%v", messageType, payload, err)
		}
		events = append(events, string(payload))
		var event struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(payload, &event) == nil && event.Type == "response.completed" {
			return events
		}
	}
	t.Fatal("response.completed not observed")
	return nil
}

func waitForAttempts(
	t *testing.T,
	recorder *attemptRecorder,
	wantSuccess int,
	wantFailure int,
) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if recorder.SuccessCount() == wantSuccess &&
			len(recorder.Failures()) == wantFailure {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf(
		"attempts successes=%d failures=%d, want %d/%d",
		recorder.SuccessCount(),
		len(recorder.Failures()),
		wantSuccess,
		wantFailure,
	)
}

type bearerAuthorizer struct{}

func (bearerAuthorizer) Authorized(request *http.Request) bool {
	return request != nil &&
		request.Header.Get("Authorization") == "Bearer "+syntheticClientKey
}

type selectionStub struct {
	selection codexwebsocket.Selection
}

func (stub selectionStub) Select(
	_ context.Context,
	request codexwebsocket.Request,
) (codexwebsocket.Selection, error) {
	if request.Model != "gpt-5.6-sol" ||
		request.ClientProtocol != inference.ClientProtocolOpenAIResponses {
		return codexwebsocket.Selection{}, codexwebsocket.ErrInvalidRequest
	}
	return stub.selection, nil
}

type modelRefreshStub struct{}

func (modelRefreshStub) ScheduleModelRefresh(
	context.Context,
	accountcore.AccountRef,
	string,
) error {
	return nil
}

type attemptRecorder struct {
	mu        sync.Mutex
	successes []runtimecore.ModelRoute
	failures  []inferencegateway.AttemptFailure
}

func (recorder *attemptRecorder) RecordSuccess(
	_ context.Context,
	route runtimecore.ModelRoute,
) error {
	recorder.mu.Lock()
	recorder.successes = append(recorder.successes, route)
	recorder.mu.Unlock()
	return nil
}

func (recorder *attemptRecorder) RecordFailure(
	_ context.Context,
	_ runtimecore.ModelRoute,
	failure inferencegateway.AttemptFailure,
) error {
	recorder.mu.Lock()
	recorder.failures = append(recorder.failures, failure)
	recorder.mu.Unlock()
	return nil
}

func (recorder *attemptRecorder) SuccessCount() int {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return len(recorder.successes)
}

func (recorder *attemptRecorder) Failures() []inferencegateway.AttemptFailure {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return append([]inferencegateway.AttemptFailure(nil), recorder.failures...)
}
