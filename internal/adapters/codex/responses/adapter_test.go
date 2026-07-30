package responses

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
)

// TestAdapterExecutesThroughCoordinator 验证真实 Coordinator 只向 Adapter
// 传递征召后的账号，并在成功记账后提交终态。
func TestAdapterExecutesThroughCoordinator(t *testing.T) {
	t.Parallel()

	upstream := &recordingHTTPClient{
		response: httpResponse(
			http.StatusOK,
			"text/event-stream; charset=utf-8",
			successfulAdapterStream(),
		),
	}
	fixture := newAdapterCoordinatorFixture(t, upstream)
	events := make([]inference.StreamEvent, 0, 10)

	err := fixture.coordinator.Execute(
		t.Context(),
		newAdapterTextRequest(t, true),
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
			"successes=%d failures=%d events=%v",
			fixture.recorder.successes,
			len(fixture.recorder.failures),
			eventKindsForAdapter(events),
		)
	}
	request := upstream.request
	if request == nil ||
		request.URL.String() != "https://upstream.example/v1/responses" ||
		request.Header.Get("Authorization") !=
			"Bearer synthetic-adapter-api-key" ||
		request.Header.Get("Version") != "0.145.0" ||
		request.Header.Get(responsesLiteHeader) != "true" {
		t.Fatalf("upstream request = %#v", request)
	}
	var body map[string]any
	if err := json.Unmarshal(upstream.requestBody, &body); err != nil {
		t.Fatalf("json.Unmarshal(request body) error = %v", err)
	}
	if body["model"] != "gpt-5.6-sol" ||
		body["stream"] != true ||
		body["parallel_tool_calls"] != false ||
		strings.Contains(
			string(upstream.requestBody),
			"synthetic-adapter-api-key",
		) {
		t.Fatalf("request body = %s", upstream.requestBody)
	}
	if _, found := body["tools"]; found {
		t.Fatalf("Lite 顶层 tools 不应存在: %s", upstream.requestBody)
	}
	input := body["input"].([]any)
	if len(input) < 2 ||
		input[0].(map[string]any)["type"] != "additional_tools" {
		t.Fatalf("Lite input = %#v", input)
	}
	t.Logf(
		"POST %s payload.model=%s response.events=%d terminal=%s",
		request.URL,
		body["model"],
		len(events),
		events[len(events)-1].Kind(),
	)
}

// TestAdapterAcceptsMissingContentTypeForRequestedStream 验证官方 Codex
// 成功流省略 Content-Type 时仍按请求中明确的 SSE 合同解析。
func TestAdapterAcceptsMissingContentTypeForRequestedStream(t *testing.T) {
	t.Parallel()

	response := httpResponse(
		http.StatusOK,
		"",
		successfulAdapterStream(),
	)
	response.Header.Del("Content-Type")
	upstream := &recordingHTTPClient{response: response}
	fixture := newAdapterCoordinatorFixture(t, upstream)
	var events []inference.StreamEvent

	err := fixture.coordinator.Execute(
		t.Context(),
		newAdapterTextRequest(t, true),
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
			"successes=%d failures=%d events=%v",
			fixture.recorder.successes,
			len(fixture.recorder.failures),
			eventKindsForAdapter(events),
		)
	}
}

// TestAdapterClassifiesHTTPFailureThroughCoordinator 验证 529 和
// Retry-After 进入模型级运行态分类，且 Provider 原文不会进入客户端失败。
func TestAdapterClassifiesHTTPFailureThroughCoordinator(t *testing.T) {
	t.Parallel()

	response := httpResponse(
		http.StatusServiceUnavailable,
		"application/json",
		`{"error":{"type":"server_error","code":"model_at_capacity","message":"private provider detail"}}`,
	)
	response.StatusCode = 529
	response.Header.Set("Retry-After", "2")
	upstream := &recordingHTTPClient{response: response}
	fixture := newAdapterCoordinatorFixture(t, upstream)
	events := make([]inference.StreamEvent, 0, 1)

	err := fixture.coordinator.Execute(
		t.Context(),
		newAdapterTextRequest(t, false),
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("Coordinator.Execute() error = %v", err)
	}
	if fixture.recorder.successes != 0 ||
		len(fixture.recorder.failures) != 1 ||
		len(events) != 1 {
		t.Fatalf(
			"successes=%d failures=%d events=%v",
			fixture.recorder.successes,
			len(fixture.recorder.failures),
			eventKindsForAdapter(events),
		)
	}
	recorded := fixture.recorder.failures[0]
	failed := events[0].(inference.ResponseFailedEvent)
	if recorded.RuntimeKind() != runtimecore.FailureModelOverloaded ||
		recorded.RetryAfter() != 2*time.Second ||
		failed.Failure().Code() != "model_overloaded" ||
		strings.Contains(failed.Failure().SafeMessage(), "private") {
		t.Fatalf(
			"recorded kind=%s retry=%s public=%#v",
			recorded.RuntimeKind(),
			recorded.RetryAfter(),
			failed.Failure(),
		)
	}
}

// TestAdapterClassifiesSSEFailureThroughCoordinator 验证成功 HTTP 状态中的
// response.failed 仍由 Codex Observer 分类，而不是伪造成 completed。
func TestAdapterClassifiesSSEFailureThroughCoordinator(t *testing.T) {
	t.Parallel()

	upstream := &recordingHTTPClient{
		response: httpResponse(
			http.StatusOK,
			"text/event-stream",
			strings.Join([]string{
				"event: response.failed",
				`data: {"type":"response.failed","response":{"error":{"message":"Selected model is at capacity. Please try a different model."}}}`,
				"",
				"",
			}, "\n"),
		),
	}
	fixture := newAdapterCoordinatorFixture(t, upstream)
	var events []inference.StreamEvent

	err := fixture.coordinator.Execute(
		t.Context(),
		newAdapterTextRequest(t, true),
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
			runtimecore.FailureModelOverloaded ||
		len(events) != 1 ||
		events[0].Kind() != inference.EventResponseFailed {
		t.Fatalf(
			"failures=%v events=%v",
			fixture.recorder.failures,
			eventKindsForAdapter(events),
		)
	}
}

// TestAdapterClassifiesJSONErrorEnvelopeWithSuccessStatus 验证代理错误地返回
// HTTP 200 时，结构化 error envelope 仍进入稳定失败分类。
func TestAdapterClassifiesJSONErrorEnvelopeWithSuccessStatus(t *testing.T) {
	t.Parallel()

	upstream := &recordingHTTPClient{
		response: httpResponse(
			http.StatusOK,
			"application/json",
			`{"error":{"type":"rate_limit_error","code":"rate_limit_exceeded","message":"private rate text"}}`,
		),
	}
	fixture := newAdapterCoordinatorFixture(t, upstream)
	var events []inference.StreamEvent

	err := fixture.coordinator.Execute(
		t.Context(),
		newAdapterTextRequest(t, false),
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
			runtimecore.FailureRateLimited ||
		len(events) != 1 {
		t.Fatalf(
			"failures=%v events=%v",
			fixture.recorder.failures,
			eventKindsForAdapter(events),
		)
	}
	failed := events[0].(inference.ResponseFailedEvent)
	if strings.Contains(failed.Failure().SafeMessage(), "private") {
		t.Fatalf("safe failure = %#v", failed.Failure())
	}
}

// TestAdapterDoesNotTreatDoneSentinelAsSuccess 验证 [DONE] 不能替代
// response.completed，提前终止必须进入 stream_disconnected。
func TestAdapterDoesNotTreatDoneSentinelAsSuccess(t *testing.T) {
	t.Parallel()

	upstream := &recordingHTTPClient{
		response: httpResponse(
			http.StatusOK,
			"text/event-stream",
			"data: [DONE]\n\n",
		),
	}
	fixture := newAdapterCoordinatorFixture(t, upstream)
	var events []inference.StreamEvent

	err := fixture.coordinator.Execute(
		t.Context(),
		newAdapterTextRequest(t, true),
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
			runtimecore.FailureStreamDisconnected ||
		len(events) != 1 ||
		events[0].Kind() != inference.EventResponseFailed {
		t.Fatalf(
			"failures=%v events=%v",
			fixture.recorder.failures,
			eventKindsForAdapter(events),
		)
	}
}

// TestAdapterDecodesCompleteJSONResponse 验证 API Key 代理忽略 stream
// 参数时仍由同一 Decoder 生成增量和终态。
func TestAdapterDecodesCompleteJSONResponse(t *testing.T) {
	t.Parallel()

	upstream := &recordingHTTPClient{
		response: httpResponse(
			http.StatusOK,
			"application/vnd.openai.response+json",
			`{
				"id":"resp_json",
				"model":"gpt-5.6-sol",
				"status":"completed",
				"end_turn":true,
				"output":[{
					"id":"msg_json",
					"type":"message",
					"role":"assistant",
					"status":"completed",
					"content":[{"type":"output_text","text":"json-ok"}]
				}],
				"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}
			}`,
		),
	}
	fixture := newAdapterCoordinatorFixture(t, upstream)
	var events []inference.StreamEvent

	err := fixture.coordinator.Execute(
		t.Context(),
		newAdapterTextRequest(t, false),
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("Coordinator.Execute() error = %v", err)
	}
	assertDecodedText(t, events, "json-ok")
	if events[len(events)-1].Kind() != inference.EventResponseCompleted ||
		fixture.recorder.successes != 1 {
		t.Fatalf(
			"events=%v successes=%d",
			eventKindsForAdapter(events),
			fixture.recorder.successes,
		)
	}
}

// TestAdapterPropagatesCoordinatorSinkError 验证客户端背压不会被记为账号失败。
func TestAdapterPropagatesCoordinatorSinkError(t *testing.T) {
	t.Parallel()

	upstream := &recordingHTTPClient{
		response: httpResponse(
			http.StatusOK,
			"text/event-stream",
			"data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_sink\",\"model\":\"gpt-5.6-sol\"}}\n\n",
		),
	}
	fixture := newAdapterCoordinatorFixture(t, upstream)
	backpressure := errors.New("client disconnected")

	err := fixture.coordinator.Execute(
		t.Context(),
		newAdapterTextRequest(t, true),
		func(inference.StreamEvent) error {
			return backpressure
		},
	)
	if !errors.Is(err, backpressure) ||
		fixture.recorder.successes != 0 ||
		len(fixture.recorder.failures) != 0 {
		t.Fatalf(
			"Execute() error=%v successes=%d failures=%d",
			err,
			fixture.recorder.successes,
			len(fixture.recorder.failures),
		)
	}
}

// TestAdapterClassifiesMalformedStreamWithoutCooldown 验证畸形 JSON 不会被
// 当作传输抖动，也不会让账号模型进入 cooldown。
func TestAdapterClassifiesMalformedStreamWithoutCooldown(t *testing.T) {
	t.Parallel()

	upstream := &recordingHTTPClient{
		response: httpResponse(
			http.StatusOK,
			"text/event-stream",
			"data: not-json\n\n",
		),
	}
	fixture := newAdapterCoordinatorFixture(t, upstream)
	var events []inference.StreamEvent

	err := fixture.coordinator.Execute(
		t.Context(),
		newAdapterTextRequest(t, true),
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
			runtimecore.FailureMalformedResponse ||
		fixture.recorder.failures[0].RetryAfter() != 0 ||
		len(events) != 1 {
		t.Fatalf(
			"failures=%v events=%v",
			fixture.recorder.failures,
			eventKindsForAdapter(events),
		)
	}
}

// TestAdapterClassifiesTransportTimeout 验证 Do 错误只按 Go 错误身份分类。
func TestAdapterClassifiesTransportTimeout(t *testing.T) {
	t.Parallel()

	upstream := &recordingHTTPClient{err: context.DeadlineExceeded}
	fixture := newAdapterCoordinatorFixture(t, upstream)
	var events []inference.StreamEvent

	err := fixture.coordinator.Execute(
		t.Context(),
		newAdapterTextRequest(t, false),
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
			"failures=%v events=%v",
			fixture.recorder.failures,
			eventKindsForAdapter(events),
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
		&recordingHTTPClient{},
		nil,
	); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("NewAdapter(client, nil) error = %v", err)
	}
}

// adapterCoordinatorFixture 保存真实 Coordinator 和测试记录端口。
type adapterCoordinatorFixture struct {
	coordinator *inferencegateway.Coordinator
	recorder    *adapterAttemptRecorder
}

// newAdapterCoordinatorFixture 使用真实 Recruiter 绑定合成 API Key 账号。
func newAdapterCoordinatorFixture(
	t *testing.T,
	client HTTPClient,
) adapterCoordinatorFixture {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	credential, err := codexauth.NewAPIKeyAuth(codexauth.APIKeyInput{
		APIKey:  "synthetic-adapter-api-key",
		BaseURL: "https://upstream.example/v1",
	})
	if err != nil {
		t.Fatalf("codexauth.NewAPIKeyAuth() error = %v", err)
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
			ProviderID:   "codex",
			CLIAccountID: alias,
		},
	)
	if err != nil {
		t.Fatalf("accounts.NewRoutingAccount() error = %v", err)
	}
	recruiter, err := accountrouting.NewRecruiter(
		accountrouting.Dependencies{
			Candidates: adapterCandidateSource{account: account},
			Runtime:    adapterAvailableRuntime{},
			Credentials: adapterCredentialResolver{
				accountRef: accountRef,
				credential: credential,
			},
			Models: adapterAvailableModels{},
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
		inference.ProviderCodex,
		inference.ProtocolCodexResponses,
		"gpt-5.6-sol",
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
		t.Fatalf("responses.NewAdapter() error = %v", err)
	}
	registry, err := inferencegateway.NewUpstreamRegistry(adapter)
	if err != nil {
		t.Fatalf("NewUpstreamRegistry() error = %v", err)
	}
	recorder := &adapterAttemptRecorder{}
	coordinator, err := inferencegateway.NewCoordinator(
		inferencegateway.Dependencies{
			Catalog:   catalog,
			Routes:    adapterRouteResolver{route: route},
			Recruiter: recruiter,
			Upstreams: registry,
			Attempts:  recorder,
		},
	)
	if err != nil {
		t.Fatalf("NewCoordinator() error = %v", err)
	}
	return adapterCoordinatorFixture{
		coordinator: coordinator,
		recorder:    recorder,
	}
}

// newAdapterTextRequest 创建客户端 alias 与真实路由模型不同的请求。
func newAdapterTextRequest(
	t *testing.T,
	stream bool,
) inference.Request {
	t.Helper()

	text, err := inference.NewTextContent("hello adapter")
	if err != nil {
		t.Fatalf("inference.NewTextContent() error = %v", err)
	}
	message, err := inference.NewMessage(inference.RoleUser, text)
	if err != nil {
		t.Fatalf("inference.NewMessage() error = %v", err)
	}
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

// recordingHTTPClient 记录请求并返回单个预设响应。
type recordingHTTPClient struct {
	response    *http.Response
	err         error
	request     *http.Request
	requestBody []byte
}

// Do 复制请求正文，便于验证 Token 没有进入 JSON。
func (client *recordingHTTPClient) Do(
	request *http.Request,
) (*http.Response, error) {
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

// httpResponse 创建不访问网络的合成上游响应。
func httpResponse(
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

// successfulAdapterStream 返回成功终态测试共享的最小完整 SSE 序列。
func successfulAdapterStream() string {
	return strings.Join([]string{
		`event: response.created`,
		`data: {"type":"response.created","response":{"id":"resp_coordinator","model":"gpt-5.6-sol","status":"in_progress"}}`,
		"",
		`event: response.output_item.done`,
		`data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_coordinator","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"adapter-ok"}]}}`,
		"",
		`event: response.completed`,
		`data: {"type":"response.completed","response":{"id":"resp_coordinator","model":"gpt-5.6-sol","status":"completed","end_turn":true,"output":[],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}`,
		"",
		"",
	}, "\n")
}

// adapterCandidateSource 返回唯一启用账号。
type adapterCandidateSource struct {
	account accountapp.RoutingAccount
}

// ListRoutingCandidates 实现稳定 AccountRef 游标。
func (source adapterCandidateSource) ListRoutingCandidates(
	_ context.Context,
	query accountapp.RoutingQuery,
) ([]accountapp.RoutingAccount, error) {
	if query.AfterRef() != "" ||
		query.ProviderID() != source.account.ProviderID() {
		return nil, nil
	}
	return []accountapp.RoutingAccount{source.account}, nil
}

// adapterAvailableRuntime 让合成账号模型元组保持可征召。
type adapterAvailableRuntime struct{}

// CheckEligibility 返回明确 available 资格。
func (adapterAvailableRuntime) CheckEligibility(
	context.Context,
	runtimecore.ModelRoute,
) (runtimecore.Eligibility, error) {
	return runtimecore.AvailableEligibility(), nil
}

// adapterAvailableModels 让合成 Adapter 测试只验证协议与编排合同。
type adapterAvailableModels struct{}

// CheckAvailability 明确允许测试 RouteCatalog 已解析的模型。
func (adapterAvailableModels) CheckAvailability(
	context.Context,
	runtimecore.ModelRoute,
	accountapp.Credential,
) (bool, error) {
	return true, nil
}

// adapterCredentialResolver 返回与账号身份绑定的合成凭据。
type adapterCredentialResolver struct {
	accountRef accountcore.AccountRef
	credential accountapp.Credential
}

// ResolveCredential 拒绝其他账号身份。
func (resolver adapterCredentialResolver) ResolveCredential(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.Credential, error) {
	if accountRef != resolver.accountRef {
		return nil, accountapp.ErrCredentialNotFound
	}
	return resolver.credential, nil
}

// adapterRouteResolver 返回固定的显式 Codex 路由。
type adapterRouteResolver struct {
	route inferencegateway.Route
}

// Resolve 不根据客户端 alias 猜测 Provider。
func (resolver adapterRouteResolver) Resolve(
	context.Context,
	inference.Request,
) (inferencegateway.RoutePlan, error) {
	return inferencegateway.NewRoutePlan(resolver.route)
}

// adapterAttemptRecorder 保存 Coordinator 的成功与失败提交。
type adapterAttemptRecorder struct {
	successes int
	failures  []inferencegateway.AttemptFailure
}

// RecordSuccess 记录成功终态。
func (recorder *adapterAttemptRecorder) RecordSuccess(
	context.Context,
	runtimecore.ModelRoute,
) error {
	recorder.successes++
	return nil
}

// RecordFailure 记录完整失败分类。
func (recorder *adapterAttemptRecorder) RecordFailure(
	_ context.Context,
	_ runtimecore.ModelRoute,
	failure inferencegateway.AttemptFailure,
) error {
	recorder.failures = append(recorder.failures, failure)
	return nil
}

// eventKindsForAdapter 返回便于失败输出的事件类别。
func eventKindsForAdapter(
	events []inference.StreamEvent,
) []inference.EventKind {
	kinds := make([]inference.EventKind, len(events))
	for index, event := range events {
		kinds[index] = event.Kind()
	}
	return kinds
}
