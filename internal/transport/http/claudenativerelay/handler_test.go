package claudenativerelay

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	gatewaycontract "github.com/madou1217/ai_home/internal/contracts/claudegateway"
)

const (
	testRelayToken  = "relay-token-bound-to-one-account"
	testAccessToken = "sk-ant-oat01-native-relay-database"
)

// TestHandlerPreservesNativeRequestAndReplacesOnlyCredential 验证真实 HTTP
// Relay 不重编码 attested body，并保留官方客户端安全 Header。
func TestHandlerPreservesNativeRequestAndReplacesOnlyCredential(
	t *testing.T,
) {
	t.Parallel()

	body := []byte("{\n" +
		`  "model":"claude-opus-5",` + "\n" +
		`  "system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.207.test; cc_entrypoint=cli; cch=12345;"}],` + "\n" +
		`  "messages":[{"role":"user","content":"relay"}]` + "\n" +
		"}")
	observed := make(chan observedUpstreamRequest, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		payload, _ := io.ReadAll(request.Body)
		observed <- observedUpstreamRequest{
			body:       payload,
			headers:    request.Header.Clone(),
			method:     request.Method,
			rawQuery:   request.URL.RawQuery,
			contentLen: request.ContentLength,
		}
		response.Header().Set("Content-Type", "text/event-stream")
		response.Header().Set("X-Upstream-Trace", "trace-safe")
		response.Header().Set("Connection", "X-Upstream-Hop")
		response.Header().Set("X-Upstream-Hop", "must-not-forward")
		response.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(
			response,
			"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
		)
	}))
	defer upstream.Close()

	accountRef, credential := newRelayOAuthCredential(t)
	rewriter := newRelayRewriteTransport(t, upstream.URL)
	handler := newRelayTestHandler(
		t,
		accountRef,
		credential,
		rewriter,
	)
	server := httptest.NewServer(handler)
	defer server.Close()

	request, err := http.NewRequest(
		http.MethodPost,
		server.URL+Path+"?"+nativeBetaQuery,
		bytes.NewReader(body),
	)
	if err != nil {
		t.Fatalf("http.NewRequest() error = %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	setNativeRelayHeaders(request)
	request.Header.Set("Authorization", "Bearer must-be-replaced")
	request.Header.Set(RelayTokenHeader, testRelayToken)
	request.Header.Set("X-Account-Ref", "acct_ffffffffffffffffffff")
	request.Header.Set("Connection", "X-Client-Hop")
	request.Header.Set("X-Client-Hop", "must-not-forward")

	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("http.Client.Do() error = %v", err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("io.ReadAll(response) error = %v", err)
	}
	captured := <-observed

	if response.StatusCode != http.StatusOK ||
		string(responseBody) !=
			"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n" ||
		response.Header.Get("X-Upstream-Trace") != "trace-safe" ||
		response.Header.Get("X-Upstream-Hop") != "" {
		t.Fatalf(
			"relay response status=%d headers=%v body=%q",
			response.StatusCode,
			response.Header,
			responseBody,
		)
	}
	if rewriter.originalEndpoint !=
		officialMessagesEndpoint+"?"+nativeBetaQuery ||
		captured.method != http.MethodPost ||
		captured.rawQuery != nativeBetaQuery ||
		captured.contentLen != int64(len(body)) ||
		!bytes.Equal(captured.body, body) {
		t.Fatalf(
			"upstream endpoint=%s method=%s query=%s content_length=%d body_equal=%t",
			rewriter.originalEndpoint,
			captured.method,
			captured.rawQuery,
			captured.contentLen,
			bytes.Equal(captured.body, body),
		)
	}
	if captured.headers.Get("Authorization") !=
		"Bearer "+testAccessToken ||
		captured.headers.Get("x-app") != "cli" ||
		captured.headers.Get("User-Agent") !=
			"claude-cli/2.1.220 (external, cli)" ||
		captured.headers.Get("X-Claude-Code-Session-Id") == "" ||
		!containsHeaderToken(
			captured.headers.Values("anthropic-beta"),
			oauthBeta,
		) ||
		captured.headers.Get(RelayTokenHeader) != "" ||
		captured.headers.Get("X-Account-Ref") != "" ||
		captured.headers.Get("X-Client-Hop") != "" {
		t.Fatalf("upstream headers = %v", captured.headers)
	}
	t.Logf(
		"POST %s payload_bytes=%d body_preserved=true response_status=%d response=%q",
		Path,
		len(body),
		response.StatusCode,
		responseBody,
	)
}

// TestHandlerRecordsPreCommitFailureAndSignalsAccountRetry 验证 Native OAuth
// 在 HTTP 响应提交前记录精确模型 cooldown，并向本地代理显式允许换号。
func TestHandlerRecordsPreCommitFailureAndSignalsAccountRetry(t *testing.T) {
	t.Parallel()

	accountRef, credential := newRelayOAuthCredential(t)
	recorder := &relayAttemptRecorder{}
	refreshes := &relayModelRefreshScheduler{}
	authorizer, err := NewScopedTokenAuthorizer(relayTokenResolver{
		token:      testRelayToken,
		accountRef: accountRef,
	})
	if err != nil {
		t.Fatalf("NewScopedTokenAuthorizer() error = %v", err)
	}
	client := &relayFailureClient{
		status: http.StatusText(http.StatusServiceUnavailable),
		code:   529,
		body:   `{"type":"error","error":{"type":"overloaded_error"}}`,
	}
	handler, err := NewHandler(Dependencies{
		Authorizer: authorizer,
		Credentials: &relayCredentialResolver{
			accountRef: accountRef,
			credential: credential,
		},
		Client:         client,
		Attempts:       recorder,
		ModelRefreshes: refreshes,
		Clock:          relayTestClock,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	request := httptest.NewRequest(
		http.MethodPost,
		Path,
		strings.NewReader(`{"model":"claude-opus-5"}`),
	)
	request.Header.Set("Content-Type", "application/json")
	setNativeRelayHeaders(request)
	request.Header.Set(RelayTokenHeader, testRelayToken)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != 529 ||
		response.Header().Get(gatewaycontract.RetryAccountHeader) !=
			gatewaycontract.RetryAccountValue ||
		response.Body.String() != client.body ||
		len(recorder.failures) != 1 ||
		recorder.failures[0].RuntimeKind() !=
			runtimecore.FailureModelOverloaded ||
		refreshes.calls != 0 {
		t.Fatalf(
			"status=%d retry=%q body=%q failures=%v refreshes=%d",
			response.Code,
			response.Header().Get(gatewaycontract.RetryAccountHeader),
			response.Body.String(),
			recorder.failures,
			refreshes.calls,
		)
	}
}

// TestHandlerPreservesStaleCredentialFailureResponseWithoutRuntimeWrite 验证请求读取
// v1 凭据后账号切到 v2，v1 的迟到 529 仍原样返回并保持换号语义，但不污染
// v2 的账号运行态。
func TestHandlerPreservesStaleCredentialFailureResponseWithoutRuntimeWrite(
	t *testing.T,
) {
	t.Parallel()

	accountRef, credential := newRelayOAuthCredential(t)
	recorder := &relayAttemptRecorder{}
	resolver := &relayCredentialResolver{
		accountRef: accountRef,
		credential: credential,
	}
	client := &relayFailureClient{
		status: http.StatusText(http.StatusServiceUnavailable),
		code:   529,
		body:   `{"type":"error","error":{"type":"overloaded_error"}}`,
		beforeReturn: func() {
			resolver.stale = true
		},
	}
	authorizer, err := NewScopedTokenAuthorizer(relayTokenResolver{
		token:      testRelayToken,
		accountRef: accountRef,
	})
	if err != nil {
		t.Fatalf("NewScopedTokenAuthorizer() error = %v", err)
	}
	handler, err := NewHandler(Dependencies{
		Authorizer:     authorizer,
		Credentials:    resolver,
		Client:         client,
		Attempts:       recorder,
		ModelRefreshes: &relayModelRefreshScheduler{},
		Clock:          relayTestClock,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	request := newNativeRelayRequest(
		t,
		`{"model":"claude-opus-5"}`,
	)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != 529 ||
		response.Header().Get(gatewaycontract.RetryAccountHeader) !=
			gatewaycontract.RetryAccountValue ||
		response.Body.String() != client.body {
		t.Fatalf(
			"status=%d retry=%q body=%q",
			response.Code,
			response.Header().Get(gatewaycontract.RetryAccountHeader),
			response.Body.String(),
		)
	}
	if len(recorder.failures) != 0 {
		t.Fatalf("runtime failures = %d, want 0", len(recorder.failures))
	}
}

// TestHandlerPreservesStaleCredentialSuccessWithoutRuntimeClear 验证 v1 Relay 请求
// 在凭据切到 v2 后迟到成功时仍原样交付响应，但不清除 v2 的运行态失败。
func TestHandlerPreservesStaleCredentialSuccessWithoutRuntimeClear(t *testing.T) {
	t.Parallel()

	accountRef, credential := newRelayOAuthCredential(t)
	recorder := &relayAttemptRecorder{}
	resolver := &relayCredentialResolver{
		accountRef: accountRef,
		credential: credential,
	}
	client := &relayFailureClient{
		status: http.StatusText(http.StatusOK),
		code:   http.StatusOK,
		body:   `{"type":"message","content":[{"type":"text","text":"ok"}]}`,
		header: http.Header{"Content-Type": []string{"application/json"}},
		beforeReturn: func() {
			resolver.stale = true
		},
	}
	authorizer, err := NewScopedTokenAuthorizer(relayTokenResolver{
		token:      testRelayToken,
		accountRef: accountRef,
	})
	if err != nil {
		t.Fatalf("NewScopedTokenAuthorizer() error = %v", err)
	}
	handler, err := NewHandler(Dependencies{
		Authorizer:     authorizer,
		Credentials:    resolver,
		Client:         client,
		Attempts:       recorder,
		ModelRefreshes: &relayModelRefreshScheduler{},
		Clock:          relayTestClock,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	request := newNativeRelayRequest(t, `{"model":"claude-opus-5"}`)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK ||
		response.Body.String() != client.body ||
		recorder.successes != 0 ||
		resolver.verificationCalls != 1 {
		t.Fatalf(
			"status=%d body=%q successes=%d verification_calls=%d",
			response.Code,
			response.Body.String(),
			recorder.successes,
			resolver.verificationCalls,
		)
	}
}

// TestHandlerRecordsStreamingSuccessAtMessageStop 验证流尾之后的本地收尾不会推迟
// 成功发生时间，避免它清除 message_stop 之后已经写入的同代失败。
func TestHandlerRecordsStreamingSuccessAtMessageStop(t *testing.T) {
	t.Parallel()

	accountRef, credential := newRelayOAuthCredential(t)
	recorder := &relayAttemptRecorder{}
	resolver := &relayCredentialResolver{
		accountRef: accountRef,
		credential: credential,
	}
	terminalAt := relayTestClock().Add(time.Second)
	afterCopy := terminalAt.Add(time.Second)
	clockCalls := 0
	clock := func() time.Time {
		clockCalls++
		if clockCalls == 1 {
			return terminalAt
		}
		return afterCopy
	}
	authorizer, err := NewScopedTokenAuthorizer(relayTokenResolver{
		token:      testRelayToken,
		accountRef: accountRef,
	})
	if err != nil {
		t.Fatalf("NewScopedTokenAuthorizer() error = %v", err)
	}
	handler, err := NewHandler(Dependencies{
		Authorizer:  authorizer,
		Credentials: resolver,
		Client: &relayFailureClient{
			status: http.StatusText(http.StatusOK),
			code:   http.StatusOK,
			body:   "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
			header: http.Header{"Content-Type": []string{"text/event-stream"}},
		},
		Attempts:       recorder,
		ModelRefreshes: &relayModelRefreshScheduler{},
		Clock:          clock,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	request := newNativeRelayRequest(
		t,
		`{"model":"claude-opus-5","stream":true}`,
	)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK ||
		recorder.successes != 1 ||
		!recorder.lastSuccess.HappenedAt().Equal(terminalAt) {
		t.Fatalf(
			"status=%d successes=%d happened_at=%s want=%s",
			response.Code,
			recorder.successes,
			recorder.lastSuccess.HappenedAt(),
			terminalAt,
		)
	}
}

// TestHandlerRejectsSpoofedUpstreamRetryHeader 验证只有 Server 自己的
// 失败分类可以生成换号标记，上游同名 Header 不能越权控制账号池。
func TestHandlerRejectsSpoofedUpstreamRetryHeader(t *testing.T) {
	t.Parallel()

	accountRef, credential := newRelayOAuthCredential(t)
	recorder := &relayAttemptRecorder{}
	handler := newRelayHandlerWithRecorder(
		t,
		accountRef,
		credential,
		&relayFailureClient{
			status: http.StatusText(http.StatusBadRequest),
			code:   http.StatusBadRequest,
			body:   `{"type":"error","error":{"type":"invalid_request_error"}}`,
			header: http.Header{
				gatewaycontract.RetryAccountHeader: []string{
					gatewaycontract.RetryAccountValue,
				},
			},
		},
		recorder,
	)
	request := newNativeRelayRequest(
		t,
		`{"model":"claude-opus-5"}`,
	)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest ||
		response.Header().Get(gatewaycontract.RetryAccountHeader) != "" ||
		len(recorder.failures) != 1 ||
		recorder.failures[0].RuntimeKind() != runtimecore.FailureInvalidRequest {
		t.Fatalf(
			"status=%d retry=%q failures=%v",
			response.Code,
			response.Header().Get(gatewaycontract.RetryAccountHeader),
			recorder.failures,
		)
	}
}

// TestHandlerRecordsTransportFailureBeforeResponse 验证未收到 HTTP 响应时
// 仍按稳定 Go 错误身份记录运行态，并只在响应未提交时允许换号。
func TestHandlerRecordsTransportFailureBeforeResponse(t *testing.T) {
	t.Parallel()

	accountRef, credential := newRelayOAuthCredential(t)
	recorder := &relayAttemptRecorder{}
	handler := newRelayHandlerWithRecorder(
		t,
		accountRef,
		credential,
		relayTransportFailureClient{err: syscall.ECONNRESET},
		recorder,
	)
	request := newNativeRelayRequest(
		t,
		`{"model":"claude-opus-5"}`,
	)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadGateway ||
		response.Header().Get(gatewaycontract.RetryAccountHeader) !=
			gatewaycontract.RetryAccountValue ||
		len(recorder.failures) != 1 ||
		recorder.failures[0].RuntimeKind() !=
			runtimecore.FailureConnectionReset {
		t.Fatalf(
			"status=%d retry=%q failures=%v",
			response.Code,
			response.Header().Get(gatewaycontract.RetryAccountHeader),
			recorder.failures,
		)
	}
}

// TestHandlerObservesNativeStreamTerminalStateWithoutReencoding 验证原始 SSE
// 字节保持不变，同时 error、断流和 message_stop 精确写入运行态。
func TestHandlerObservesNativeStreamTerminalStateWithoutReencoding(
	t *testing.T,
) {
	t.Parallel()

	tests := []struct {
		name        string
		body        string
		failureKind runtimecore.FailureKind
		wantSuccess int
	}{
		{
			name: "upstream error event",
			body: "event: error\n" +
				`data: {"type":"error","error":{"type":"overloaded_error"}}` +
				"\n\n",
			failureKind: runtimecore.FailureModelOverloaded,
		},
		{
			name: "stream disconnected before message stop",
			body: "event: message_delta\n" +
				`data: {"type":"message_delta","delta":{"stop_reason":null}}` +
				"\n\n",
			failureKind: runtimecore.FailureStreamDisconnected,
		},
		{
			name:        "message stop",
			body:        "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
			wantSuccess: 1,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			accountRef, credential := newRelayOAuthCredential(t)
			recorder := &relayAttemptRecorder{}
			handler := newRelayHandlerWithRecorder(
				t,
				accountRef,
				credential,
				&relayFailureClient{
					status: http.StatusText(http.StatusOK),
					code:   http.StatusOK,
					body:   test.body,
					header: http.Header{
						"Content-Type": []string{"text/event-stream"},
					},
				},
				recorder,
			)
			request := newNativeRelayRequest(
				t,
				`{"model":"claude-opus-5","stream":true}`,
			)
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, request)

			if response.Code != http.StatusOK ||
				response.Body.String() != test.body ||
				recorder.successes != test.wantSuccess {
				t.Fatalf(
					"status=%d body=%q successes=%d failures=%v",
					response.Code,
					response.Body.String(),
					recorder.successes,
					recorder.failures,
				)
			}
			if test.failureKind == "" {
				if len(recorder.failures) != 0 {
					t.Fatalf("unexpected failures=%v", recorder.failures)
				}
				return
			}
			if len(recorder.failures) != 1 ||
				recorder.failures[0].RuntimeKind() != test.failureKind {
				t.Fatalf(
					"failure=%v want=%s",
					recorder.failures,
					test.failureKind,
				)
			}
		})
	}
}

// TestHandlerSetsStreamingProxyHeaders 验证 Native Relay 的原始 SSE 虽不重编码，
// 仍落实网关防缓存、防代理缓冲和 MIME 嗅探边界。
func TestHandlerSetsStreamingProxyHeaders(t *testing.T) {
	t.Parallel()

	accountRef, credential := newRelayOAuthCredential(t)
	handler := newRelayHandlerWithRecorder(
		t,
		accountRef,
		credential,
		&relayFailureClient{
			status: http.StatusText(http.StatusOK),
			code:   http.StatusOK,
			body:   "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
			header: http.Header{
				"Content-Type": []string{"text/event-stream"},
			},
		},
		&relayAttemptRecorder{},
	)
	request := newNativeRelayRequest(
		t,
		`{"model":"claude-opus-5","stream":true}`,
	)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK ||
		response.Header().Get("Cache-Control") != "no-cache" ||
		response.Header().Get("X-Accel-Buffering") != "no" ||
		response.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("Native SSE 响应头不完整: status=%d headers=%v", response.Code, response.Header())
	}
}

// TestHandlerRejectsUnknownNativeQueryBeforeCredential 验证 Relay 只放行
// Claude Code 已观察到的 beta=true，不把任意查询参数带到官方端点。
func TestHandlerRejectsUnknownNativeQueryBeforeCredential(t *testing.T) {
	t.Parallel()

	accountRef, credential := newRelayOAuthCredential(t)
	client := &relayRecordingClient{}
	resolver := &relayCredentialResolver{
		accountRef: accountRef,
		credential: credential,
	}
	authorizer, err := NewScopedTokenAuthorizer(relayTokenResolver{
		token:      testRelayToken,
		accountRef: accountRef,
	})
	if err != nil {
		t.Fatalf("NewScopedTokenAuthorizer() error = %v", err)
	}
	handler, err := NewHandler(Dependencies{
		Authorizer:     authorizer,
		Credentials:    resolver,
		Client:         client,
		Attempts:       &relayAttemptRecorder{},
		ModelRefreshes: &relayModelRefreshScheduler{},
		Clock:          relayTestClock,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	tests := []struct {
		name string
		path string
	}{
		{name: "empty marker", path: Path + "?"},
		{name: "wrong beta", path: Path + "?beta=false"},
		{name: "duplicate beta", path: Path + "?beta=true&beta=true"},
		{name: "extra parameter", path: Path + "?beta=true&trace=true"},
		{name: "encoded value", path: Path + "?beta=%74rue"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(
				http.MethodPost,
				test.path,
				strings.NewReader(`{"model":"claude-opus-5"}`),
			)
			request.Header.Set("Content-Type", "application/json")
			setNativeRelayHeaders(request)
			request.Header.Set(RelayTokenHeader, testRelayToken)
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, request)

			if response.Code != http.StatusBadRequest {
				t.Fatalf(
					"status=%d body=%s",
					response.Code,
					response.Body,
				)
			}
		})
	}
	if resolver.calls != 0 || client.calls != 0 {
		t.Fatalf(
			"resolver_calls=%d client_calls=%d",
			resolver.calls,
			client.calls,
		)
	}
}

// TestHandlerRejectsUntrustedAccountSelection 验证客户端自报 AccountRef
// 不能绕过服务端 Relay Token 绑定。
func TestHandlerRejectsUntrustedAccountSelection(t *testing.T) {
	t.Parallel()

	accountRef, credential := newRelayOAuthCredential(t)
	client := &relayRecordingClient{}
	resolver := &relayCredentialResolver{
		accountRef: accountRef,
		credential: credential,
	}
	authorizer, err := NewScopedTokenAuthorizer(relayTokenResolver{
		token:      testRelayToken,
		accountRef: accountRef,
	})
	if err != nil {
		t.Fatalf("NewScopedTokenAuthorizer() error = %v", err)
	}
	handler, err := NewHandler(Dependencies{
		Authorizer:     authorizer,
		Credentials:    resolver,
		Client:         client,
		Attempts:       &relayAttemptRecorder{},
		ModelRefreshes: &relayModelRefreshScheduler{},
		Clock:          relayTestClock,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}

	tests := []struct {
		name  string
		token []string
	}{
		{name: "missing token"},
		{name: "wrong token", token: []string{"wrong-relay-token-value"}},
		{
			name:  "duplicate token",
			token: []string{testRelayToken, testRelayToken},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(
				http.MethodPost,
				Path,
				strings.NewReader(`{"model":"claude-opus-5"}`),
			)
			request.Header.Set("Content-Type", "application/json")
			setNativeRelayHeaders(request)
			request.Header.Set(
				"X-Account-Ref",
				accountRef.String(),
			)
			for _, token := range test.token {
				request.Header.Add(RelayTokenHeader, token)
			}
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, request)

			if response.Code != http.StatusUnauthorized {
				t.Fatalf(
					"status=%d body=%s",
					response.Code,
					response.Body,
				)
			}
		})
	}
	if resolver.calls != 0 || client.calls != 0 {
		t.Fatalf(
			"resolver_calls=%d client_calls=%d",
			resolver.calls,
			client.calls,
		)
	}
}

// TestHandlerRejectsNonOAuthCredentialBeforeNetwork 验证 API Key 不会
// 错误进入只服务原生 Claude OAuth 的 Relay。
func TestHandlerRejectsNonOAuthCredentialBeforeNetwork(t *testing.T) {
	t.Parallel()

	apiKey, err := claudeauth.NewAPIKeyAuth(claudeauth.APIKeyInput{
		APIKey: "sk-ant-api03-native-relay",
	})
	if err != nil {
		t.Fatalf("claude.NewAPIKeyAuth() error = %v", err)
	}
	accountRef, err := accountcore.DeriveAccountRef(apiKey)
	if err != nil {
		t.Fatalf("accounts.DeriveAccountRef() error = %v", err)
	}
	client := &relayRecordingClient{}
	handler := newRelayTestHandler(t, accountRef, apiKey, client)
	request := httptest.NewRequest(
		http.MethodPost,
		Path,
		strings.NewReader(`{"model":"claude-opus-5"}`),
	)
	request.Header.Set("Content-Type", "application/json")
	setNativeRelayHeaders(request)
	request.Header.Set(RelayTokenHeader, testRelayToken)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusUnprocessableEntity ||
		client.calls != 0 {
		t.Fatalf(
			"status=%d client_calls=%d body=%s",
			response.Code,
			client.calls,
			response.Body,
		)
	}
}

// TestHandlerRequiresBoundedKnownLengthBody 验证未知长度和超限正文不会触网。
func TestHandlerRequiresBoundedKnownLengthBody(t *testing.T) {
	t.Parallel()

	accountRef, credential := newRelayOAuthCredential(t)
	client := &relayRecordingClient{}
	handler := newRelayTestHandler(t, accountRef, credential, client)
	tests := []struct {
		name          string
		contentLength int64
		expected      int
	}{
		{
			name:          "unknown length",
			contentLength: -1,
			expected:      http.StatusLengthRequired,
		},
		{
			name:          "oversized",
			contentLength: MaxRequestBodyBytes + 1,
			expected:      http.StatusRequestEntityTooLarge,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(
				http.MethodPost,
				Path,
				strings.NewReader(`{"model":"claude-opus-5"}`),
			)
			request.ContentLength = test.contentLength
			request.Header.Set("Content-Type", "application/json")
			setNativeRelayHeaders(request)
			request.Header.Set(RelayTokenHeader, testRelayToken)
			response := httptest.NewRecorder()

			handler.ServeHTTP(response, request)

			if response.Code != test.expected {
				t.Fatalf(
					"status=%d want=%d body=%s",
					response.Code,
					test.expected,
					response.Body,
				)
			}
		})
	}
	if client.calls != 0 {
		t.Fatalf("client_calls=%d", client.calls)
	}
}

// TestHandlerRejectsMissingNativeClientHeadersBeforeCredential 验证普通 HTTP
// 调用即使持有 Relay Token，也不能冒充官方 Claude Runtime。
func TestHandlerRejectsMissingNativeClientHeadersBeforeCredential(
	t *testing.T,
) {
	t.Parallel()

	accountRef, credential := newRelayOAuthCredential(t)
	client := &relayRecordingClient{}
	resolver := &relayCredentialResolver{
		accountRef: accountRef,
		credential: credential,
	}
	authorizer, err := NewScopedTokenAuthorizer(relayTokenResolver{
		token:      testRelayToken,
		accountRef: accountRef,
	})
	if err != nil {
		t.Fatalf("NewScopedTokenAuthorizer() error = %v", err)
	}
	handler, err := NewHandler(Dependencies{
		Authorizer:     authorizer,
		Credentials:    resolver,
		Client:         client,
		Attempts:       &relayAttemptRecorder{},
		ModelRefreshes: &relayModelRefreshScheduler{},
		Clock:          relayTestClock,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	request := httptest.NewRequest(
		http.MethodPost,
		Path,
		strings.NewReader(`{"model":"claude-opus-5"}`),
	)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(RelayTokenHeader, testRelayToken)
	request.Header.Set("x-app", "forged-client")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest ||
		resolver.calls != 0 ||
		client.calls != 0 {
		t.Fatalf(
			"status=%d resolver_calls=%d client_calls=%d body=%s",
			response.Code,
			resolver.calls,
			client.calls,
			response.Body,
		)
	}
}

// TestNewHandlerRejectsIncompleteDependencies 验证组合根不能暴露半初始化 Relay。
func TestNewHandlerRejectsIncompleteDependencies(t *testing.T) {
	t.Parallel()

	accountRef, credential := newRelayOAuthCredential(t)
	authorizer, err := NewScopedTokenAuthorizer(relayTokenResolver{
		token:      testRelayToken,
		accountRef: accountRef,
	})
	if err != nil {
		t.Fatalf("NewScopedTokenAuthorizer() error = %v", err)
	}
	dependencies := Dependencies{
		Authorizer: authorizer,
		Credentials: &relayCredentialResolver{
			accountRef: accountRef,
			credential: credential,
		},
		Client:         &relayRecordingClient{},
		Attempts:       &relayAttemptRecorder{},
		ModelRefreshes: &relayModelRefreshScheduler{},
		Clock:          relayTestClock,
	}
	tests := []Dependencies{
		{Credentials: dependencies.Credentials, Client: dependencies.Client},
		{Authorizer: dependencies.Authorizer, Client: dependencies.Client},
		{
			Authorizer:  dependencies.Authorizer,
			Credentials: dependencies.Credentials,
		},
		{
			Authorizer:     dependencies.Authorizer,
			Credentials:    dependencies.Credentials,
			Client:         dependencies.Client,
			ModelRefreshes: dependencies.ModelRefreshes,
			Clock:          dependencies.Clock,
		},
		{
			Authorizer:  dependencies.Authorizer,
			Credentials: dependencies.Credentials,
			Client:      dependencies.Client,
			Attempts:    dependencies.Attempts,
			Clock:       dependencies.Clock,
		},
		{
			Authorizer:     dependencies.Authorizer,
			Credentials:    dependencies.Credentials,
			Client:         dependencies.Client,
			Attempts:       dependencies.Attempts,
			ModelRefreshes: dependencies.ModelRefreshes,
		},
	}
	for index, current := range tests {
		if _, err := NewHandler(current); !errors.Is(
			err,
			ErrInvalidDependencies,
		) {
			t.Fatalf("NewHandler(case %d) error = %v", index, err)
		}
	}
	if _, err := NewScopedTokenAuthorizer(nil); !errors.Is(
		err,
		ErrInvalidAuthorizer,
	) {
		t.Fatalf("NewScopedTokenAuthorizer(nil) error = %v", err)
	}
}

// newRelayOAuthCredential 创建不含真实凭据的官方 OAuth 账号。
func newRelayOAuthCredential(
	t *testing.T,
) (accountcore.AccountRef, *claudeauth.OAuthAuth) {
	t.Helper()

	credential, err := claudeauth.NewOAuthAuth(claudeauth.OAuthInput{
		AccessToken:  testAccessToken,
		RefreshToken: "sk-ant-ort01-native-relay-database",
		ExpiresAtMS: time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC).
			UnixMilli(),
		Scopes: []string{claudeauth.InferenceScope},
		Identity: claudeauth.OAuthIdentity{
			AccountUUID: "123e4567-e89b-12d3-a456-426614174000",
		},
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthAuth() error = %v", err)
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("accounts.DeriveAccountRef() error = %v", err)
	}
	return accountRef, credential
}

// newRelayTestHandler 装配服务端绑定 Token 与指定凭据。
func newRelayTestHandler(
	t *testing.T,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	client HTTPClient,
) *Handler {
	return newRelayHandlerWithRecorder(
		t,
		accountRef,
		credential,
		client,
		&relayAttemptRecorder{},
	)
}

// newRelayHandlerWithRecorder 装配可断言运行态终态的测试 Handler。
func newRelayHandlerWithRecorder(
	t *testing.T,
	accountRef accountcore.AccountRef,
	credential accountapp.Credential,
	client HTTPClient,
	recorder *relayAttemptRecorder,
) *Handler {
	t.Helper()

	authorizer, err := NewScopedTokenAuthorizer(relayTokenResolver{
		token:      testRelayToken,
		accountRef: accountRef,
	})
	if err != nil {
		t.Fatalf("NewScopedTokenAuthorizer() error = %v", err)
	}
	handler, err := NewHandler(Dependencies{
		Authorizer: authorizer,
		Credentials: &relayCredentialResolver{
			accountRef: accountRef,
			credential: credential,
		},
		Client:         client,
		Attempts:       recorder,
		ModelRefreshes: &relayModelRefreshScheduler{},
		Clock:          relayTestClock,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

// newNativeRelayRequest 创建带一次性租约和官方外层标识的 Messages 请求。
func newNativeRelayRequest(t *testing.T, body string) *http.Request {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(RelayTokenHeader, testRelayToken)
	setNativeRelayHeaders(request)
	return request
}

// setNativeRelayHeaders 添加官方 Claude Runtime 的稳定外层标识。
func setNativeRelayHeaders(request *http.Request) {
	request.Header.Set("anthropic-version", "2023-06-01")
	request.Header.Set(
		"anthropic-beta",
		"claude-code-20250219,interleaved-thinking-2025-05-14",
	)
	request.Header.Set("x-app", "cli")
	request.Header.Set("User-Agent", "claude-cli/2.1.220 (external, cli)")
	request.Header.Set(
		"X-Claude-Code-Session-Id",
		"123e4567-e89b-12d3-a456-426614174111",
	)
}

// relayTokenResolver 只解析一个合成会话 Token。
type relayTokenResolver struct {
	token      string
	accountRef accountcore.AccountRef
}

// ConsumeRelayToken 返回 Token 在服务端绑定的账号模型。
func (resolver relayTokenResolver) ConsumeRelayToken(
	token string,
) (accountcore.AccountRef, runtimecore.ModelID, bool) {
	return resolver.accountRef,
		runtimecore.ModelID("claude-opus-5"),
		token == resolver.token
}

// relayCredentialResolver 记录凭据解析是否发生。
type relayCredentialResolver struct {
	accountRef        accountcore.AccountRef
	credential        accountapp.Credential
	calls             int
	stale             bool
	verificationCalls int
}

// ResolveObservedCredentialBinding 只允许租约绑定的账号读取同一份凭据快照。
func (resolver *relayCredentialResolver) ResolveObservedCredentialBinding(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (
	accountapp.CredentialBinding,
	accountcredentials.CredentialObservation,
	error,
) {
	resolver.calls++
	if accountRef != resolver.accountRef {
		return accountapp.CredentialBinding{},
			accountcredentials.CredentialObservation{},
			accountapp.ErrCredentialNotFound
	}
	binding, err := accountapp.NewCredentialBinding(
		accountRef,
		claudeauth.ProviderID,
		resolver.credential,
	)
	if err != nil {
		return accountapp.CredentialBinding{},
			accountcredentials.CredentialObservation{},
			err
	}
	snapshot, err := accountapp.NewCredentialSnapshot(
		accountRef,
		claudeauth.ProviderID,
		resolver.credential,
		relayTestClock().Add(-time.Hour),
	)
	if err != nil {
		return accountapp.CredentialBinding{},
			accountcredentials.CredentialObservation{},
			err
	}
	observation, err := accountcredentials.NewCredentialObservation(snapshot)
	return binding, observation, err
}

// IsCurrentCredentialObservation 模拟凭据在上游返回前是否已经轮换。
func (resolver *relayCredentialResolver) IsCurrentCredentialObservation(
	_ context.Context,
	observation accountcredentials.CredentialObservation,
) (bool, error) {
	resolver.verificationCalls++
	return !resolver.stale &&
			observation.AccountRef() == resolver.accountRef,
		nil
}

// relayAttemptRecorder 记录 Native Relay 是否提交了运行态终态。
type relayAttemptRecorder struct {
	successes   int
	lastSuccess inferencegateway.AttemptSuccess
	failures    []inferencegateway.AttemptFailure
}

// RecordSuccess 记录完整成功响应。
func (recorder *relayAttemptRecorder) RecordSuccess(
	_ context.Context,
	_ runtimecore.ModelRoute,
	success inferencegateway.AttemptSuccess,
) error {
	recorder.successes++
	recorder.lastSuccess = success
	return nil
}

// RecordFailure 记录分类后的上游 HTTP 失败。
func (recorder *relayAttemptRecorder) RecordFailure(
	_ context.Context,
	_ runtimecore.ModelRoute,
	failure inferencegateway.AttemptFailure,
) error {
	recorder.failures = append(recorder.failures, failure)
	return nil
}

// relayModelRefreshScheduler 记录模型不支持后的旁路刷新请求。
type relayModelRefreshScheduler struct {
	calls int
}

// ScheduleModelRefresh 实现无网络测试端口。
func (scheduler *relayModelRefreshScheduler) ScheduleModelRefresh(
	context.Context,
	accountcore.AccountRef,
	string,
) error {
	scheduler.calls++
	return nil
}

// relayTestClock 返回失败分类使用的确定时间。
func relayTestClock() time.Time {
	return time.Date(2026, 8, 3, 12, 0, 0, 0, time.UTC)
}

// relayRecordingClient 记录是否越过了触网边界。
type relayRecordingClient struct {
	calls int
}

// Do 返回合成成功响应。
func (client *relayRecordingClient) Do(
	*http.Request,
) (*http.Response, error) {
	client.calls++
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
	}, nil
}

// relayFailureClient 返回正文可回放的合成 Claude HTTP 失败。
type relayFailureClient struct {
	status       string
	code         int
	body         string
	header       http.Header
	beforeReturn func()
}

// Do 返回预设失败，不访问网络。
func (client *relayFailureClient) Do(
	*http.Request,
) (*http.Response, error) {
	if client.beforeReturn != nil {
		client.beforeReturn()
	}
	return &http.Response{
		Status:     client.status,
		StatusCode: client.code,
		Header:     client.header.Clone(),
		Body:       io.NopCloser(strings.NewReader(client.body)),
	}, nil
}

// relayTransportFailureClient 在收到 HTTP 响应前返回稳定传输错误。
type relayTransportFailureClient struct {
	err error
}

// Do 返回预设错误，不访问网络。
func (client relayTransportFailureClient) Do(
	*http.Request,
) (*http.Response, error) {
	return nil, client.err
}

// observedUpstreamRequest 保存 fake 上游实际收到的低敏证据。
type observedUpstreamRequest struct {
	body       []byte
	headers    http.Header
	method     string
	rawQuery   string
	contentLen int64
}

// relayRewriteTransport 把固定官方目标改写到本地 fake upstream。
type relayRewriteTransport struct {
	target           *url.URL
	originalEndpoint string
}

// newRelayRewriteTransport 创建只用于测试的本地改写 Client。
func newRelayRewriteTransport(
	t *testing.T,
	target string,
) *relayRewriteTransport {
	t.Helper()

	parsed, err := url.Parse(target)
	if err != nil {
		t.Fatalf("url.Parse() error = %v", err)
	}
	return &relayRewriteTransport{target: parsed}
}

// Do 保留原始目标证据后通过标准库 Client 访问本地上游。
func (transport *relayRewriteTransport) Do(
	request *http.Request,
) (*http.Response, error) {
	transport.originalEndpoint = request.URL.String()
	cloned := request.Clone(request.Context())
	cloned.URL.Scheme = transport.target.Scheme
	cloned.URL.Host = transport.target.Host
	cloned.Host = transport.target.Host
	return http.DefaultTransport.RoundTrip(cloned)
}

// TestRelayErrorDocumentShape 防止本地错误意外伪装成上游 Anthropic Error。
func TestRelayErrorDocumentShape(t *testing.T) {
	t.Parallel()

	response := httptest.NewRecorder()
	writeRelayError(
		response,
		http.StatusBadGateway,
		"relay_upstream_unavailable",
		"Claude 上游暂时不可用",
	)
	var document map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	errorView := document["error"].(map[string]any)
	if errorView["code"] != "relay_upstream_unavailable" ||
		errorView["message"] != "Claude 上游暂时不可用" {
		t.Fatalf("document=%v", document)
	}
}
