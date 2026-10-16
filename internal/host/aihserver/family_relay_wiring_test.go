package aihserver_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/host/aihserver"
	"github.com/madou1217/ai_home/internal/testsupport/accountmodels"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
	"github.com/madou1217/ai_home/internal/transport/http/openaichatcompletionsapi"
)

// 家族透传接线的验收：能承载的家族请求（钉选 + 家族账号）由 Go 直连家族官方端点，
// 其余请求必须原样交回 Canonical，不能因为入口换成了透传通道而丢失能力。

const (
	familyRelayWorkbuddyIssuer = "https://www.workbuddy.ai/auth/realms/copilot"
	familyRelayAccessToken     = "family-relay-access-token"
)

// startFamilyRelayTestServer 与 startTestServerWithInferenceClient 同构，
// 但把 RelayHTTPClient 指向独立替身，从而能区分「透传触网」与「Canonical 触网」。
func startFamilyRelayTestServer(
	t *testing.T,
	canonical aihserver.InferenceHTTPClient,
	relay aihserver.InferenceHTTPClient,
) (string, *http.Client) {
	t.Helper()

	server, err := aihserver.New(context.Background(), aihserver.Options{
		AIHomeDir:           t.TempDir(),
		ManagementKey:       func() string { return testManagementKey },
		ClientKey:           func() string { return testClientKey },
		ModelDiscoverers:    accountmodels.NewDiscoverers(),
		InferenceHTTPClient: canonical,
		UsageHTTPClient:     syntheticUsageHTTPClient{},
		RelayHTTPClient:     relay,
	})
	if err != nil {
		t.Fatalf("aihserver.New() error = %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = server.Close()
		t.Fatalf("net.Listen() error = %v", err)
	}
	serveErrors := make(chan error, 1)
	go func() {
		serveErrors <- server.Serve(listener)
	}()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			t.Errorf("Server.Shutdown() error = %v", err)
		}
		if err := <-serveErrors; err != nil {
			t.Errorf("Server.Serve() error = %v", err)
		}
		if err := server.Close(); err != nil {
			t.Errorf("Server.Close() error = %v", err)
		}
	})
	return "http://" + listener.Addr().String(), &http.Client{
		Timeout: 3 * time.Second,
	}
}

// familyRelayUpstream 记录家族透传真正发出的上游请求，并回复合法 SSE。
type familyRelayUpstream struct {
	mu       sync.Mutex
	requests []recordedFamilyRequest
}

// recordedFamilyRequest 是一次上游请求的取证快照。
type recordedFamilyRequest struct {
	URL           string
	Authorization string
	UserAgent     string
	Accept        string
	Body          []byte
}

func (upstream *familyRelayUpstream) Do(
	request *http.Request,
) (*http.Response, error) {
	body, err := io.ReadAll(request.Body)
	if err != nil {
		return nil, err
	}
	upstream.mu.Lock()
	upstream.requests = append(upstream.requests, recordedFamilyRequest{
		URL:           request.URL.String(),
		Authorization: request.Header.Get("Authorization"),
		UserAgent:     request.Header.Get("User-Agent"),
		Accept:        request.Header.Get("Accept"),
		Body:          append([]byte(nil), body...),
	})
	upstream.mu.Unlock()
	stream := "" +
		"data: {\"id\":\"chatcmpl-family\",\"object\":\"chat.completion.chunk\"," +
		"\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\"," +
		"\"content\":\"family-relay-ok\"}}]}\n\n" +
		"data: {\"id\":\"chatcmpl-family\",\"object\":\"chat.completion.chunk\"," +
		"\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" +
		"data: [DONE]\n\n"
	return &http.Response{
		StatusCode: http.StatusOK,
		Header: http.Header{
			"Content-Type": []string{"text/event-stream"},
		},
		Body: io.NopCloser(strings.NewReader(stream)),
	}, nil
}

func (upstream *familyRelayUpstream) callCount() int {
	upstream.mu.Lock()
	defer upstream.mu.Unlock()
	return len(upstream.requests)
}

func (upstream *familyRelayUpstream) lastRequest() recordedFamilyRequest {
	upstream.mu.Lock()
	defer upstream.mu.Unlock()
	if len(upstream.requests) == 0 {
		return recordedFamilyRequest{}
	}
	return upstream.requests[len(upstream.requests)-1]
}

// familyRelayJWT 铸造与 nativeaccount 测试同构的未签名 JWT（只做 claims 解码）。
func familyRelayJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	body, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	return "e30." + base64.RawURLEncoding.EncodeToString(body) + ".signature"
}

// familyNativeImportBody 创建家族 Provider 的 native_auth_json artifact。
func familyNativeImportBody(
	t *testing.T,
	providerID string,
	issuer string,
	uid string,
) []byte {
	t.Helper()

	domain := strings.TrimPrefix(issuer, "https://")
	if index := strings.IndexByte(domain, '/'); index >= 0 {
		domain = domain[:index]
	}
	token := func() string {
		return familyRelayJWT(t, map[string]any{"iss": issuer, "sub": uid})
	}
	document, err := json.Marshal(map[string]any{
		"provider_id": providerID,
		"artifacts": map[string]any{
			"native_auth_json": map[string]any{
				"credentials": map[string]any{
					"account": map[string]any{"uid": uid},
					"auth": map[string]any{
						"domain":       domain,
						"accessToken":  token(),
						"refreshToken": token(),
					},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	return document
}

// registerNativeFamilyAccount 通过原生导入 API 创建家族账号，返回 accountRef。
func registerNativeFamilyAccount(
	t *testing.T,
	client *http.Client,
	baseURL string,
	providerID string,
	issuer string,
	uid string,
) string {
	t.Helper()

	exchange := performRequest(
		t,
		client,
		http.MethodPost,
		baseURL+accountsapi.NativeImportPath,
		testManagementKey,
		familyNativeImportBody(t, providerID, issuer, uid),
	)
	assertStatus(t, exchange, http.StatusCreated)
	var document struct {
		Data struct {
			AccountRef string `json:"account_ref"`
		} `json:"data"`
	}
	decodeJSON(t, exchange.body, &document)
	if document.Data.AccountRef == "" {
		t.Fatalf("家族原生导入缺少 account_ref: %s", exchange.body)
	}
	return document.Data.AccountRef
}

// TestServerRelaysPinnedFamilyChatCompletionsThroughFamilyRelay 验证钉选家族账号的
// chat completions 由 Go 家族透传承载：上游是家族官方端点、带原生 access token 与
// 真实客户端 UA，客户端拿到聚合后的非流式响应与服务归属头。
func TestServerRelaysPinnedFamilyChatCompletionsThroughFamilyRelay(
	t *testing.T,
) {
	t.Parallel()

	canonical := &syntheticInferenceHTTPClient{}
	familyUpstream := &familyRelayUpstream{}
	baseURL, client := startFamilyRelayTestServer(t, canonical, familyUpstream)
	familyRef := registerNativeFamilyAccount(
		t,
		client,
		baseURL,
		"workbuddy",
		familyRelayWorkbuddyIssuer,
		"family-host-1",
	)
	exchange := performRequestWithHeaders(
		t,
		client,
		http.MethodPost,
		baseURL+openaichatcompletionsapi.Path,
		map[string]string{
			"Authorization":               "Bearer " + testClientKey,
			inferenceapi.AccountRefHeader: familyRef,
		},
		[]byte(`{"model":"hy4-preview","messages":[{"role":"user","content":"family-smoke"}]}`),
	)
	assertStatus(t, exchange, http.StatusOK)
	if !strings.Contains(exchange.body, "family-relay-ok") ||
		!strings.Contains(exchange.body, `"object":"chat.completion"`) {
		t.Fatalf("透传响应正文错误: %s", exchange.body)
	}
	if got := exchange.header.Get(inferenceapi.ServedAccountRefHeader); got != familyRef {
		t.Fatalf("服务归属账号头 = %q want %q", got, familyRef)
	}
	if got := exchange.header.Get(inferenceapi.ServedProviderHeader); got != "workbuddy" {
		t.Fatalf("服务归属 Provider 头 = %q want workbuddy", got)
	}
	if canonical.CallCount() != 0 {
		t.Fatalf("家族请求不应落入 Canonical: calls=%d", canonical.CallCount())
	}
	if familyUpstream.callCount() != 1 {
		t.Fatalf("家族上游调用次数 = %d want 1", familyUpstream.callCount())
	}
	recording := familyUpstream.lastRequest()
	if recording.URL != "https://www.workbuddy.ai/v2/chat/completions" {
		t.Fatalf("家族上游 URL = %q", recording.URL)
	}
	if !strings.HasPrefix(recording.Authorization, "Bearer e30.") {
		t.Fatalf("家族上游 Authorization = %q", recording.Authorization)
	}
	if recording.UserAgent != "CLI/2.63.2 CodeBuddy/2.63.2" {
		t.Fatalf("家族上游 User-Agent = %q", recording.UserAgent)
	}
	if recording.Accept != "text/event-stream" {
		t.Fatalf("家族上游 Accept = %q", recording.Accept)
	}
	if !strings.Contains(string(recording.Body), `"model":"hy4-preview"`) ||
		!strings.Contains(string(recording.Body), "family-smoke") {
		t.Fatalf("家族上游请求正文错误: %s", recording.Body)
	}
}

// TestServerDelegatesNonFamilyChatCompletionsToCanonical 验证入口换成家族透传后，
// 非家族请求（未钉选 / 钉选到非家族账号）仍然原样回到 Canonical 承载。
func TestServerDelegatesNonFamilyChatCompletionsToCanonical(
	t *testing.T,
) {
	t.Parallel()

	canonical := &syntheticInferenceHTTPClient{}
	familyUpstream := &familyRelayUpstream{}
	baseURL, client := startFamilyRelayTestServer(t, canonical, familyUpstream)
	claudeRef := registerNativeClaudeOAuthAccount(t, client, baseURL)
	waitForServerModels(t, client, baseURL, []string{"claude-sonnet-4"})

	unpinned := performRequest(
		t,
		client,
		http.MethodPost,
		baseURL+openaichatcompletionsapi.Path,
		testClientKey,
		[]byte(`{"model":"claude-sonnet-4","messages":[{"role":"user","content":"host-smoke"}]}`),
	)
	assertStatus(t, unpinned, http.StatusOK)
	if !strings.Contains(unpinned.body, "host-claude-ok") {
		t.Fatalf("未钉选请求未由 Canonical 承载: %s", unpinned.body)
	}
	pinned := performRequestWithHeaders(
		t,
		client,
		http.MethodPost,
		baseURL+openaichatcompletionsapi.Path,
		map[string]string{
			"Authorization":               "Bearer " + testClientKey,
			inferenceapi.AccountRefHeader: claudeRef,
		},
		[]byte(`{"model":"claude-sonnet-4","messages":[{"role":"user","content":"host-smoke"}]}`),
	)
	assertStatus(t, pinned, http.StatusOK)
	if !strings.Contains(pinned.body, "host-claude-ok") {
		t.Fatalf("钉选非家族请求未由 Canonical 承载: %s", pinned.body)
	}
	if got := pinned.header.Get(inferenceapi.ServedAccountRefHeader); got != claudeRef {
		t.Fatalf("Canonical 服务归属账号头 = %q want %q", got, claudeRef)
	}
	if familyUpstream.callCount() != 0 {
		t.Fatalf("非家族请求不应触达家族上游: calls=%d", familyUpstream.callCount())
	}
}
