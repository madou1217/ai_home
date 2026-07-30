package aihserver_test

import (
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
	"github.com/madou1217/ai_home/internal/transport/http/openaichatcompletionsapi"
	"github.com/madou1217/ai_home/internal/transport/http/openairesponsesapi"
)

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

// TestServerSkipsClaudeOAuthForCanonicalMessages 验证同一模型的官方 OAuth
// 候选排序在前时，Canonical Messages 不触发错误直连，而是继续征召 API Key。
func TestServerSkipsClaudeOAuthForCanonicalMessages(t *testing.T) {
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
		upstream.CallCount() != 1 ||
		upstream.LastAuthHeader() != "x-api-key" {
		t.Fatalf(
			"response=%s calls=%d auth=%s",
			exchange.body,
			upstream.CallCount(),
			upstream.LastAuthHeader(),
		)
	}
	t.Logf(
		"POST %s\npayload:\n%s\nstatus: %d\nresponse:\n%s",
		baseURL+anthropicmessagesapi.Path,
		payload,
		exchange.status,
		exchange.body,
	)
}

// syntheticInferenceHTTPClient 根据真实 Adapter 的目标主机返回确定性 SSE。
type syntheticInferenceHTTPClient struct {
	mu             sync.Mutex
	calls          int
	lastAuthHeader string
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
	client.mu.Unlock()
	stream := codexSyntheticStream(payload.Model)
	if strings.Contains(request.URL.Host, "anthropic.com") {
		stream = claudeSyntheticStream(payload.Model)
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Header: http.Header{
			"Content-Type": []string{"text/event-stream"},
		},
		Body: io.NopCloser(strings.NewReader(stream)),
	}, nil
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
			"sk-ant-oat01-canonical-skip",
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

var _ aihserver.InferenceHTTPClient = (*syntheticInferenceHTTPClient)(nil)
