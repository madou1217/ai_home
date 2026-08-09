package aihserver_test

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/host/aihserver"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/anthropicmessagesapi"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
	"github.com/madou1217/ai_home/internal/transport/http/openaichatcompletionsapi"
	"github.com/madou1217/ai_home/internal/transport/http/openairesponsesapi"
)

// TestServerPinnedAccountNeverFallsBack 验证真实 HTTP Header 固定账号且停用后不换号。
func TestServerPinnedAccountNeverFallsBack(t *testing.T) {
	t.Parallel()

	const (
		firstKey  = "sk-codex-pinned-first"
		secondKey = "sk-codex-pinned-second"
	)
	upstream := &syntheticInferenceHTTPClient{}
	baseURL, client := startTestServerWithInferenceClient(t, upstream)
	firstRef := registerAPIKeyAccount(t, client, baseURL, "codex", firstKey)
	_ = registerAPIKeyAccount(t, client, baseURL, "codex", secondKey)
	waitForServerModels(t, client, baseURL, []string{"gpt-5.6-sol"})
	payload := `{"model":"gpt-5.6-sol","input":"pinned-host-smoke"}`
	headers := map[string]string{
		"Authorization":               "Bearer " + testClientKey,
		inferenceapi.AccountRefHeader: firstRef,
	}

	exchange := performRequestWithHeaders(
		t,
		client,
		http.MethodPost,
		baseURL+openairesponsesapi.Path,
		headers,
		[]byte(payload),
	)
	assertStatus(t, exchange, http.StatusOK)
	if upstream.LastAuthorization() != "Bearer "+firstKey || upstream.CallCount() != 1 {
		t.Fatalf(
			"固定账号未命中: authorization=%q calls=%d",
			upstream.LastAuthorization(),
			upstream.CallCount(),
		)
	}

	setAccountEnabled(t, client, baseURL, firstRef, false)
	exchange = performRequestWithHeaders(
		t,
		client,
		http.MethodPost,
		baseURL+openairesponsesapi.Path,
		headers,
		[]byte(payload),
	)
	assertStatus(t, exchange, http.StatusServiceUnavailable)
	if upstream.CallCount() != 1 {
		t.Fatalf("固定账号停用后错误换号: upstream calls=%d", upstream.CallCount())
	}
	t.Logf(
		"POST %s\nheaders: %s=<account_ref>\npayload: %s\nstatus: %d\nresponse: %s",
		baseURL+openairesponsesapi.Path,
		inferenceapi.AccountRefHeader,
		payload,
		exchange.status,
		exchange.body,
	)
}

// TestServerRoutesThreeClientProtocolsThroughProductionCatalog 验证账号注册、
// 原子路由目录、账号征召、真实 Adapter 和三个 HTTP 入口的完整本地 TCP 链路。
func TestServerRoutesThreeClientProtocolsThroughProductionCatalog(
	t *testing.T,
) {
	t.Parallel()

	upstream := &syntheticInferenceHTTPClient{}
	baseURL, client := startTestServerWithInferenceClient(t, upstream)
	codexRef := registerAPIKeyAccount(
		t,
		client,
		baseURL,
		"codex",
		"sk-codex-host-smoke",
	)
	_ = registerAPIKeyAccount(
		t,
		client,
		baseURL,
		"claude",
		"sk-ant-host-smoke",
	)
	waitForServerModels(
		t,
		client,
		baseURL,
		[]string{"gpt-5.6-sol", "claude-sonnet-4"},
	)
	assertCatalogReadiness(t, client, baseURL, 2, 2)

	testCases := []struct {
		name    string
		path    string
		headers map[string]string
		payload string
		output  string
	}{
		{
			name: "responses to codex",
			path: openairesponsesapi.Path,
			headers: map[string]string{
				"Authorization": "Bearer " + testClientKey,
			},
			payload: `{"model":"gpt-5.6-sol","input":"host-smoke"}`,
			output:  "host-codex-ok",
		},
		{
			name: "chat to codex",
			path: openaichatcompletionsapi.Path,
			headers: map[string]string{
				"Authorization": "Bearer " + testClientKey,
			},
			payload: `{"model":"gpt-5.6-sol","messages":[{"role":"user","content":"host-smoke"}]}`,
			output:  "host-codex-ok",
		},
		{
			name: "chat to claude",
			path: openaichatcompletionsapi.Path,
			headers: map[string]string{
				"Authorization": "Bearer " + testClientKey,
			},
			payload: `{"model":"claude-sonnet-4","messages":[{"role":"user","content":"host-smoke"}]}`,
			output:  "host-claude-ok",
		},
		{
			name: "messages to claude",
			path: anthropicmessagesapi.Path,
			headers: map[string]string{
				"x-api-key": testClientKey,
			},
			payload: `{"model":"claude-sonnet-4","max_tokens":32,"messages":[{"role":"user","content":"host-smoke"}]}`,
			output:  "host-claude-ok",
		},
	}
	for _, testCase := range testCases {
		exchange := performRequestWithHeaders(
			t,
			client,
			http.MethodPost,
			baseURL+testCase.path,
			testCase.headers,
			[]byte(testCase.payload),
		)
		assertStatus(t, exchange, http.StatusOK)
		if !strings.Contains(exchange.body, testCase.output) {
			t.Fatalf("%s response = %s", testCase.name, exchange.body)
		}
		t.Logf(
			"POST %s\npayload:\n%s\nstatus: %d\nresponse:\n%s",
			baseURL+testCase.path,
			testCase.payload,
			exchange.status,
			exchange.body,
		)
	}
	if calls := upstream.CallCount(); calls != len(testCases) {
		t.Fatalf("synthetic upstream calls = %d, want %d", calls, len(testCases))
	}
	setAccountEnabled(t, client, baseURL, codexRef, false)
	waitForServerModelVisibility(t, client, baseURL, "gpt-5.6-sol", false)
	setAccountEnabled(t, client, baseURL, codexRef, true)
	waitForServerModelVisibility(t, client, baseURL, "gpt-5.6-sol", true)
}

// TestServerRoutesChatThroughClaudeWithReasoningAndTools 验证 Chat 输入经
// Canonical 层进入 Claude Messages，并把 thinking、文本和工具调用渲染回 Chat。
func TestServerRoutesChatThroughClaudeWithReasoningAndTools(t *testing.T) {
	t.Parallel()

	upstream := &syntheticInferenceHTTPClient{
		claudeStream: claudeReasoningToolSyntheticStream,
	}
	baseURL, client := startTestServerWithInferenceClient(t, upstream)
	_ = registerAPIKeyAccount(
		t,
		client,
		baseURL,
		"claude",
		"sk-ant-chat-claude-smoke",
	)
	waitForServerModels(t, client, baseURL, []string{"claude-sonnet-4"})

	for _, stream := range []bool{false, true} {
		payload := chatClaudeReasoningToolPayload(t, stream)
		exchange := performRequestWithHeaders(
			t,
			client,
			http.MethodPost,
			baseURL+openaichatcompletionsapi.Path,
			map[string]string{
				"Authorization": "Bearer " + testClientKey,
			},
			payload,
		)
		if exchange.status != http.StatusOK {
			upstreamURL, upstreamBody := upstream.LastRequest()
			t.Fatalf(
				"Chat→Claude status=%d response=%s upstream_calls=%d upstream_url=%s upstream_body=%s",
				exchange.status,
				exchange.body,
				upstream.CallCount(),
				upstreamURL,
				upstreamBody,
			)
		}
		assertChatClaudeResponse(t, exchange, stream)
		assertChatClaudeUpstreamRequest(t, upstream)
		t.Logf(
			"POST %s\npayload:\n%s\nstatus: %d\nresponse:\n%s",
			baseURL+openaichatcompletionsapi.Path,
			payload,
			exchange.status,
			exchange.body,
		)
	}
}

// TestServerReplaysResponsesReasoningThroughClaude 验证 Responses 历史中的
// Claude signature 经生产 Decoder、路由和 Adapter 后恢复为原生 thinking。
func TestServerReplaysResponsesReasoningThroughClaude(t *testing.T) {
	t.Parallel()

	upstream := &syntheticInferenceHTTPClient{}
	baseURL, client := startTestServerWithInferenceClient(t, upstream)
	_ = registerAPIKeyAccount(
		t,
		client,
		baseURL,
		"claude",
		"sk-ant-responses-replay-smoke",
	)
	waitForServerModels(t, client, baseURL, []string{"claude-sonnet-4"})
	signature := hostClaudeThinkingSignature()

	for _, stream := range []bool{false, true} {
		payload := responsesClaudeReasoningPayload(t, signature, stream)
		exchange := performRequestWithHeaders(
			t,
			client,
			http.MethodPost,
			baseURL+openairesponsesapi.Path,
			map[string]string{
				"Authorization": "Bearer " + testClientKey,
			},
			payload,
		)
		if exchange.status != http.StatusOK ||
			!strings.Contains(exchange.body, "host-claude-ok") {
			upstreamURL, upstreamBody := upstream.LastRequest()
			t.Fatalf(
				"Responses→Claude status=%d response=%s upstream_url=%s upstream_body=%s",
				exchange.status,
				exchange.body,
				upstreamURL,
				upstreamBody,
			)
		}
		assertResponsesClaudeReasoningRequest(t, upstream, signature)
		if stream {
			assertClaudeStreamRenderedAsResponses(t, exchange.body)
		} else {
			assertClaudeAggregateRenderedAsResponses(t, exchange.body)
		}
		t.Logf(
			"POST %s\npayload:\n%s\nstatus: %d\nresponse:\n%s",
			baseURL+openairesponsesapi.Path,
			payload,
			exchange.status,
			exchange.body,
		)
	}
}

// TestServerRotatesClaudeOAuthAndAPIKeyOnCanonical 验证同一模型的订阅 OAuth
// 与 API Key 在 Canonical Adapter 上按公平票号轮转，两类凭据都真实发出。
func TestServerRotatesClaudeOAuthAndAPIKeyOnCanonical(t *testing.T) {
	t.Parallel()

	upstream := &syntheticInferenceHTTPClient{}
	baseURL, client := startTestServerWithInferenceClient(t, upstream)
	oauthRef := registerNativeClaudeOAuthAccount(t, client, baseURL)
	apiKey := claudeAPIKeyAfter(t, oauthRef)
	_ = registerAPIKeyAccount(
		t,
		client,
		baseURL,
		"claude",
		apiKey,
	)
	waitForServerModels(
		t,
		client,
		baseURL,
		[]string{"claude-sonnet-4"},
	)

	payload := `{"model":"claude-sonnet-4","max_tokens":32,` +
		`"messages":[{"role":"user","content":"transport-fallback"}]}`
	// account_ref 排序保证订阅 OAuth 先被征召，第二轮才轮到 API Key。
	expected := []struct {
		authHeader string
		authValue  string
	}{
		{authHeader: "authorization", authValue: "Bearer " + testClaudeOAuthAccessToken},
		{authHeader: "x-api-key", authValue: apiKey},
	}
	for index, want := range expected {
		exchange := performRequestWithHeaders(
			t,
			client,
			http.MethodPost,
			baseURL+anthropicmessagesapi.Path,
			map[string]string{"x-api-key": testClientKey},
			[]byte(payload),
		)
		assertStatus(t, exchange, http.StatusOK)
		if !strings.Contains(exchange.body, "host-claude-ok") ||
			upstream.CallCount() != index+1 ||
			upstream.LastAuthHeader() != want.authHeader ||
			upstream.LastAuthorization() != want.authValue {
			t.Fatalf(
				"round=%d response=%s calls=%d auth=%s credential_match=%t",
				index+1,
				exchange.body,
				upstream.CallCount(),
				upstream.LastAuthHeader(),
				upstream.LastAuthorization() == want.authValue,
			)
		}
		t.Logf(
			"POST %s round=%d status=%d auth_header=%s",
			baseURL+anthropicmessagesapi.Path,
			index+1,
			exchange.status,
			upstream.LastAuthHeader(),
		)
	}
}

// TestServerProjectsRedactedThinkingToClaudeAPIKeyShape 验证客户端的
// omitted 意图经可直连 API Key 请求投影为 display 和对应 beta。
func TestServerProjectsRedactedThinkingToClaudeAPIKeyShape(t *testing.T) {
	t.Parallel()

	upstream := &syntheticInferenceHTTPClient{}
	baseURL, client := startTestServerWithInferenceClient(t, upstream)
	_ = registerAPIKeyAccount(
		t,
		client,
		baseURL,
		"claude",
		"sk-ant-redacted-shape-smoke",
	)
	waitForServerModels(t, client, baseURL, []string{"claude-sonnet-4"})

	payload := `{"model":"claude-sonnet-4","max_tokens":8000,` +
		`"thinking":{"type":"adaptive","display":"omitted"},` +
		`"messages":[{"role":"user","content":"redacted-shape-contract"}]}`
	exchange := performRequestWithHeaders(
		t,
		client,
		http.MethodPost,
		baseURL+anthropicmessagesapi.Path,
		map[string]string{"x-api-key": testClientKey},
		[]byte(payload),
	)
	assertStatus(t, exchange, http.StatusOK)

	_, upstreamBody := upstream.LastRequest()
	var document struct {
		Thinking map[string]json.RawMessage `json:"thinking"`
	}
	if err := json.Unmarshal(upstreamBody, &document); err != nil {
		t.Fatalf("Claude API Key request json.Unmarshal() error = %v", err)
	}
	if string(document.Thinking["type"]) != `"adaptive"` ||
		string(document.Thinking["display"]) != `"omitted"` ||
		!strings.Contains(
			upstream.LastAnthropicBeta(),
			"redact-thinking-2026-02-12",
		) ||
		upstream.LastAuthHeader() != "x-api-key" {
		t.Fatalf(
			"Claude API Key redacted shape thinking=%s beta=%q auth=%s",
			upstreamBody,
			upstream.LastAnthropicBeta(),
			upstream.LastAuthHeader(),
		)
	}
}

// TestServerCarriesClaudeOAuthOnNativeTransport 验证只有订阅 OAuth 候选时，
// Messages 客户端按官方合同发出 Bearer + OAuth beta 请求，而不是本地判不可用。
//
// 该路径现由透传承载：客户端协议与上游协议一致时字节转发，不再经 Canonical
// 重建，因此响应是上游原始 SSE 而非重建后的 JSON。官方合同（Bearer 认证、
// oauth 与 claude-code beta）仍必须完整发出——缺任一项都会被上游按非订阅调用拒绝。
func TestServerCarriesClaudeOAuthOnNativeTransport(t *testing.T) {
	t.Parallel()

	upstream := &syntheticInferenceHTTPClient{}
	baseURL, client := startTestServerWithInferenceClient(t, upstream)
	_ = registerNativeClaudeOAuthAccount(t, client, baseURL)
	waitForServerModels(t, client, baseURL, []string{"claude-sonnet-4"})

	payload := `{"model":"claude-sonnet-4","max_tokens":8000,` +
		`"messages":[{"role":"user","content":"rate-limit-contract"}]}`
	exchange := performRequestWithHeaders(
		t,
		client,
		http.MethodPost,
		baseURL+anthropicmessagesapi.Path,
		map[string]string{"x-api-key": testClientKey},
		[]byte(payload),
	)

	if exchange.status != http.StatusOK ||
		!strings.Contains(exchange.body, "host-claude-ok") ||
		upstream.CallCount() != 1 ||
		upstream.LastAuthHeader() != "authorization" ||
		upstream.LastAuthorization() != "Bearer "+testClaudeOAuthAccessToken ||
		!strings.Contains(upstream.LastAnthropicBeta(), "oauth-2025-04-20") ||
		!strings.Contains(upstream.LastAnthropicBeta(), "claude-code-20250219") {
		t.Fatalf(
			"Claude OAuth native transport status=%d body=%s calls=%d auth=%s beta=%q",
			exchange.status,
			exchange.body,
			upstream.CallCount(),
			upstream.LastAuthHeader(),
			upstream.LastAnthropicBeta(),
		)
	}
	t.Logf(
		"POST %s payload=%s status=%d upstream_calls=%d auth_header=%s beta=%q",
		baseURL+anthropicmessagesapi.Path,
		payload,
		exchange.status,
		upstream.CallCount(),
		upstream.LastAuthHeader(),
		upstream.LastAnthropicBeta(),
	)
}

// TestServerRelaysCodexResponsesToPinnedClaudeOAuthAccount 覆盖
// `aih codex relay claude <id>` 的完整线上形状：Codex 客户端继续发 Responses
// 请求，X-Account-Ref 固定到一个订阅 OAuth 的 Claude 账号，Server 必须用
// Canonical Adapter 转码成 Anthropic Messages 线协议并原样带上该账号凭据。
//
// 这条用例同时锁定三件跨协议合同：Codex 真实发出的 store/include/instructions
// 不会污染上游正文；Responses 省略输出上限时 max_tokens 由 Claude Code 的每模型
// 默认值补齐；instructions 投影为 system，而不是被替换成伪造的客户端身份。
func TestServerRelaysCodexResponsesToPinnedClaudeOAuthAccount(t *testing.T) {
	t.Parallel()

	const instructions = "你是跨协议验收使用的助手。"
	upstream := &syntheticInferenceHTTPClient{}
	baseURL, client := startTestServerWithInferenceClient(t, upstream)
	claudeRef := registerNativeClaudeOAuthAccount(t, client, baseURL)
	waitForServerModels(t, client, baseURL, []string{"claude-sonnet-4"})

	payload := codexResponsesPayload(t, instructions)
	exchange := performRequestWithHeaders(
		t,
		client,
		http.MethodPost,
		baseURL+openairesponsesapi.Path,
		map[string]string{
			"Authorization":               "Bearer " + testClientKey,
			inferenceapi.AccountRefHeader: claudeRef,
		},
		payload,
	)

	upstreamURL, upstreamBody := upstream.LastRequest()
	if exchange.status != http.StatusOK ||
		!strings.Contains(exchange.body, "host-claude-ok") ||
		upstream.CallCount() != 1 {
		t.Fatalf(
			"跨协议固定账号 status=%d body=%s calls=%d upstream_url=%s upstream_body=%s",
			exchange.status,
			exchange.body,
			upstream.CallCount(),
			upstreamURL,
			upstreamBody,
		)
	}
	if upstream.LastAuthHeader() != "authorization" ||
		upstream.LastAuthorization() != "Bearer "+testClaudeOAuthAccessToken ||
		!strings.Contains(upstream.LastAnthropicBeta(), "oauth-2025-04-20") ||
		!strings.Contains(upstream.LastAnthropicBeta(), "claude-code-20250219") {
		t.Fatalf(
			"跨协议未使用固定账号订阅 OAuth: auth_header=%s beta=%q",
			upstream.LastAuthHeader(),
			upstream.LastAnthropicBeta(),
		)
	}
	if !strings.HasSuffix(upstreamURL, "/v1/messages") {
		t.Fatalf("跨协议上游端点错误: %s", upstreamURL)
	}
	assertCodexResponsesToClaudeWire(t, upstreamBody, instructions)
	assertClaudeStreamRenderedAsResponses(t, exchange.body)
	t.Logf(
		"POST %s\nheaders: %s=<claude_account_ref>\npayload:\n%s\n"+
			"status: %d\nupstream_url: %s\nupstream_body:\n%s\nresponse:\n%s",
		baseURL+openairesponsesapi.Path,
		inferenceapi.AccountRefHeader,
		payload,
		exchange.status,
		upstreamURL,
		upstreamBody,
		exchange.body,
	)
}

// codexResponsesPayload 复刻官方 Codex 对非 Azure 端点真实发出的请求形状：
// store 恒为 false、include 只含加密 reasoning、且不携带任何输出上限。
func codexResponsesPayload(t *testing.T, instructions string) []byte {
	t.Helper()

	store := false
	payload, err := json.Marshal(map[string]any{
		"model":        "claude-sonnet-4",
		"instructions": instructions,
		"input": []map[string]any{{
			"type": "message",
			"role": "user",
			"content": []map[string]string{{
				"type": "input_text",
				"text": "跨协议固定账号验收",
			}},
		}},
		"stream":    true,
		"store":     store,
		"include":   []string{"reasoning.encrypted_content"},
		"reasoning": map[string]string{"effort": "medium", "summary": "auto"},
	})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	return payload
}

// assertCodexResponsesToClaudeWire 校验转码结果符合 Anthropic Messages 合同，
// 并且没有夹带 Responses 独有字段或伪造的客户端身份。
func assertCodexResponsesToClaudeWire(
	t *testing.T,
	upstreamBody []byte,
	instructions string,
) {
	t.Helper()

	var request struct {
		Model     string `json:"model"`
		MaxTokens uint64 `json:"max_tokens"`
		Stream    bool   `json:"stream"`
		System    []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"system"`
		Messages []struct {
			Role string `json:"role"`
		} `json:"messages"`
	}
	decodeJSON(t, string(upstreamBody), &request)
	// claude-sonnet-4 落在 Claude Code 现代模型默认值上；跨协议客户端省略输出
	// 上限时必须由该默认值补齐，Anthropic Messages 的 max_tokens 是必填字段。
	if request.Model != "claude-sonnet-4" ||
		request.MaxTokens != 32_000 ||
		!request.Stream ||
		len(request.Messages) != 1 ||
		request.Messages[0].Role != "user" {
		t.Fatalf("跨协议转码正文错误: %s", upstreamBody)
	}
	// 订阅 OAuth 按 Claude Code 客户端合同调用：官方身份块必须排在最前，
	// 客户端自己的 instructions 原样跟在其后，不被覆盖也不被改写。
	if len(request.System) != 2 ||
		request.System[0].Type != "text" ||
		request.System[0].Text !=
			"You are Claude Code, Anthropic's official CLI for Claude." ||
		request.System[1].Type != "text" ||
		request.System[1].Text != instructions {
		t.Fatalf(
			"订阅 OAuth system 未按官方客户端合同投影: %s",
			upstreamBody,
		)
	}
	for _, leaked := range []string{
		`"store"`,
		`"include"`,
		`"instructions"`,
		`"input"`,
		`"reasoning"`,
	} {
		if strings.Contains(string(upstreamBody), leaked) {
			t.Fatalf("上游正文夹带 Responses 独有字段 %s: %s", leaked, upstreamBody)
		}
	}
}

// assertClaudeStreamRenderedAsResponses 校验回程方向：上游 Anthropic 帧必须被
// 渲染成 Responses 事件流。跨协议只转码请求不转码响应，Codex 客户端会在
// content_block_delta 上解析失败，因此这里同时正向断言 Responses 事件名、
// 反向断言 Anthropic 帧名不得穿透到客户端。
func assertClaudeStreamRenderedAsResponses(t *testing.T, body string) {
	t.Helper()

	for _, expected := range []string{
		"response.created",
		"response.in_progress",
		"response.output_text.delta",
		"response.output_text.done",
		"response.completed",
	} {
		if !strings.Contains(body, expected) {
			t.Fatalf("回程缺少 Responses 事件 %s: %s", expected, body)
		}
	}
	for _, leaked := range []string{
		"message_start",
		"content_block_start",
		"content_block_delta",
		"content_block_stop",
		"message_delta",
		"message_stop",
		"text_delta",
	} {
		if strings.Contains(body, leaked) {
			t.Fatalf("Anthropic 帧 %s 穿透到 Responses 客户端: %s", leaked, body)
		}
	}
	// 正文本身必须完成投递，而不是只剩下事件骨架。
	if !strings.Contains(body, "host-claude-ok") {
		t.Fatalf("回程未投递上游正文: %s", body)
	}
}

// assertClaudeAggregateRenderedAsResponses 校验非流式回程同样被聚合成
// Responses 响应对象，而不是把 Anthropic Messages 的响应体原样透出。
func assertClaudeAggregateRenderedAsResponses(t *testing.T, body string) {
	t.Helper()

	var response struct {
		Object string            `json:"object"`
		Status string            `json:"status"`
		Output []json.RawMessage `json:"output"`
	}
	decodeJSON(t, body, &response)
	if response.Object != "response" ||
		response.Status != "completed" ||
		len(response.Output) == 0 {
		t.Fatalf("非流式回程不是 Responses 响应对象: %s", body)
	}
	if !strings.Contains(body, "host-claude-ok") {
		t.Fatalf("非流式回程未投递上游正文: %s", body)
	}
}

// syntheticInferenceHTTPClient 根据真实 Adapter 的目标主机返回确定性 SSE。
type syntheticInferenceHTTPClient struct {
	mu             sync.Mutex
	calls          int
	lastAuthHeader string
	lastAuthValue  string
	lastURL        string
	lastBody       []byte
	lastBeta       string
	claudeStream   func(model string) string
}

func (client *syntheticInferenceHTTPClient) Do(
	request *http.Request,
) (*http.Response, error) {
	body, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, err
	}
	authHeader := ""
	switch {
	case request.Header.Get("x-api-key") != "":
		authHeader = "x-api-key"
	case request.Header.Get("Authorization") != "":
		authHeader = "authorization"
	}
	client.mu.Lock()
	client.calls++
	client.lastAuthHeader = authHeader
	client.lastURL = request.URL.String()
	client.lastBody = append(client.lastBody[:0], body...)
	client.lastBeta = request.Header.Get("anthropic-beta")
	if authHeader != "" {
		client.lastAuthValue = request.Header.Get(authHeader)
	}
	claudeStream := client.claudeStream
	client.mu.Unlock()
	stream := codexSyntheticStream(payload.Model)
	if strings.Contains(request.URL.Host, "anthropic.com") {
		stream = claudeSyntheticStream(payload.Model)
		if claudeStream != nil {
			stream = claudeStream(payload.Model)
		}
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Header: http.Header{
			"Content-Type": []string{"text/event-stream"},
		},
		Body: io.NopCloser(strings.NewReader(stream)),
	}, nil
}

// LastAuthorization 返回最近一次合成上游认证值，仅供测试验证账号绑定。
func (client *syntheticInferenceHTTPClient) LastAuthorization() string {
	client.mu.Lock()
	defer client.mu.Unlock()
	return client.lastAuthValue
}

func (client *syntheticInferenceHTTPClient) CallCount() int {
	client.mu.Lock()
	defer client.mu.Unlock()
	return client.calls
}

// LastAuthHeader 返回最近请求使用的认证 Header 名，不保存凭据值。
func (client *syntheticInferenceHTTPClient) LastAuthHeader() string {
	client.mu.Lock()
	defer client.mu.Unlock()
	return client.lastAuthHeader
}

// LastRequest 返回最近一次合成上游请求的 URL 和独立正文副本。
func (client *syntheticInferenceHTTPClient) LastRequest() (string, []byte) {
	client.mu.Lock()
	defer client.mu.Unlock()
	return client.lastURL, append([]byte(nil), client.lastBody...)
}

// LastAnthropicBeta 返回最近一次请求的脱敏 beta 能力列表。
func (client *syntheticInferenceHTTPClient) LastAnthropicBeta() string {
	client.mu.Lock()
	defer client.mu.Unlock()
	return client.lastBeta
}

// chatClaudeReasoningToolPayload 创建包含历史工具结果的 Chat 请求。
func chatClaudeReasoningToolPayload(t *testing.T, stream bool) []byte {
	t.Helper()

	payload, err := json.Marshal(map[string]any{
		"model": "claude-sonnet-4",
		"messages": []map[string]any{
			{"role": "system", "content": "只使用已声明工具"},
			{"role": "user", "content": "查询深圳天气"},
			{
				"role":    "assistant",
				"content": "正在查询",
				"tool_calls": []map[string]any{{
					"id":   "call_weather_history",
					"type": "function",
					"function": map[string]string{
						"name":      "weather",
						"arguments": `{"city":"深圳"}`,
					},
				}},
			},
			{
				"role":         "tool",
				"tool_call_id": "call_weather_history",
				"content":      "晴天",
			},
		},
		"tools": []map[string]any{{
			"type": "function",
			"function": map[string]any{
				"name":        "weather",
				"description": "查询天气",
				"parameters": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"city": map[string]string{"type": "string"},
					},
					"required": []string{"city"},
				},
				"strict": true,
			},
		}},
		"tool_choice":           "auto",
		"parallel_tool_calls":   false,
		"reasoning_effort":      "high",
		"max_completion_tokens": 512,
		"stream":                stream,
	})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	if stream {
		var document map[string]any
		if err := json.Unmarshal(payload, &document); err != nil {
			t.Fatalf("json.Unmarshal() error = %v", err)
		}
		document["stream_options"] = map[string]bool{"include_usage": true}
		payload, err = json.Marshal(document)
		if err != nil {
			t.Fatalf("json.Marshal(stream) error = %v", err)
		}
	}
	return payload
}

// assertChatClaudeUpstreamRequest 校验 Chat 输入没有绕过 Canonical Adapter。
func assertChatClaudeUpstreamRequest(
	t *testing.T,
	upstream *syntheticInferenceHTTPClient,
) {
	t.Helper()

	requestURL, body := upstream.LastRequest()
	if !strings.HasPrefix(requestURL, "https://api.anthropic.com/v1/messages") ||
		upstream.LastAuthHeader() != "x-api-key" {
		t.Fatalf("Claude upstream url=%q auth=%q", requestURL, upstream.LastAuthHeader())
	}
	var request struct {
		Model     string `json:"model"`
		MaxTokens uint64 `json:"max_tokens"`
		Stream    bool   `json:"stream"`
		System    []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"system"`
		Messages []struct {
			Role    string `json:"role"`
			Content []struct {
				Type      string          `json:"type"`
				ID        string          `json:"id"`
				Name      string          `json:"name"`
				ToolUseID string          `json:"tool_use_id"`
				Input     json.RawMessage `json:"input"`
			} `json:"content"`
		} `json:"messages"`
		Tools []struct {
			Type   string `json:"type"`
			Name   string `json:"name"`
			Strict *bool  `json:"strict"`
		} `json:"tools"`
		ToolChoice struct {
			Type                   string `json:"type"`
			DisableParallelToolUse *bool  `json:"disable_parallel_tool_use"`
		} `json:"tool_choice"`
		OutputConfig struct {
			Effort string `json:"effort"`
		} `json:"output_config"`
	}
	if err := json.Unmarshal(body, &request); err != nil {
		t.Fatalf("Claude request json.Unmarshal() error = %v body=%s", err, body)
	}
	if request.Model != "claude-sonnet-4" ||
		request.MaxTokens != 512 ||
		!request.Stream ||
		len(request.System) != 1 ||
		request.System[0].Text != "只使用已声明工具" ||
		len(request.Messages) != 3 ||
		len(request.Tools) != 1 ||
		request.Tools[0].Type != "custom" ||
		request.Tools[0].Name != "weather" ||
		request.Tools[0].Strict == nil ||
		!*request.Tools[0].Strict ||
		request.ToolChoice.Type != "auto" ||
		request.ToolChoice.DisableParallelToolUse == nil ||
		!*request.ToolChoice.DisableParallelToolUse ||
		request.OutputConfig.Effort != "high" {
		t.Fatalf("Claude request mapping = %#v body=%s", request, body)
	}
	assistant := request.Messages[1].Content
	toolResult := request.Messages[2].Content
	if len(assistant) != 2 ||
		assistant[1].Type != "tool_use" ||
		assistant[1].ID != "call_weather_history" ||
		assistant[1].Name != "weather" ||
		string(assistant[1].Input) != `{"city":"深圳"}` ||
		len(toolResult) != 1 ||
		toolResult[0].Type != "tool_result" ||
		toolResult[0].ToolUseID != "call_weather_history" {
		t.Fatalf("Claude tool history = %#v %#v", assistant, toolResult)
	}
}

// assertChatClaudeResponse 校验非流式和流式 Chat 都保留可见 reasoning 与工具。
func assertChatClaudeResponse(t *testing.T, exchange httpExchange, stream bool) {
	t.Helper()

	if stream {
		assertChatClaudeStream(t, exchange)
		return
	}

	required := []string{
		`"reasoning_content":"先分析"`,
		"准备调用工具",
		`"name":"weather"`,
		`{\"city\":\"上海\"}`,
		`"finish_reason":"tool_calls"`,
	}
	for _, fragment := range required {
		if !strings.Contains(exchange.body, fragment) {
			t.Fatalf("Chat→Claude response missing %q: %s", fragment, exchange.body)
		}
	}
	if !strings.HasPrefix(exchange.header.Get("Content-Type"), "application/json") ||
		!strings.Contains(exchange.body, `"object":"chat.completion"`) {
		t.Fatalf("Chat→Claude JSON response = %#v", exchange)
	}
}

// assertChatClaudeStream 按 Chat delta 语义重组流式响应，避免依赖上游分片边界。
func assertChatClaudeStream(t *testing.T, exchange httpExchange) {
	t.Helper()

	if !strings.HasPrefix(exchange.header.Get("Content-Type"), "text/event-stream") {
		t.Fatalf("Chat→Claude stream content-type = %q", exchange.header.Get("Content-Type"))
	}

	var reasoning strings.Builder
	var content strings.Builder
	var arguments strings.Builder
	var toolID string
	var toolName string
	var finishReason string
	usageSeen := false
	doneSeen := false
	for _, line := range strings.Split(exchange.body, "\n") {
		frame, found := strings.CutPrefix(line, "data: ")
		if !found {
			continue
		}
		if frame == "[DONE]" {
			doneSeen = true
			continue
		}

		var chunk struct {
			Choices []struct {
				Delta struct {
					Content          string `json:"content"`
					ReasoningContent string `json:"reasoning_content"`
					ToolCalls        []struct {
						Index    int    `json:"index"`
						ID       string `json:"id"`
						Function struct {
							Name      string `json:"name"`
							Arguments string `json:"arguments"`
						} `json:"function"`
					} `json:"tool_calls"`
				} `json:"delta"`
				FinishReason *string `json:"finish_reason"`
			} `json:"choices"`
			Usage json.RawMessage `json:"usage"`
		}
		if err := json.Unmarshal([]byte(frame), &chunk); err != nil {
			t.Fatalf("Chat→Claude stream frame json.Unmarshal() error = %v frame=%s", err, frame)
		}
		if len(chunk.Choices) == 0 && len(chunk.Usage) > 0 {
			usageSeen = true
		}
		for _, choice := range chunk.Choices {
			reasoning.WriteString(choice.Delta.ReasoningContent)
			content.WriteString(choice.Delta.Content)
			if choice.FinishReason != nil {
				finishReason = *choice.FinishReason
			}
			for _, toolCall := range choice.Delta.ToolCalls {
				if toolCall.Index != 0 {
					t.Fatalf("Chat→Claude tool index = %d, want 0", toolCall.Index)
				}
				if toolCall.ID != "" {
					toolID = toolCall.ID
				}
				if toolCall.Function.Name != "" {
					toolName = toolCall.Function.Name
				}
				arguments.WriteString(toolCall.Function.Arguments)
			}
		}
	}

	if reasoning.String() != "先分析" ||
		content.String() != "准备调用工具" ||
		toolID != "toolu_weather_new" ||
		toolName != "weather" ||
		arguments.String() != `{"city":"上海"}` ||
		finishReason != "tool_calls" ||
		!usageSeen ||
		!doneSeen {
		t.Fatalf(
			"Chat→Claude stream projection reasoning=%q content=%q tool=%q/%q arguments=%q finish=%q usage=%t done=%t body=%s",
			reasoning.String(),
			content.String(),
			toolID,
			toolName,
			arguments.String(),
			finishReason,
			usageSeen,
			doneSeen,
			exchange.body,
		)
	}
}

// responsesClaudeReasoningPayload 创建需要恢复 Claude signed thinking 的请求。
func responsesClaudeReasoningPayload(
	t *testing.T,
	signature string,
	stream bool,
) []byte {
	t.Helper()

	payload, err := json.Marshal(map[string]any{
		"model": "claude-sonnet-4",
		"input": []map[string]any{
			{
				"type": "reasoning",
				"summary": []map[string]string{{
					"type": "summary_text",
					"text": "先分析历史",
				}},
				"encrypted_content": signature,
			},
			{
				"type": "message",
				"role": "assistant",
				"content": []map[string]string{{
					"type": "output_text",
					"text": "历史回答",
				}},
			},
			{
				"type": "message",
				"role": "user",
				"content": []map[string]string{{
					"type": "input_text",
					"text": "继续",
				}},
			},
		},
		"stream": stream,
	})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	return payload
}

// assertResponsesClaudeReasoningRequest 校验 production composition 没有
// 把 Claude signature 当成 redacted_thinking 或丢失 visible assistant 历史。
func assertResponsesClaudeReasoningRequest(
	t *testing.T,
	upstream *syntheticInferenceHTTPClient,
	signature string,
) {
	t.Helper()

	requestURL, body := upstream.LastRequest()
	if !strings.HasPrefix(requestURL, "https://api.anthropic.com/v1/messages") ||
		upstream.LastAuthHeader() != "x-api-key" {
		t.Fatalf("Claude upstream url=%q auth=%q", requestURL, upstream.LastAuthHeader())
	}
	var request struct {
		Messages []struct {
			Role    string `json:"role"`
			Content []struct {
				Type      string  `json:"type"`
				Thinking  *string `json:"thinking"`
				Signature string  `json:"signature"`
				Text      string  `json:"text"`
				Data      string  `json:"data"`
			} `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(body, &request); err != nil {
		t.Fatalf("Claude request json.Unmarshal() error = %v body=%s", err, body)
	}
	if len(request.Messages) != 2 ||
		request.Messages[0].Role != "assistant" ||
		len(request.Messages[0].Content) != 2 ||
		request.Messages[0].Content[0].Type != "thinking" ||
		request.Messages[0].Content[0].Thinking == nil ||
		*request.Messages[0].Content[0].Thinking != "先分析历史" ||
		request.Messages[0].Content[0].Signature != signature ||
		request.Messages[0].Content[0].Data != "" ||
		request.Messages[0].Content[1].Type != "text" ||
		request.Messages[0].Content[1].Text != "历史回答" ||
		request.Messages[1].Role != "user" {
		t.Fatalf("Responses→Claude upstream messages = %#v body=%s", request.Messages, body)
	}
}

// hostClaudeThinkingSignature 创建与 CPA 源码夹具一致的 E-form 签名。
func hostClaudeThinkingSignature() string {
	channel := appendHostProtoVarint(nil, 1, 12)
	channel = appendHostProtoVarint(channel, 2, 2)
	channel = appendHostProtoBytes(channel, 6, []byte("claude-sonnet-4-6"))
	container := appendHostProtoBytes(nil, 1, channel)
	payload := appendHostProtoBytes(nil, 2, container)
	payload = appendHostProtoVarint(payload, 3, 1)
	return base64.StdEncoding.EncodeToString(payload)
}

// appendHostProtoVarint 追加生产组合测试使用的 protobuf varint 字段。
func appendHostProtoVarint(output []byte, field uint64, value uint64) []byte {
	output = binary.AppendUvarint(output, field<<3)
	return binary.AppendUvarint(output, value)
}

// appendHostProtoBytes 追加生产组合测试使用的 protobuf bytes 字段。
func appendHostProtoBytes(output []byte, field uint64, value []byte) []byte {
	output = binary.AppendUvarint(output, field<<3|2)
	output = binary.AppendUvarint(output, uint64(len(value)))
	return append(output, value...)
}

// registerNativeClaudeOAuthAccount 通过原生导入 API 创建官方 OAuth 账号。
func registerNativeClaudeOAuthAccount(
	t *testing.T,
	client *http.Client,
	baseURL string,
) string {
	t.Helper()

	exchange := performRequest(
		t,
		client,
		http.MethodPost,
		baseURL+accountsapi.NativeImportPath,
		testManagementKey,
		claudeNativeImportBody(
			t,
			testClaudeOAuthAccessToken,
			"sk-ant-ort01-canonical-skip",
		),
	)
	assertStatus(t, exchange, http.StatusCreated)
	var document struct {
		Data struct {
			AccountRef string `json:"account_ref"`
		} `json:"data"`
	}
	decodeJSON(t, exchange.body, &document)
	if document.Data.AccountRef == "" {
		t.Fatalf("原生 Claude 导入缺少 account_ref: %s", exchange.body)
	}
	return document.Data.AccountRef
}

// claudeAPIKeyAfter 构造字典序位于 OAuth 账号后的 API Key 身份，
// 确保测试真实覆盖“先跳过 OAuth，再选择 API Key”。
func claudeAPIKeyAfter(t *testing.T, oauthRef string) string {
	t.Helper()

	for index := 0; index < 10_000; index++ {
		apiKey := fmt.Sprintf("sk-ant-api03-canonical-fallback-%d", index)
		credential, err := claudeauth.NewAPIKeyAuth(
			claudeauth.APIKeyInput{APIKey: apiKey},
		)
		if err != nil {
			t.Fatalf("claude.NewAPIKeyAuth() error = %v", err)
		}
		accountRef, err := accountcore.DeriveAccountRef(credential)
		if err != nil {
			t.Fatalf("accounts.DeriveAccountRef() error = %v", err)
		}
		if accountRef.String() > oauthRef {
			return apiKey
		}
	}
	t.Fatal("未找到排序在 OAuth 账号后的 Claude API Key 测试身份")
	return ""
}

// registerAPIKeyAccount 通过正式管理 API 注册一个测试账号。
func registerAPIKeyAccount(
	t *testing.T,
	client *http.Client,
	baseURL string,
	providerID string,
	apiKey string,
) string {
	t.Helper()

	payload, err := json.Marshal(map[string]any{
		"provider_id": providerID,
		"auth": map[string]string{
			"kind":    "api_key",
			"api_key": apiKey,
		},
	})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	exchange := performRequest(
		t,
		client,
		http.MethodPost,
		baseURL+accountsapi.CollectionPath,
		testManagementKey,
		payload,
	)
	assertStatus(t, exchange, http.StatusCreated)
	var document struct {
		Data struct {
			AccountRef string `json:"account_ref"`
		} `json:"data"`
	}
	decodeJSON(t, exchange.body, &document)
	if document.Data.AccountRef == "" {
		t.Fatalf("创建账号响应缺少 account_ref: %s", exchange.body)
	}
	return document.Data.AccountRef
}

// setAccountEnabled 通过正式 PATCH API 改变账号是否进入模型倒排。
func setAccountEnabled(
	t *testing.T,
	client *http.Client,
	baseURL string,
	accountRef string,
	enabled bool,
) {
	t.Helper()

	payload, err := json.Marshal(map[string]bool{"enabled": enabled})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	exchange := performRequest(
		t,
		client,
		http.MethodPatch,
		baseURL+accountsapi.CollectionPath+"/"+accountRef,
		testManagementKey,
		payload,
	)
	assertStatus(t, exchange, http.StatusOK)
}

// waitForServerModels 等待异步目录 worker 发布包含全部模型的一个完整快照。
func waitForServerModels(
	t *testing.T,
	client *http.Client,
	baseURL string,
	models []string,
) {
	t.Helper()

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		exchange := performRequest(
			t,
			client,
			http.MethodGet,
			baseURL+"/v1/models",
			testClientKey,
			nil,
		)
		if exchange.status == http.StatusOK {
			complete := true
			for _, model := range models {
				complete = complete &&
					strings.Contains(exchange.body, `"id":"`+model+`"`)
			}
			if complete {
				return
			}
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("等待模型目录发布超时: models=%v", models)
}

// assertCatalogReadiness 验证探针与当前发布快照使用同一计数事实。
func assertCatalogReadiness(
	t *testing.T,
	client *http.Client,
	baseURL string,
	modelCount int,
	routeCount int,
) {
	t.Helper()

	exchange := performRequest(
		t,
		client,
		http.MethodGet,
		baseURL+"/readyz",
		"",
		nil,
	)
	assertStatus(t, exchange, http.StatusOK)
	var document struct {
		Ready                 bool `json:"ready"`
		InferenceCatalogReady bool `json:"inference_catalog_ready"`
		InferenceCatalogStale bool `json:"inference_catalog_stale"`
		ModelCount            int  `json:"model_count"`
		RouteCount            int  `json:"route_count"`
	}
	decodeJSON(t, exchange.body, &document)
	if !document.Ready ||
		!document.InferenceCatalogReady ||
		document.InferenceCatalogStale ||
		document.ModelCount != modelCount ||
		document.RouteCount != routeCount {
		t.Fatalf("readyz catalog status = %#v", document)
	}
}

// waitForServerModelVisibility 等待启停变化完整发布到模型展示快照。
func waitForServerModelVisibility(
	t *testing.T,
	client *http.Client,
	baseURL string,
	model string,
	visible bool,
) {
	t.Helper()

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		exchange := performRequest(
			t,
			client,
			http.MethodGet,
			baseURL+"/v1/models",
			testClientKey,
			nil,
		)
		found := strings.Contains(exchange.body, `"id":"`+model+`"`)
		if exchange.status == http.StatusOK && found == visible {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("等待模型 %q visible=%t 超时", model, visible)
}

// codexSyntheticStream 返回 Adapter 状态机接受的最小 Responses SSE。
func codexSyntheticStream(model string) string {
	return strings.Join([]string{
		"event: response.created",
		`data: {"type":"response.created","response":{"id":"resp_host","model":"` +
			model + `","status":"in_progress"}}`,
		"",
		"event: response.output_item.done",
		`data: {"type":"response.output_item.done","output_index":0,"item":{"id":"msg_host","type":"message","role":"assistant","status":"completed","content":[{"type":"output_text","text":"host-codex-ok"}]}}`,
		"",
		"event: response.completed",
		`data: {"type":"response.completed","response":{"id":"resp_host","model":"` +
			model + `","status":"completed","end_turn":true,"output":[],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}`,
		"",
		"",
	}, "\n")
}

// claudeSyntheticStream 返回 Adapter 状态机接受的最小 Messages SSE。
func claudeSyntheticStream(model string) string {
	return strings.Join([]string{
		"event: message_start",
		`data: {"type":"message_start","message":{"id":"msg_host","type":"message","role":"assistant","model":"` +
			model + `","content":[],"usage":{"input_tokens":2,"output_tokens":0}}}`,
		"",
		"event: content_block_start",
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		"",
		"event: content_block_delta",
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"host-claude-ok"}}`,
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

// claudeReasoningToolSyntheticStream 返回 thinking、文本和工具调用的完整流。
func claudeReasoningToolSyntheticStream(model string) string {
	return strings.Join([]string{
		"event: message_start",
		`data: {"type":"message_start","message":{"id":"msg_chat_claude","type":"message","role":"assistant","model":"` +
			model + `","content":[],"usage":{"input_tokens":11,"output_tokens":0}}}`,
		"",
		"event: content_block_start",
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}`,
		"",
		"event: content_block_delta",
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"先分析"}}`,
		"",
		"event: content_block_delta",
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"claude-signature-live"}}`,
		"",
		"event: content_block_stop",
		`data: {"type":"content_block_stop","index":0}`,
		"",
		"event: content_block_start",
		`data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`,
		"",
		"event: content_block_delta",
		`data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"准备调用工具"}}`,
		"",
		"event: content_block_stop",
		`data: {"type":"content_block_stop","index":1}`,
		"",
		"event: content_block_start",
		`data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_weather_new","name":"weather","input":{}}}`,
		"",
		"event: content_block_delta",
		`data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"city\":"}}`,
		"",
		"event: content_block_delta",
		`data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"\"上海\"}"}}`,
		"",
		"event: content_block_stop",
		`data: {"type":"content_block_stop","index":2}`,
		"",
		"event: message_delta",
		`data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":9}}`,
		"",
		"event: message_stop",
		`data: {"type":"message_stop"}`,
		"",
		"",
	}, "\n")
}

var _ aihserver.InferenceHTTPClient = (*syntheticInferenceHTTPClient)(nil)
