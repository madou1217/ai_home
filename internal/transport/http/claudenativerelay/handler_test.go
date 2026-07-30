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
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
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
			"claude-cli/2.1.207 (external, cli)" ||
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
		Authorizer:  authorizer,
		Credentials: resolver,
		Client:      client,
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
		Authorizer:  authorizer,
		Credentials: resolver,
		Client:      client,
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
		Authorizer:  authorizer,
		Credentials: resolver,
		Client:      client,
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
		Client: &relayRecordingClient{},
	}
	tests := []Dependencies{
		{Credentials: dependencies.Credentials, Client: dependencies.Client},
		{Authorizer: dependencies.Authorizer, Client: dependencies.Client},
		{
			Authorizer:  dependencies.Authorizer,
			Credentials: dependencies.Credentials,
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
		Client: client,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

// setNativeRelayHeaders 添加官方 Claude Runtime 的稳定外层标识。
func setNativeRelayHeaders(request *http.Request) {
	request.Header.Set("anthropic-version", "2023-06-01")
	request.Header.Set(
		"anthropic-beta",
		"claude-code-20250219,interleaved-thinking-2025-05-14",
	)
	request.Header.Set("x-app", "cli")
	request.Header.Set("User-Agent", "claude-cli/2.1.207 (external, cli)")
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

// ResolveRelayToken 返回 Token 在服务端绑定的账号。
func (resolver relayTokenResolver) ResolveRelayToken(
	token string,
) (accountcore.AccountRef, bool) {
	return resolver.accountRef, token == resolver.token
}

// relayCredentialResolver 记录凭据解析是否发生。
type relayCredentialResolver struct {
	accountRef accountcore.AccountRef
	credential accountapp.Credential
	calls      int
}

// ResolveCredential 只允许租约绑定的账号读取凭据。
func (resolver *relayCredentialResolver) ResolveCredential(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.Credential, error) {
	resolver.calls++
	if accountRef != resolver.accountRef {
		return nil, accountapp.ErrCredentialNotFound
	}
	return resolver.credential, nil
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
