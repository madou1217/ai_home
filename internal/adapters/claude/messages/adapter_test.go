package messages

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
)

// TestAdapterExecutesThroughCoordinator 验证 Route、Recruiter、Registry、
// Claude Adapter 和运行态记录组成一条真实 Canonical 执行链。
func TestAdapterExecutesThroughCoordinator(t *testing.T) {
	t.Parallel()

	upstream := &claudeRecordingHTTPClient{
		response: claudeHTTPResponse(
			http.StatusOK,
			"text/event-stream; charset=utf-8",
			successfulClaudeStream(),
		),
	}
	fixture := newClaudeAdapterFixture(t, upstream)
	var events []inference.StreamEvent

	err := fixture.coordinator.Execute(
		t.Context(),
		newClaudeAdapterRequest(t, true),
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("Coordinator.Execute() error = %v", err)
	}
	if fixture.recorder.successes != 1 ||
		len(fixture.recorder.failures) != 0 ||
		len(events) == 0 ||
		events[len(events)-1].Kind() != inference.EventResponseCompleted {
		t.Fatalf(
			"successes=%d failures=%d events=%s",
			fixture.recorder.successes,
			len(fixture.recorder.failures),
			eventKinds(events),
		)
	}
	request := upstream.request
	if request == nil ||
		request.URL.String() != "https://upstream.example/v1/messages" ||
		request.Header.Get("x-api-key") != "synthetic-claude-api-key" ||
		request.Header.Get("Authorization") != "" ||
		request.Header.Get("anthropic-version") != anthropicVersion {
		t.Fatalf("upstream request = %#v", request)
	}
	var body map[string]any
	if err := json.Unmarshal(upstream.requestBody, &body); err != nil {
		t.Fatalf("json.Unmarshal(request body) error = %v", err)
	}
	if body["model"] != "claude-sonnet-4-6" ||
		body["stream"] != true ||
		strings.Contains(
			string(upstream.requestBody),
			"synthetic-claude-api-key",
		) {
		t.Fatalf("request body = %s", upstream.requestBody)
	}
	t.Logf(
		"POST %s payload.model=%s response.events=%d terminal=%s",
		request.URL,
		body["model"],
		len(events),
		events[len(events)-1].Kind(),
	)
}

// TestAdapterAcceptsMissingContentTypeForRequestedStream 验证固定 stream=true
// 请求收到缺失 Content-Type 的成功流时仍按 SSE 合同解析。
func TestAdapterAcceptsMissingContentTypeForRequestedStream(t *testing.T) {
	t.Parallel()

	response := claudeHTTPResponse(
		http.StatusOK,
		"",
		successfulClaudeStream(),
	)
	response.Header.Del("Content-Type")
	fixture := newClaudeAdapterFixture(
		t,
		&claudeRecordingHTTPClient{response: response},
	)
	var events []inference.StreamEvent

	err := fixture.coordinator.Execute(
		t.Context(),
		newClaudeAdapterRequest(t, true),
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("Coordinator.Execute() error = %v", err)
	}
	if fixture.recorder.successes != 1 ||
		len(events) == 0 ||
		events[len(events)-1].Kind() != inference.EventResponseCompleted {
		t.Fatalf(
			"successes=%d events=%s",
			fixture.recorder.successes,
			eventKinds(events),
		)
	}
}

// TestAdapterDecodesCompleteJSONMessage 验证兼容端点忽略 stream 参数时，
// 完整 Message 仍复用同一状态机生成 Canonical 生命周期。
func TestAdapterDecodesCompleteJSONMessage(t *testing.T) {
	t.Parallel()

	fixture := newClaudeAdapterFixture(
		t,
		&claudeRecordingHTTPClient{
			response: claudeHTTPResponse(
				http.StatusOK,
				"application/vnd.anthropic.message+json",
				`{
					"id":"msg_json",
					"type":"message",
					"role":"assistant",
					"model":"claude-sonnet-4-6",
					"content":[{"type":"text","text":"json-ok"}],
					"stop_reason":"end_turn",
					"stop_sequence":null,
					"usage":{"input_tokens":2,"output_tokens":3}
				}`,
			),
		},
	)
	var events []inference.StreamEvent

	err := fixture.coordinator.Execute(
		t.Context(),
		newClaudeAdapterRequest(t, false),
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("Coordinator.Execute() error = %v", err)
	}
	if completedClaudeText(events) != "json-ok" ||
		fixture.recorder.successes != 1 ||
		events[len(events)-1].Kind() != inference.EventResponseCompleted {
		t.Fatalf(
			"output=%q successes=%d events=%s",
			completedClaudeText(events),
			fixture.recorder.successes,
			eventKinds(events),
		)
	}
}

// TestAdapterClassifiesProviderFailures 验证 HTTP、SSE 和畸形成功流均通过
// 稳定分类进入运行态，且上游原文不会进入客户端失败。
func TestAdapterClassifiesProviderFailures(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		response   *http.Response
		expected   runtimecore.FailureKind
		retryAfter time.Duration
	}{
		{
			name: "http 529 overloaded",
			response: func() *http.Response {
				response := claudeHTTPResponse(
					529,
					"application/json",
					`{"type":"error","error":{"type":"overloaded_error","message":"private capacity detail"}}`,
				)
				response.Header.Set("Retry-After", "2")
				return response
			}(),
			expected:   runtimecore.FailureModelOverloaded,
			retryAfter: 2 * time.Second,
		},
		{
			name: "sse rate limit",
			response: claudeHTTPResponse(
				http.StatusOK,
				"text/event-stream",
				strings.Join([]string{
					"event: error",
					`data: {"type":"error","error":{"type":"rate_limit_error","message":"private rate detail"}}`,
					"",
					"",
				}, "\n"),
			),
			expected: runtimecore.FailureRateLimited,
		},
		{
			name: "http 429 rate limit",
			response: func() *http.Response {
				response := claudeHTTPResponse(
					http.StatusTooManyRequests,
					"application/json",
					`{"type":"error","error":{"type":"rate_limit_error","message":"private rate detail"}}`,
				)
				response.Header.Set("Retry-After", "3")
				return response
			}(),
			expected:   runtimecore.FailureRateLimited,
			retryAfter: 3 * time.Second,
		},
		{
			name: "malformed success stream",
			response: claudeHTTPResponse(
				http.StatusOK,
				"text/event-stream",
				"data: not-json\n\n",
			),
			expected: runtimecore.FailureMalformedResponse,
		},
		{
			name: "incomplete success stream",
			response: claudeHTTPResponse(
				http.StatusOK,
				"text/event-stream",
				strings.Join([]string{
					"event: message_start",
					`data: {"type":"message_start","message":{"id":"msg_cut","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"usage":{"input_tokens":1,"output_tokens":0}}}`,
					"",
				}, "\n"),
			),
			expected: runtimecore.FailureStreamDisconnected,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			fixture := newClaudeAdapterFixture(
				t,
				&claudeRecordingHTTPClient{response: test.response},
			)
			var events []inference.StreamEvent
			err := fixture.coordinator.Execute(
				t.Context(),
				newClaudeAdapterRequest(t, true),
				func(event inference.StreamEvent) error {
					events = append(events, event)
					return nil
				},
			)
			if err != nil {
				t.Fatalf("Coordinator.Execute() error = %v", err)
			}
			if len(fixture.recorder.failures) != 1 ||
				fixture.recorder.failures[0].RuntimeKind() != test.expected ||
				fixture.recorder.failures[0].RetryAfter() != test.retryAfter ||
				len(events) == 0 ||
				events[len(events)-1].Kind() != inference.EventResponseFailed {
				t.Fatalf(
					"failures=%v events=%s",
					fixture.recorder.failures,
					eventKinds(events),
				)
			}
			failed := events[len(events)-1].(inference.ResponseFailedEvent)
			if strings.Contains(
				failed.Failure().SafeMessage(),
				"private",
			) {
				t.Fatalf("safe failure = %#v", failed.Failure())
			}
		})
	}
}

// TestAdapterPropagatesSinkBackpressure 验证客户端输出失败不会记成账号失败。
func TestAdapterPropagatesSinkBackpressure(t *testing.T) {
	t.Parallel()

	fixture := newClaudeAdapterFixture(
		t,
		&claudeRecordingHTTPClient{
			response: claudeHTTPResponse(
				http.StatusOK,
				"text/event-stream",
				successfulClaudeStream(),
			),
		},
	)
	backpressure := errors.New("client disconnected")

	err := fixture.coordinator.Execute(
		t.Context(),
		newClaudeAdapterRequest(t, true),
		func(inference.StreamEvent) error {
			return backpressure
		},
	)
	if !errors.Is(err, backpressure) ||
		fixture.recorder.successes != 0 ||
		len(fixture.recorder.failures) != 0 {
		t.Fatalf(
			"error=%v successes=%d failures=%d",
			err,
			fixture.recorder.successes,
			len(fixture.recorder.failures),
		)
	}
}

// TestAdapterPropagatesJSONSinkBackpressure 验证完整 JSON Message 的首个
// Canonical 事件失败也不会被误分类成 malformed_response。
func TestAdapterPropagatesJSONSinkBackpressure(t *testing.T) {
	t.Parallel()

	fixture := newClaudeAdapterFixture(
		t,
		&claudeRecordingHTTPClient{
			response: claudeHTTPResponse(
				http.StatusOK,
				"application/json",
				`{
					"id":"msg_sink",
					"type":"message",
					"role":"assistant",
					"model":"claude-sonnet-4-6",
					"content":[{"type":"text","text":"unused"}],
					"stop_reason":"end_turn",
					"stop_sequence":null,
					"usage":{"input_tokens":1,"output_tokens":1}
				}`,
			),
		},
	)
	backpressure := errors.New("json client disconnected")

	err := fixture.coordinator.Execute(
		t.Context(),
		newClaudeAdapterRequest(t, false),
		func(inference.StreamEvent) error {
			return backpressure
		},
	)
	if !errors.Is(err, backpressure) ||
		fixture.recorder.successes != 0 ||
		len(fixture.recorder.failures) != 0 {
		t.Fatalf(
			"error=%v successes=%d failures=%d",
			err,
			fixture.recorder.successes,
			len(fixture.recorder.failures),
		)
	}
}

// TestAdapterClassifiesTransportTimeout 验证传输失败只按 Go 错误身份分类。
func TestAdapterClassifiesTransportTimeout(t *testing.T) {
	t.Parallel()

	fixture := newClaudeAdapterFixture(
		t,
		&claudeRecordingHTTPClient{err: context.DeadlineExceeded},
	)
	var events []inference.StreamEvent

	err := fixture.coordinator.Execute(
		t.Context(),
		newClaudeAdapterRequest(t, false),
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("Coordinator.Execute() error = %v", err)
	}
	if len(fixture.recorder.failures) != 1 ||
		fixture.recorder.failures[0].RuntimeKind() !=
			runtimecore.FailureRequestTimeout ||
		len(events) != 1 {
		t.Fatalf(
			"failures=%v events=%s",
			fixture.recorder.failures,
			eventKinds(events),
		)
	}
}

// TestNewAdapterRejectsMissingDependencies 验证组合根不能创建半初始化实例。
func TestNewAdapterRejectsMissingDependencies(t *testing.T) {
	t.Parallel()

	if _, err := NewAdapter(nil, time.Now); !errors.Is(
		err,
		ErrInvalidDependencies,
	) {
		t.Fatalf("NewAdapter(nil, clock) error = %v", err)
	}
	if _, err := NewAdapter(
		&claudeRecordingHTTPClient{},
		nil,
	); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("NewAdapter(client, nil) error = %v", err)
	}
}

// TestCoordinatorSkipsOfficialOAuthBeforeAdapter 验证错误的 Go 直连路径
// 在账号征召阶段停止，不触网、不产出事件，也不写账号运行态。
func TestCoordinatorSkipsOfficialOAuthBeforeAdapter(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		credential func(*testing.T) accountapp.Credential
	}{
		{
			name: "refreshable oauth",
			credential: func(t *testing.T) accountapp.Credential {
				t.Helper()
				auth, err := claudeauth.NewOAuthAuth(claudeauth.OAuthInput{
					AccessToken:  "sk-ant-oat01-adapter-oauth",
					RefreshToken: "sk-ant-ort01-adapter-oauth",
					ExpiresAtMS:  4_102_444_800_000,
					Scopes:       []string{claudeauth.InferenceScope},
					Identity: claudeauth.OAuthIdentity{
						AccountUUID: "123e4567-e89b-12d3-a456-426614174000",
					},
				})
				if err != nil {
					t.Fatalf("claude.NewOAuthAuth() error = %v", err)
				}
				return auth
			},
		},
		{
			name: "official setup token",
			credential: func(t *testing.T) accountapp.Credential {
				t.Helper()
				auth, err := claudeauth.NewOAuthTokenAuth(
					claudeauth.OAuthTokenInput{
						AccessToken: "sk-ant-oat01-adapter-setup",
					},
				)
				if err != nil {
					t.Fatalf("claude.NewOAuthTokenAuth() error = %v", err)
				}
				return auth
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			client := &claudeRecordingHTTPClient{}
			fixture := newClaudeAdapterFixtureWithCredential(
				t,
				client,
				test.credential(t),
			)
			var events []inference.StreamEvent

			err := fixture.coordinator.Execute(
				t.Context(),
				newClaudeAdapterRequest(t, true),
				func(event inference.StreamEvent) error {
					events = append(events, event)
					return nil
				},
			)
			if !errors.Is(err, inferencegateway.ErrNoRoutableAccount) ||
				client.calls != 0 ||
				fixture.recorder.successes != 0 ||
				len(fixture.recorder.failures) != 0 ||
				len(events) != 0 {
				t.Fatalf(
					"error=%v calls=%d successes=%d failures=%d events=%s",
					err,
					client.calls,
					fixture.recorder.successes,
					len(fixture.recorder.failures),
					eventKinds(events),
				)
			}
		})
	}
}

// TestCoordinatorSkipsOAuthAndFairlyRotatesAPIKeys 验证混合账号池中官方 OAuth
// 不进入 Messages 直连，同时两个 API Key 在连续请求中公平轮转。
func TestCoordinatorSkipsOAuthAndFairlyRotatesAPIKeys(t *testing.T) {
	t.Parallel()

	coordinator, client, recorder := newClaudeFairCoordinator(t)
	for range 20 {
		if err := coordinator.Execute(
			t.Context(),
			newClaudeAdapterRequest(t, true),
			func(inference.StreamEvent) error { return nil },
		); err != nil {
			t.Fatalf("Coordinator.Execute() error = %v", err)
		}
	}
	counts := client.APIKeyCounts()
	if client.CallCount() != 20 ||
		counts["synthetic-claude-fair-key-1"] != 10 ||
		counts["synthetic-claude-fair-key-2"] != 10 ||
		len(counts) != 2 ||
		recorder.successes != 20 ||
		len(recorder.failures) != 0 {
		t.Fatalf(
			"calls=%d keys=%v successes=%d failures=%d",
			client.CallCount(),
			counts,
			recorder.successes,
			len(recorder.failures),
		)
	}
	t.Logf("requests=%d api_key_distribution=%v oauth_upstream_calls=0", 20, counts)
}

// claudeAdapterFixture 保存真实 Coordinator 和测试记录端口。
type claudeAdapterFixture struct {
	coordinator *inferencegateway.Coordinator
	recorder    *claudeAttemptRecorder
}

// newClaudeFairCoordinator 装配两个 OAuth 与两个 API Key 的真实征召链。
func newClaudeFairCoordinator(
	t *testing.T,
) (
	*inferencegateway.Coordinator,
	*claudeFairHTTPClient,
	*claudeAttemptRecorder,
) {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	accounts, credentials := newClaudeFairAccountPool(t, catalog)
	recruiter, err := accountrouting.NewRecruiter(accountrouting.Dependencies{
		Candidates:  claudeCandidatePoolSource{accounts: accounts},
		Runtime:     claudeAvailableRuntime{},
		Credentials: claudeCredentialPoolResolver{credentials: credentials},
	})
	if err != nil {
		t.Fatalf("accountrouting.NewRecruiter() error = %v", err)
	}
	capabilities, err := inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
		inference.CapabilityStreaming,
	)
	if err != nil {
		t.Fatalf("inference.NewCapabilitySet() error = %v", err)
	}
	route, err := inferencegateway.NewRoute(
		inference.ProviderClaude,
		inference.ProtocolClaudeMessages,
		"claude-sonnet-4-6",
		capabilities,
	)
	if err != nil {
		t.Fatalf("inferencegateway.NewRoute() error = %v", err)
	}
	client := &claudeFairHTTPClient{}
	adapter, err := NewAdapter(client, func() time.Time {
		return time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
	})
	if err != nil {
		t.Fatalf("messages.NewAdapter() error = %v", err)
	}
	registry, err := inferencegateway.NewUpstreamRegistry(adapter)
	if err != nil {
		t.Fatalf("NewUpstreamRegistry() error = %v", err)
	}
	recorder := &claudeAttemptRecorder{}
	coordinator, err := inferencegateway.NewCoordinator(
		inferencegateway.Dependencies{
			Catalog:        catalog,
			Routes:         claudeRouteResolver{route: route},
			Recruiter:      recruiter,
			Upstreams:      registry,
			Attempts:       recorder,
			ModelRefreshes: claudeModelRefreshScheduler{},
		},
	)
	if err != nil {
		t.Fatalf("NewCoordinator() error = %v", err)
	}
	return coordinator, client, recorder
}

// newClaudeFairAccountPool 创建身份相互独立的混合凭据账号池。
func newClaudeFairAccountPool(
	t *testing.T,
	catalog *providers.Catalog,
) (
	[]accountapp.RoutingAccount,
	map[accountcore.AccountRef]accountapp.Credential,
) {
	t.Helper()

	credentials := []accountapp.Credential{
		newClaudeFairOAuth(t, "first", "123e4567-e89b-12d3-a456-426614174001"),
		newClaudeFairAPIKey(t, "1"),
		newClaudeFairOAuth(t, "second", "123e4567-e89b-12d3-a456-426614174002"),
		newClaudeFairAPIKey(t, "2"),
	}
	accounts := make([]accountapp.RoutingAccount, 0, len(credentials))
	credentialsByRef := make(
		map[accountcore.AccountRef]accountapp.Credential,
		len(credentials),
	)
	for index, credential := range credentials {
		accountRef, err := accountcore.DeriveAccountRef(credential)
		if err != nil {
			t.Fatalf("accounts.DeriveAccountRef() error = %v", err)
		}
		alias, err := accountcore.NewCLIAccountID(int64(index + 1))
		if err != nil {
			t.Fatalf("accounts.NewCLIAccountID() error = %v", err)
		}
		account, err := accountapp.NewRoutingAccount(
			catalog,
			accountapp.RoutingAccountInput{
				Ref:          accountRef,
				ProviderID:   "claude",
				CLIAccountID: alias,
			},
		)
		if err != nil {
			t.Fatalf("accounts.NewRoutingAccount() error = %v", err)
		}
		accounts = append(accounts, account)
		credentialsByRef[accountRef] = credential
	}
	return accounts, credentialsByRef
}

// newClaudeFairOAuth 创建不会触网的官方订阅 OAuth 测试凭据。
func newClaudeFairOAuth(
	t *testing.T,
	suffix string,
	accountUUID string,
) accountapp.Credential {
	t.Helper()

	credential, err := claudeauth.NewOAuthAuth(claudeauth.OAuthInput{
		AccessToken:  "sk-ant-oat01-fair-" + suffix,
		RefreshToken: "sk-ant-ort01-fair-" + suffix,
		ExpiresAtMS:  4_102_444_800_000,
		Scopes:       []string{claudeauth.InferenceScope},
		Identity:     claudeauth.OAuthIdentity{AccountUUID: accountUUID},
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthAuth(%s) error = %v", suffix, err)
	}
	return credential
}

// newClaudeFairAPIKey 创建可由 Messages Adapter 直连的测试 API Key。
func newClaudeFairAPIKey(t *testing.T, suffix string) accountapp.Credential {
	t.Helper()

	credential, err := claudeauth.NewAPIKeyAuth(claudeauth.APIKeyInput{
		APIKey:  "synthetic-claude-fair-key-" + suffix,
		BaseURL: "https://upstream.example",
	})
	if err != nil {
		t.Fatalf("claude.NewAPIKeyAuth(%s) error = %v", suffix, err)
	}
	return credential
}

// newClaudeAdapterFixture 使用真实 Recruiter 绑定合成 Claude API Key。
func newClaudeAdapterFixture(
	t *testing.T,
	client HTTPClient,
) claudeAdapterFixture {
	t.Helper()

	credential, err := claudeauth.NewAPIKeyAuth(claudeauth.APIKeyInput{
		APIKey:  "synthetic-claude-api-key",
		BaseURL: "https://upstream.example",
	})
	if err != nil {
		t.Fatalf("claude.NewAPIKeyAuth() error = %v", err)
	}
	return newClaudeAdapterFixtureWithCredential(t, client, credential)
}

// newClaudeAdapterFixtureWithCredential 使用指定凭据装配真实 Coordinator。
func newClaudeAdapterFixtureWithCredential(
	t *testing.T,
	client HTTPClient,
	credential accountapp.Credential,
) claudeAdapterFixture {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("accounts.DeriveAccountRef() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("accounts.NewCLIAccountID() error = %v", err)
	}
	account, err := accountapp.NewRoutingAccount(
		catalog,
		accountapp.RoutingAccountInput{
			Ref:          accountRef,
			ProviderID:   "claude",
			CLIAccountID: alias,
		},
	)
	if err != nil {
		t.Fatalf("accounts.NewRoutingAccount() error = %v", err)
	}
	recruiter, err := accountrouting.NewRecruiter(
		accountrouting.Dependencies{
			Candidates: claudeCandidateSource{account: account},
			Runtime:    claudeAvailableRuntime{},
			Credentials: claudeCredentialResolver{
				accountRef: accountRef,
				credential: credential,
			},
		},
	)
	if err != nil {
		t.Fatalf("accountrouting.NewRecruiter() error = %v", err)
	}
	capabilities, err := inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
		inference.CapabilityStreaming,
	)
	if err != nil {
		t.Fatalf("inference.NewCapabilitySet() error = %v", err)
	}
	route, err := inferencegateway.NewRoute(
		inference.ProviderClaude,
		inference.ProtocolClaudeMessages,
		"claude-sonnet-4-6",
		capabilities,
	)
	if err != nil {
		t.Fatalf("inferencegateway.NewRoute() error = %v", err)
	}
	adapter, err := NewAdapter(
		client,
		func() time.Time {
			return time.Date(2026, 7, 29, 12, 0, 0, 0, time.UTC)
		},
	)
	if err != nil {
		t.Fatalf("messages.NewAdapter() error = %v", err)
	}
	registry, err := inferencegateway.NewUpstreamRegistry(adapter)
	if err != nil {
		t.Fatalf("NewUpstreamRegistry() error = %v", err)
	}
	recorder := &claudeAttemptRecorder{}
	coordinator, err := inferencegateway.NewCoordinator(
		inferencegateway.Dependencies{
			Catalog:        catalog,
			Routes:         claudeRouteResolver{route: route},
			Recruiter:      recruiter,
			Upstreams:      registry,
			Attempts:       recorder,
			ModelRefreshes: claudeModelRefreshScheduler{},
		},
	)
	if err != nil {
		t.Fatalf("NewCoordinator() error = %v", err)
	}
	return claudeAdapterFixture{
		coordinator: coordinator,
		recorder:    recorder,
	}
}

// newClaudeAdapterRequest 创建客户端 alias 与 Claude 路由模型不同的请求。
func newClaudeAdapterRequest(
	t *testing.T,
	stream bool,
) inference.Request {
	t.Helper()

	message := mustMessage(
		t,
		inference.RoleUser,
		mustText(t, "hello claude adapter"),
	)
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolOpenAIResponses,
		Model:          "client-model-alias",
		Messages:       []inference.Message{message},
		Stream:         stream,
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	return request
}

// claudeRecordingHTTPClient 记录请求并返回一个预设响应。
type claudeRecordingHTTPClient struct {
	response    *http.Response
	err         error
	calls       int
	request     *http.Request
	requestBody []byte
}

// claudeFairHTTPClient 为每次调用创建独立成功响应并统计实际 API Key。
type claudeFairHTTPClient struct {
	mu      sync.Mutex
	calls   int
	apiKeys map[string]int
}

// Do 记录真正越过传输策略的凭据并返回可重复消费的成功流。
func (client *claudeFairHTTPClient) Do(request *http.Request) (*http.Response, error) {
	client.mu.Lock()
	client.calls++
	if client.apiKeys == nil {
		client.apiKeys = make(map[string]int)
	}
	client.apiKeys[request.Header.Get("x-api-key")]++
	client.mu.Unlock()
	return claudeHTTPResponse(
		http.StatusOK,
		"text/event-stream; charset=utf-8",
		successfulClaudeStream(),
	), nil
}

// CallCount 返回真实 Messages 上游调用次数。
func (client *claudeFairHTTPClient) CallCount() int {
	client.mu.Lock()
	defer client.mu.Unlock()
	return client.calls
}

// APIKeyCounts 返回不暴露内部 Map 的 API Key 命中分布。
func (client *claudeFairHTTPClient) APIKeyCounts() map[string]int {
	client.mu.Lock()
	defer client.mu.Unlock()
	result := make(map[string]int, len(client.apiKeys))
	for key, count := range client.apiKeys {
		result[key] = count
	}
	return result
}

// Do 复制请求正文，便于验证凭据没有进入 JSON。
func (client *claudeRecordingHTTPClient) Do(
	request *http.Request,
) (*http.Response, error) {
	client.calls++
	client.request = request
	if request != nil && request.Body != nil {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			return nil, err
		}
		client.requestBody = body
	}
	return client.response, client.err
}

// claudeHTTPResponse 创建不访问网络的合成上游响应。
func claudeHTTPResponse(
	status int,
	contentType string,
	body string,
) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header: http.Header{
			"Content-Type": []string{contentType},
		},
		Body: io.NopCloser(strings.NewReader(body)),
	}
}

// successfulClaudeStream 返回最小完整 Claude Messages SSE 序列。
func successfulClaudeStream() string {
	return strings.Join([]string{
		"event: message_start",
		`data: {"type":"message_start","message":{"id":"msg_coordinator","type":"message","role":"assistant","model":"claude-sonnet-4-6","content":[],"usage":{"input_tokens":2,"output_tokens":0}}}`,
		"",
		"event: content_block_start",
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		"",
		"event: content_block_delta",
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"adapter-ok"}}`,
		"",
		"event: content_block_stop",
		`data: {"type":"content_block_stop","index":0}`,
		"",
		"event: message_delta",
		`data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}`,
		"",
		"event: message_stop",
		`data: {"type":"message_stop"}`,
		"",
		"",
	}, "\n")
}

// completedClaudeText 提取唯一完成文本。
func completedClaudeText(events []inference.StreamEvent) string {
	var output string
	for _, event := range events {
		if completed, ok := event.(inference.TextCompletedEvent); ok {
			output += completed.Text()
		}
	}
	return output
}

// claudeCandidateSource 返回唯一启用账号。
type claudeCandidateSource struct {
	account accountapp.RoutingAccount
}

// claudeCandidatePoolSource 返回混合凭据账号的固定不可变快照。
type claudeCandidatePoolSource struct {
	accounts []accountapp.RoutingAccount
}

// LoadRoutingCandidates 返回完整 Claude 候选池。
func (source claudeCandidatePoolSource) LoadRoutingCandidates(
	_ context.Context,
	providerID string,
	_ runtimecore.ModelID,
) (*accountapp.RoutingCandidates, error) {
	if providerID != "claude" {
		return accountapp.NewRoutingCandidates(nil), nil
	}
	return accountapp.NewRoutingCandidates(source.accounts), nil
}

// LoadRoutingCandidates 返回唯一账号的不可变候选快照。
func (source claudeCandidateSource) LoadRoutingCandidates(
	_ context.Context,
	providerID string,
	_ runtimecore.ModelID,
) (*accountapp.RoutingCandidates, error) {
	if providerID != source.account.ProviderID() {
		return accountapp.NewRoutingCandidates(nil), nil
	}
	return accountapp.NewRoutingCandidates(
		[]accountapp.RoutingAccount{source.account},
	), nil
}

// claudeAvailableRuntime 让合成账号模型元组保持可征召。
type claudeAvailableRuntime struct{}

// CheckEligibility 返回明确 available 资格。
func (claudeAvailableRuntime) CheckEligibility(
	context.Context,
	runtimecore.ModelRoute,
) (runtimecore.Eligibility, error) {
	return runtimecore.AvailableEligibility(), nil
}

// claudeCredentialResolver 返回与账号身份绑定的合成凭据。
type claudeCredentialResolver struct {
	accountRef accountcore.AccountRef
	credential accountapp.Credential
}

// claudeCredentialPoolResolver 按稳定账号身份返回混合 Claude 测试凭据。
type claudeCredentialPoolResolver struct {
	credentials map[accountcore.AccountRef]accountapp.Credential
}

// ResolveCredentialBinding 返回账号绑定的 Claude 凭据。
func (resolver claudeCredentialPoolResolver) ResolveCredentialBinding(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialBinding, error) {
	credential, found := resolver.credentials[accountRef]
	if !found {
		return accountapp.CredentialBinding{}, accountapp.ErrCredentialNotFound
	}
	return accountapp.NewCredentialBinding(
		accountRef,
		credential.ProviderID(),
		credential,
	)
}

// ResolveCredentialBinding 拒绝其他账号身份并返回稳定账号绑定。
func (resolver claudeCredentialResolver) ResolveCredentialBinding(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialBinding, error) {
	if accountRef != resolver.accountRef {
		return accountapp.CredentialBinding{}, accountapp.ErrCredentialNotFound
	}
	return accountapp.NewCredentialBinding(
		accountRef,
		resolver.credential.ProviderID(),
		resolver.credential,
	)
}

// claudeRouteResolver 返回固定的显式 Claude 路由。
type claudeRouteResolver struct {
	route inferencegateway.Route
}

// Resolve 不根据客户端 alias 猜测 Provider。
func (resolver claudeRouteResolver) Resolve(
	context.Context,
	inference.Request,
) (inferencegateway.RoutePlan, error) {
	return inferencegateway.NewRoutePlan(resolver.route)
}

// claudeAttemptRecorder 保存 Coordinator 的成功与失败提交。
type claudeAttemptRecorder struct {
	successes int
	failures  []inferencegateway.AttemptFailure
}

// claudeModelRefreshScheduler 丢弃与 Adapter 合同无关的异步刷新信号。
type claudeModelRefreshScheduler struct{}

func (claudeModelRefreshScheduler) ScheduleModelRefresh(
	context.Context,
	accountcore.AccountRef,
	string,
) error {
	return nil
}

// RecordSuccess 记录成功终态。
func (recorder *claudeAttemptRecorder) RecordSuccess(
	context.Context,
	runtimecore.ModelRoute,
) error {
	recorder.successes++
	return nil
}

// RecordFailure 记录完整失败分类。
func (recorder *claudeAttemptRecorder) RecordFailure(
	_ context.Context,
	_ runtimecore.ModelRoute,
	failure inferencegateway.AttemptFailure,
) error {
	recorder.failures = append(recorder.failures, failure)
	return nil
}
