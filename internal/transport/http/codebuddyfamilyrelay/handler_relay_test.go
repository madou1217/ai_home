package codebuddyfamilyrelay

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const relayAccountRef = "acct_0123456789abcdef0123"

// familyCredentials 构造一条可用的家族原生凭据（完整 relay 路径需要它）。
func familyCredentials(t *testing.T, accountRef accountcore.AccountRef) (
	accountapp.CredentialBinding,
	accountcredentials.CredentialObservation,
) {
	t.Helper()
	identity, err := accountcore.NewNativeSubjectIdentity("codebuddy", "uid-1")
	if err != nil {
		t.Fatalf("构造原生身份失败: %v", err)
	}
	payload := []byte(`{"credentials":{"auth":{"accessToken":"tok-1","refreshToken":"refresh-1"},` +
		`"account":{"uid":"uid-1"}}}`)
	credential, err := accountcore.NewNativeCredential(identity, payload)
	if err != nil {
		t.Fatalf("构造原生凭据失败: %v", err)
	}
	binding, err := accountapp.NewCredentialBinding(accountRef, "codebuddy", credential)
	if err != nil {
		t.Fatalf("构造凭据绑定失败: %v", err)
	}
	snapshot, err := accountapp.NewCredentialSnapshot(
		accountRef,
		"codebuddy",
		credential,
		time.Unix(1792025000, 0),
	)
	if err != nil {
		t.Fatalf("构造凭据快照失败: %v", err)
	}
	observation, err := accountcredentials.NewCredentialObservation(snapshot)
	if err != nil {
		t.Fatalf("构造凭据观察失败: %v", err)
	}
	return binding, observation
}

// staticCredentials 始终返回同一条凭据，并声明它仍然有效。
type staticCredentials struct {
	binding     accountapp.CredentialBinding
	observation accountcredentials.CredentialObservation
}

func (credentials staticCredentials) ResolveObservedCredentialBinding(
	context.Context,
	accountcore.AccountRef,
) (accountapp.CredentialBinding, accountcredentials.CredentialObservation, error) {
	return credentials.binding, credentials.observation, nil
}

func (staticCredentials) IsCurrentCredentialObservation(
	context.Context,
	accountcredentials.CredentialObservation,
) (bool, error) {
	return true, nil
}

// singleAccountSource 固定产出一个账号（不参与调度）。
type singleAccountSource struct{ accountRef accountcore.AccountRef }

func (source singleAccountSource) Accounts(
	context.Context,
	runtimecore.ModelID,
) (AccountCursor, error) {
	return &singleAccountCursor{accountRef: source.accountRef}, nil
}

// relayHarness 是「真凭据 + 假上游」的完整 relay 装配。
type relayHarness struct {
	handler  *Handler
	fallback *recordingFallback
	upstream *httptest.Server
}

func newRelayHarness(t *testing.T, upstream http.Handler) *relayHarness {
	t.Helper()
	return newRelayHarnessWithAttempts(t, upstream, stubAttempts{})
}

// newRelayHarnessWithAttempts 与 newRelayHarness 相同，但允许注入可断言的运行态记录器。
func newRelayHarnessWithAttempts(
	t *testing.T,
	upstream http.Handler,
	attempts inferencegateway.AttemptRecorder,
) *relayHarness {
	t.Helper()
	server := httptest.NewServer(upstream)
	t.Cleanup(server.Close)
	accountRef, err := accountcore.ParseAccountRef(relayAccountRef)
	if err != nil {
		t.Fatalf("账号引用非法: %v", err)
	}
	binding, observation := familyCredentials(t, accountRef)
	fallback := &recordingFallback{}
	handler, err := NewHandler(Dependencies{
		Accounts:    singleAccountSource{accountRef: accountRef},
		Fallback:    fallback,
		Credentials: staticCredentials{binding: binding, observation: observation},
		Client:      server.Client(),
		Attempts:    attempts,
		Clock:       func() time.Time { return time.Unix(1792025000, 0) },
		Endpoint: func(string) (string, bool) {
			return server.URL + ChatCompletionsPath, true
		},
	})
	if err != nil {
		t.Fatalf("装配失败: %v", err)
	}
	return &relayHarness{handler: handler, fallback: fallback, upstream: server}
}

// recordingAttempts 记录每次运行态写入（用于断言边缘拒绝的记账口径）。
type recordingAttempts struct {
	failures []inferencegateway.AttemptFailure
}

func (*recordingAttempts) RecordSuccess(
	context.Context,
	runtimecore.ModelRoute,
	inferencegateway.AttemptSuccess,
) error {
	return nil
}

func (recorder *recordingAttempts) RecordFailure(
	_ context.Context,
	_ runtimecore.ModelRoute,
	failure inferencegateway.AttemptFailure,
) error {
	recorder.failures = append(recorder.failures, failure)
	return nil
}

// post 发一次 chat completions 请求。
func (harness *relayHarness) post(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	harness.handler.ServeHTTP(response, request)
	return response
}

// decodeJSON 把响应体解析成对象。
func decodeJSON(t *testing.T, body []byte) map[string]json.RawMessage {
	t.Helper()
	fields, ok := decodeRawObject(body)
	if !ok {
		t.Fatalf("响应不是 JSON 对象: %s", body)
	}
	return fields
}

// readAll 读完响应体。
func readAll(t *testing.T, reader io.Reader) []byte {
	t.Helper()
	payload, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("读取响应失败: %v", err)
	}
	return payload
}

const aggregatedSSE = `data: {"id":"cmb-1","model":"hy4-preview","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}` + "\n" +
	`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{}"}}]},"finish_reason":"tool_calls"}],"usage":{"total_tokens":9}}` + "\n" +
	"data: [DONE]\n"

// 完整 relay 路径：改写 → 上游 → 非流式聚合 → 交付（含降级头与归属头）。
func TestServeHTTPRelaysAndAggregatesNonStream(t *testing.T) {
	var gotPath string
	var gotHeaders http.Header
	var gotBody map[string]json.RawMessage
	harness := newRelayHarness(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		gotPath = request.URL.Path
		gotHeaders = request.Header.Clone()
		gotBody, _ = decodeRawObject(readAll(t, request.Body))
		response.Header().Set("Content-Type", "text/event-stream")
		response.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(response, aggregatedSSE)
	}))

	// 客户端钉了一个不在 tools 里的函数：语义保不住，必须显式降级并让客户端看得见。
	const body = `{"model":"hy4-preview","messages":[{"role":"user","content":"hi"}],"stream":false,` +
		`"tool_choice":{"type":"function","function":{"name":"nope"}},` +
		`"tools":[{"type":"function","function":{"name":"read_file"}}]}`
	response := harness.post(t, body)
	if harness.fallback.called {
		t.Fatal("可服务的家族请求不应交回 Canonical")
	}
	// 上游合同：路径、鉴权、真实 UA、站点来源、XHR 标识。
	if gotPath != ChatCompletionsPath {
		t.Fatalf("上游路径 = %q，期望 %q", gotPath, ChatCompletionsPath)
	}
	if gotHeaders.Get("Authorization") != "Bearer tok-1" {
		t.Fatalf("鉴权头错误: %q", gotHeaders.Get("Authorization"))
	}
	if gotHeaders.Get("User-Agent") != UserAgent {
		t.Fatalf("UA 必须是真实客户端标识: %q", gotHeaders.Get("User-Agent"))
	}
	if gotHeaders.Get("X-Requested-With") != "XMLHttpRequest" {
		t.Fatalf("缺 X-Requested-With: %q", gotHeaders.Get("X-Requested-With"))
	}
	// 官方 CLI 身份**不发** Origin / Referer（浏览器语义头，只有桌面/VSCode 身份才带）。
	// 发它们反而是一处与官方不符的差异（2026-10-21 抓包确认）。
	if origin := gotHeaders.Get("Origin"); origin != "" {
		t.Fatalf("官方 CLI 身份不应发 Origin: %q", origin)
	}
	if referer := gotHeaders.Get("Referer"); referer != "" {
		t.Fatalf("官方 CLI 身份不应发 Referer: %q", referer)
	}
	// 官方身份头：实测不参与渠道校验，但复刻它们让请求画像与官方一致。
	if gotHeaders.Get(ProductHeader) != "SaaS" {
		t.Fatalf("缺官方身份头 %s: %q", ProductHeader, gotHeaders.Get(ProductHeader))
	}
	if gotHeaders.Get(DomainHeader) != "www.codebuddy.ai" {
		t.Fatalf("%s 应为站点域名: %q", DomainHeader, gotHeaders.Get(DomainHeader))
	}
	if gotHeaders.Get(IDEVersionHeader) != IDEVersion {
		t.Fatalf("%s 应为 CLI 版本: %q", IDEVersionHeader, gotHeaders.Get(IDEVersionHeader))
	}
	// 渠道校验：会话 ID 家族缺任一个或为空，上游回 400 code 11128（2026-10-21 实测）。
	for _, name := range []string{ConversationIDHeader, ConversationMessageIDHeader, ConversationRequestIDHeader} {
		if strings.TrimSpace(gotHeaders.Get(name)) == "" {
			t.Fatalf("缺渠道校验必需头 %s", name)
		}
	}
	// 官方让 X-Request-ID 与 X-Conversation-Message-ID 同值，复刻它避免留下可区分的差异。
	if gotHeaders.Get(RequestIDHeader) != gotHeaders.Get(ConversationMessageIDHeader) {
		t.Fatalf("%s 应与 %s 同值: %q vs %q",
			RequestIDHeader, ConversationMessageIDHeader,
			gotHeaders.Get(RequestIDHeader), gotHeaders.Get(ConversationMessageIDHeader))
	}
	// 改写：stream 强制 true、首条补 system、tool_choice 降级成 required、tools 原样保留。
	if string(gotBody["stream"]) != "true" {
		t.Fatalf("stream 必须被强制为 true: %s", gotBody["stream"])
	}
	messages, _ := decodeRawArray(gotBody["messages"])
	if len(messages) != 2 {
		t.Fatalf("应补一条 system: %s", gotBody["messages"])
	}
	first, _ := decodeRawObject(messages[0])
	if role, _ := rawString(first["role"]); role != "system" {
		t.Fatalf("首条必须是 system: %s", messages[0])
	}
	if string(gotBody["tool_choice"]) != `"required"` {
		t.Fatalf("钉选没保住时应降级成 required: %s", gotBody["tool_choice"])
	}
	tools, _ := decodeRawArray(gotBody["tools"])
	if len(tools) != 1 {
		t.Fatalf("没保住钉选时不得收窄 tools: %s", gotBody["tools"])
	}
	// 交付：非流式聚合结果 + 降级头 + 归属头。
	if response.Code != http.StatusOK {
		t.Fatalf("状态码 = %d", response.Code)
	}
	if got := response.Header().Get(DegradationHeader); got != DegradationPinMissing {
		t.Fatalf("%s = %q，期望 %q", DegradationHeader, got, DegradationPinMissing)
	}
	if got := response.Header().Get("x-aih-server-account-ref"); got != relayAccountRef {
		t.Fatalf("归属账号头错误: %q", got)
	}
	if got := response.Header().Get("x-aih-server-provider"); got != "codebuddy" {
		t.Fatalf("归属 Provider 头错误: %q", got)
	}
	payload := decodeJSON(t, response.Body.Bytes())
	if object, _ := rawString(payload["object"]); object != "chat.completion" {
		t.Fatalf("非流式客户端必须收到 chat.completion: %s", payload["object"])
	}
	choices := rawArray(payload["choices"])
	choice, _ := decodeRawObject(choices[0])
	if reason, _ := rawString(choice["finish_reason"]); reason != "tool_calls" {
		t.Fatalf("finish_reason 错误: %s", choice["finish_reason"])
	}
	message, _ := decodeRawObject(choice["message"])
	calls := rawArray(message["tool_calls"])
	if len(calls) != 1 {
		t.Fatalf("必须给出可执行的工具调用: %s", message["tool_calls"])
	}
	call, _ := decodeRawObject(calls[0])
	function, _ := decodeRawObject(call["function"])
	if name, _ := rawString(function["name"]); name != "read_file" {
		t.Fatalf("工具名错误: %s", function["name"])
	}
}

// 客户端要流式时逐字节透传（上游富字段不因本端而丢失）。
func TestServeHTTPStreamsVerbatimWhenClientAsksForStream(t *testing.T) {
	harness := newRelayHarness(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "text/event-stream")
		response.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(response, aggregatedSSE)
	}))
	response := harness.post(t, `{"model":"hy4-preview","messages":[{"role":"system","content":"s"}],"stream":true}`)
	if got := response.Body.String(); got != aggregatedSSE {
		t.Fatalf("流式必须逐字节透传:\n得到 %q\n期望 %q", got, aggregatedSSE)
	}
	if got := response.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/event-stream") {
		t.Fatalf("流式 Content-Type 错误: %q", got)
	}
	// 干净路径不带降级头（避免每条响应都是噪音）。
	if got := response.Header().Get(DegradationHeader); got != "" {
		t.Fatalf("干净路径不得下发降级头: %q", got)
	}
}

// 上游错误信封原样交付 + 可换号提示（绝不把真实 403 洗成网关自有错误）。
func TestServeHTTPSurfacesUpstreamEnvelopeAndRetryHint(t *testing.T) {
	const envelope = `{"code":10085,"msg":"请求不合法"}`
	harness := newRelayHarness(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(response, envelope)
	}))
	response := harness.post(t, `{"model":"hy4-preview","messages":[{"role":"system","content":"s"}]}`)
	if response.Code != http.StatusForbidden {
		t.Fatalf("必须原样交付上游状态码，实际 %d", response.Code)
	}
	if got := response.Body.String(); got != envelope {
		t.Fatalf("必须原样交付上游正文，实际 %q", got)
	}
	if got := response.Header().Get("X-AIH-Retry-Account"); got != "true" {
		t.Fatalf("可重试失败应带换号提示，实际 %q", got)
	}
}

// 站点边缘拒绝（APISIX invalid_format）：与账号无关——只记一次 NoStateChange
// 观察（不阻塞、不冷却、不换号），交付网关自己的 502，不透传上游拦截页
// （2026-10-15 事故的镜像修复；Node 同语义）。
func TestServeHTTPDeliversEdgeRejectionAsGatewayError(t *testing.T) {
	const edgeBody = `{"message":"invalid_format"}`
	recorder := &recordingAttempts{}
	harness := newRelayHarnessWithAttempts(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Server", "APISIX/3.9.1")
		response.Header().Set("Content-Type", "text/plain")
		response.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(response, edgeBody)
	}), recorder)
	response := harness.post(t, `{"model":"hy4-preview","messages":[{"role":"system","content":"s"}]}`)
	if response.Code != http.StatusBadGateway {
		t.Fatalf("边缘拒绝必须交付网关 502，实际 %d（%s）", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "invalid_format") {
		t.Fatalf("不得透传边缘拦截页原文: %s", response.Body.String())
	}
	payload := decodeJSON(t, response.Body.Bytes())
	errorObject, _ := decodeRawObject(payload["error"])
	if code, _ := rawString(errorObject["code"]); code != "upstream_edge_rejected" {
		t.Fatalf("错误码应为 upstream_edge_rejected，实际 %q", code)
	}
	if got := response.Header().Get("X-AIH-Retry-Account"); got != "" {
		t.Fatalf("边缘拒绝不得提示换号，实际 %q", got)
	}
	if len(recorder.failures) != 1 ||
		recorder.failures[0].RuntimeKind() != runtimecore.FailureUpstreamEdgeRejected ||
		!recorder.failures[0].BlockDirective().IsZero() ||
		recorder.failures[0].ResponseFailure().Retryable() {
		t.Fatalf("记账口径错误: %#v", recorder.failures)
	}
}

// postWithPins 发一次带钉选头的请求（可给多个值以构造非法钉选）。
func (harness *relayHarness) postWithPins(t *testing.T, body string, pins ...string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	for _, pin := range pins {
		request.Header.Add("X-Account-Ref", pin)
	}
	response := httptest.NewRecorder()
	harness.handler.ServeHTTP(response, request)
	return response
}

// 非法钉选（重复头 / 非规范引用）必须交回 Canonical，**不得当成未钉选请求改派账号**。
//
// 这条用例之所以能区分两条路径：替身凭据对任意账号引用都可用（见下面的对照用例），
// 所以「被错误地当成未钉选」会真的走 relay 并返回 200，而正确实现必须交还 Canonical。
// 旧版本用的是会失败的凭据替身，那时两条路径都因凭据不可用而交还，区分不出来。
func TestServeHTTPRejectsInvalidPinWithUsableCredentials(t *testing.T) {
	body := `{"model":"hy4-preview","messages":[{"role":"system","content":"s"}]}`
	// 对照：单个合法钉选会真的走 relay —— 证明替身可用、本用例不是恒真。
	working := newRelayHarness(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(response, aggregatedSSE)
	}))
	relayed := working.postWithPins(t, body, relayAccountRef)
	if working.fallback.called || relayed.Code != http.StatusOK {
		t.Fatalf("合法钉选应走 relay（fallback=%v code=%d）", working.fallback.called, relayed.Code)
	}
	// 非法钉选：重复头、非规范引用、以及「合法 + 非法」混合。
	cases := [][]string{
		{"not-a-ref"},
		{relayAccountRef, "acct_bbbbbbbbbbbbbbbbbbbb"},
		{relayAccountRef, "not-a-ref"},
	}
	for _, pins := range cases {
		harness := newRelayHarness(t, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			response.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(response, aggregatedSSE)
		}))
		response := harness.postWithPins(t, body, pins...)
		if !harness.fallback.called {
			t.Fatalf("非法钉选 %v 必须交回 Canonical（实际走了 relay，code=%d）", pins, response.Code)
		}
	}
}
