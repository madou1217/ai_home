package aihserver_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/codex/authfile"
	"github.com/madou1217/ai_home/internal/host/aihserver"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
	"github.com/madou1217/ai_home/internal/transport/http/modelsapi"
	"github.com/madou1217/ai_home/internal/transport/http/openairesponsesapi"
)

const (
	realCodexAuthFileEnvironment = "AIH_REAL_CODEX_AUTH_FILE"
	realCodexModel               = "gpt-5.6-sol"
	realCodexMarker              = "AIH_REAL_ROUTE_OK"
	realCodexInstructions        = "Return only the exact marker requested by the user."
	realCodexMaxAuthFileBytes    = 1024 * 1024
	realCodexUpstreamTimeout     = 2 * time.Minute
)

var errUnexpectedRealCodexRequest = errors.New("真实 Codex 请求超出验收白名单或预算")

// realCodexRoundTripperFunc 让安全预算测试使用不会触达网络的内联传输。
type realCodexRoundTripperFunc func(*http.Request) (*http.Response, error)

// RoundTrip 实现标准库 HTTP 传输端口。
func (function realCodexRoundTripperFunc) RoundTrip(
	request *http.Request,
) (*http.Response, error) {
	return function(request)
}

// realCodexRequestCounts 是不会携带 URL、凭据或正文的真实请求计数快照。
type realCodexRequestCounts struct {
	models     int
	responses  int
	unexpected int
}

// realCodexRequestBudget 在发出网络请求前同时执行目标白名单和次数预算。
//
// 该边界只允许一个官方模型目录请求和两个官方 Responses 请求。即使上层发生
// 意外重试，第三次请求也只会在本地失败，不会继续触达真实上游。
type realCodexRequestBudget struct {
	client *http.Client
	// maxResponses 是当前真实场景明确批准的推理次数；零沿用两次缺省预算。
	maxResponses int
	mu           sync.Mutex
	counts       realCodexRequestCounts
}

// Do 校验请求目标、协议头和固定测试正文后，原样委托给标准库客户端。
func (budget *realCodexRequestBudget) Do(
	request *http.Request,
) (*http.Response, error) {
	if budget == nil || budget.client == nil || request == nil {
		return nil, errUnexpectedRealCodexRequest
	}
	if err := budget.reserve(request); err != nil {
		return nil, err
	}
	return budget.client.Do(request)
}

// reserve 原子预留一次真实请求；任何异常都只增加本地拒绝计数。
func (budget *realCodexRequestBudget) reserve(request *http.Request) error {
	budget.mu.Lock()
	defer budget.mu.Unlock()

	validAuthentication := strings.HasPrefix(
		request.Header.Get("Authorization"),
		"Bearer ",
	) && request.Header.Get("Authorization") != "Bearer "
	validIdentity := request.Header.Get("Originator") == "codex_cli_rs" &&
		request.Header.Get("Version") == "0.146.0"
	if request.URL == nil ||
		request.URL.Scheme != "https" ||
		request.URL.Host != "chatgpt.com" ||
		!validAuthentication ||
		!validIdentity {
		budget.counts.unexpected++
		return errUnexpectedRealCodexRequest
	}

	switch {
	case request.Method == http.MethodGet &&
		request.URL.Path == "/backend-api/codex/models" &&
		request.URL.Query().Get("client_version") == "0.146.0" &&
		len(request.URL.Query()) == 1 &&
		request.Header.Get("Accept") == "application/json" &&
		budget.counts.models == 0:
		budget.counts.models++
		return nil
	case request.Method == http.MethodPost &&
		request.URL.Path == "/backend-api/codex/responses" &&
		request.URL.RawQuery == "" &&
		request.Header.Get("Content-Type") == "application/json" &&
		request.Header.Get("Accept") == "text/event-stream" &&
		budget.counts.responses < budget.responseLimit():
		if err := validateRealCodexUpstreamBody(request); err != nil {
			budget.counts.unexpected++
			return err
		}
		budget.counts.responses++
		return nil
	default:
		budget.counts.unexpected++
		return errUnexpectedRealCodexRequest
	}
}

// responseLimit 返回场景预算；默认值保持原有 Responses 验收的两次请求。
func (budget *realCodexRequestBudget) responseLimit() int {
	if budget.maxResponses > 0 {
		return budget.maxResponses
	}
	return 2
}

// snapshot 返回与并发后台任务隔离的计数副本。
func (budget *realCodexRequestBudget) snapshot() realCodexRequestCounts {
	budget.mu.Lock()
	defer budget.mu.Unlock()
	return budget.counts
}

// validateRealCodexUpstreamBody 保证两次真实推理都使用已确认的模型、标记和
// Provider 原生 stream=true，同时不私自添加 max_output_tokens。
func validateRealCodexUpstreamBody(request *http.Request) error {
	if request.Body == nil {
		return errUnexpectedRealCodexRequest
	}
	payload, err := io.ReadAll(io.LimitReader(
		request.Body,
		realCodexMaxAuthFileBytes+1,
	))
	_ = request.Body.Close()
	if err != nil || len(payload) > realCodexMaxAuthFileBytes {
		clear(payload)
		return errUnexpectedRealCodexRequest
	}
	// 恢复正文必须使用独立副本；下方清理观察缓冲区时不能影响真正发送的数据。
	request.Body = io.NopCloser(bytes.NewReader(append([]byte(nil), payload...)))
	defer clear(payload)

	var document map[string]json.RawMessage
	if json.Unmarshal(payload, &document) != nil ||
		string(document["model"]) != `"`+realCodexModel+`"` ||
		string(document["stream"]) != "true" ||
		!bytes.Contains(payload, []byte(realCodexMarker)) {
		return errUnexpectedRealCodexRequest
	}
	if _, found := document["max_output_tokens"]; found {
		return errUnexpectedRealCodexRequest
	}
	return nil
}

// realResponsesDocument 是验收需要的最小 Responses 公开投影。
type realResponsesDocument struct {
	ID          string            `json:"id"`
	Object      string            `json:"object"`
	CreatedAt   int64             `json:"created_at"`
	CompletedAt *int64            `json:"completed_at"`
	Status      string            `json:"status"`
	Model       string            `json:"model"`
	Output      []json.RawMessage `json:"output"`
	Usage       *realUsage        `json:"usage"`
	// Instructions 和 Metadata 必须保留当前客户端请求的协议私有投影。
	Instructions json.RawMessage `json:"instructions"`
	Metadata     json.RawMessage `json:"metadata"`
	// 下列字段即使使用缺省值也必须出现在 Responses 对象中。
	ParallelToolCalls json.RawMessage `json:"parallel_tool_calls"`
	Temperature       json.RawMessage `json:"temperature"`
	ToolChoice        json.RawMessage `json:"tool_choice"`
	TopP              json.RawMessage `json:"top_p"`
}

// realUsage 保存真实响应必须返回的累计 Token 统计。
type realUsage struct {
	InputTokens  uint64 `json:"input_tokens"`
	OutputTokens uint64 `json:"output_tokens"`
	TotalTokens  uint64 `json:"total_tokens"`
}

// realSSEFrame 是本地 Responses SSE 的事件名和 JSON 数据。
type realSSEFrame struct {
	event string
	data  []byte
}

// TestRealCodexRequestBudgetBlocksExtraNetworkCalls 验证次数超限时失败发生在
// 委托标准库传输之前，避免真实验收因上层重试产生额外费用。
func TestRealCodexRequestBudgetBlocksExtraNetworkCalls(t *testing.T) {
	transportCalls := 0
	budget := &realCodexRequestBudget{client: &http.Client{
		Transport: realCodexRoundTripperFunc(func(
			_ *http.Request,
		) (*http.Response, error) {
			transportCalls++
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader("{}")),
			}, nil
		}),
	}}

	for attempt := 0; attempt < 3; attempt++ {
		request := newBudgetTestResponsesRequest(t)
		response, err := budget.Do(request)
		if attempt < 2 {
			if err != nil || response == nil {
				t.Fatalf("预算内请求 %d 被拒绝: %v", attempt+1, err)
			}
			_ = response.Body.Close()
			continue
		}
		if !errors.Is(err, errUnexpectedRealCodexRequest) || response != nil {
			t.Fatalf("第三次真实请求没有在本地被拒绝: response=%v err=%v", response, err)
		}
	}

	want := realCodexRequestCounts{responses: 2, unexpected: 1}
	if got := budget.snapshot(); got != want || transportCalls != 2 {
		t.Fatalf("真实请求预算失效: counts=%+v transport_calls=%d", got, transportCalls)
	}
}

// TestRealCodexRequestBudgetAllowsConfiguredResponseCount 验证不同真实验收场景
// 可以显式收紧或放宽固定次数，同时第一个超额请求仍在本地失败。
func TestRealCodexRequestBudgetAllowsConfiguredResponseCount(t *testing.T) {
	transportCalls := 0
	budget := &realCodexRequestBudget{
		maxResponses: 4,
		client: &http.Client{Transport: realCodexRoundTripperFunc(func(
			_ *http.Request,
		) (*http.Response, error) {
			transportCalls++
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader("{}")),
			}, nil
		})},
	}

	for attempt := 0; attempt < 5; attempt++ {
		response, err := budget.Do(newBudgetTestResponsesRequest(t))
		if attempt < 4 {
			if err != nil || response == nil {
				t.Fatalf("预算内请求 %d 被拒绝: %v", attempt+1, err)
			}
			_ = response.Body.Close()
			continue
		}
		if !errors.Is(err, errUnexpectedRealCodexRequest) || response != nil {
			t.Fatalf("第五次真实请求没有在本地被拒绝: response=%v err=%v", response, err)
		}
	}

	want := realCodexRequestCounts{responses: 4, unexpected: 1}
	if got := budget.snapshot(); got != want || transportCalls != 4 {
		t.Fatalf("可配置真实请求预算失效: counts=%+v transport_calls=%d", got, transportCalls)
	}
}

// TestRealCodexRequestBudgetPreservesRequestBody 验证安全检查不会修改随后真正发送的
// JSON；白名单只能观察请求，不能把测试本身变成上游格式错误的来源。
func TestRealCodexRequestBudgetPreservesRequestBody(t *testing.T) {
	wantBody := `{"model":"gpt-5.6-sol","input":"AIH_REAL_ROUTE_OK","stream":true}`
	var transportedBody string
	budget := &realCodexRequestBudget{client: &http.Client{
		Transport: realCodexRoundTripperFunc(func(
			request *http.Request,
		) (*http.Response, error) {
			payload, err := io.ReadAll(request.Body)
			if err != nil {
				return nil, err
			}
			transportedBody = string(payload)
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     make(http.Header),
				Body:       io.NopCloser(strings.NewReader("{}")),
			}, nil
		}),
	}}

	response, err := budget.Do(newBudgetTestResponsesRequest(t))
	if err != nil || response == nil {
		t.Fatalf("预算内请求被拒绝: %v", err)
	}
	_ = response.Body.Close()
	if transportedBody != wantBody {
		t.Fatalf("安全检查修改了真实请求正文: got=%q want=%q", transportedBody, wantBody)
	}
}

// TestRealCodexAuthFileDecodesOffline 用操作者显式提供的真实文件验证官方格式，
// 但不启动 Server、不创建数据库，也不产生任何网络请求。
func TestRealCodexAuthFileDecodesOffline(t *testing.T) {
	authJSON := readRealCodexAuthFromEnvironment(t)
	defer clear(authJSON)
	expiresAt := assertRealCodexAuthReady(t, authJSON)
	t.Logf(
		"auth=oauth expires_at=%s refresh_due=false network_requests=0",
		expiresAt.Format(time.RFC3339),
	)
}

// TestRealCodexResponsesEndToEnd 通过真实 TCP Server、临时 aih.db 和真实 Codex
// OAuth 凭据验收账号导入、模型正排/倒排、路由、Adapter 与两种客户端渲染。
//
// 默认跳过；只有操作者显式设置 AIH_REAL_CODEX_AUTH_FILE 后才会产生三个受预算
// 约束的真实上游请求。测试不会修改正式 AIH_HOME，也不会输出凭据或账号身份。
func TestRealCodexResponsesEndToEnd(t *testing.T) {
	authJSON := readRealCodexAuthFromEnvironment(t)
	defer clear(authJSON)
	authExpiresAt := assertRealCodexAuthReady(t, authJSON)

	upstream := newRealCodexUpstreamBudget(2)
	fixture := startRealCodexFixture(t, authJSON, upstream)
	baseURL, client := fixture.baseURL, fixture.client

	basePayload := map[string]any{
		"model":        realCodexModel,
		"instructions": realCodexInstructions,
		"input":        "Reply with exactly: " + realCodexMarker,
		"metadata": map[string]string{
			"test_scope": "aih-real-codex-e2e",
		},
	}
	nonStreamPayload := marshalRealCodexPayload(t, basePayload, false)
	nonStream := performRequest(
		t,
		client,
		http.MethodPost,
		baseURL+openairesponsesapi.Path,
		testClientKey,
		nonStreamPayload,
	)
	assertStatus(t, nonStream, http.StatusOK)
	nonStreamDocument := decodeRealResponsesDocument(t, []byte(nonStream.body))
	assertCompletedRealCodexResponse(t, nonStreamDocument)
	clear(nonStreamPayload)

	streamPayload := marshalRealCodexPayload(t, basePayload, true)
	stream := performRequest(
		t,
		client,
		http.MethodPost,
		baseURL+openairesponsesapi.Path,
		testClientKey,
		streamPayload,
	)
	assertRealCodexStreamStatus(t, stream)
	frames := decodeRealResponsesSSE(t, stream.body)
	terminal := assertRealCodexStream(t, frames)
	clear(streamPayload)

	wantCounts := realCodexRequestCounts{models: 1, responses: 2}
	if counts := upstream.snapshot(); counts != wantCounts {
		t.Fatalf("真实请求预算错误: got=%+v want=%+v", counts, wantCounts)
	}
	databasePath := fixture.databasePath()
	if info, statErr := os.Stat(databasePath); statErr != nil || info.IsDir() {
		t.Fatalf("临时 aih.db 未创建: %v", statErr)
	}

	t.Logf(
		strings.Join([]string{
			"真实 Codex Go Server 验收通过",
			"api_base: %s",
			"authorization: Bearer <local-test-key-redacted>",
			"import: POST %s payload={\"provider_id\":\"codex\",\"artifacts\":{\"auth_json\":\"<redacted>\"}} status=%d auth_kind=%s auth_mode=<none>",
			"models: GET %s status=%d count=%d contains_%s=true",
			"non_stream: POST %s payload=%s status=%d response=%s",
			"stream: POST %s payload=%s status=%d events=%s terminal=%s",
			"upstream_requests: models=1 responses=2 unexpected=0",
			"oauth_access_expires_at: %s refresh_due=false",
			"temporary_database: created=true cleanup=registered",
		}, "\n"),
		baseURL,
		baseURL+accountsapi.NativeImportPath,
		fixture.importStatus,
		fixture.authKind,
		baseURL+modelsapi.Path,
		fixture.modelsStatus,
		fixture.modelCount,
		realCodexModel,
		baseURL+openairesponsesapi.Path,
		string(marshalRealCodexPayload(t, basePayload, false)),
		nonStream.status,
		nonStream.body,
		baseURL+openairesponsesapi.Path,
		string(marshalRealCodexPayload(t, basePayload, true)),
		stream.status,
		strings.Join(realSSEEventNames(frames), " -> "),
		string(terminal),
		authExpiresAt.Format(time.RFC3339),
	)
}

// assertRealCodexStreamStatus 校验 SSE 成功响应及流式专用响应头。
// SSE 必须允许客户端重新验证并禁用代理缓冲，因此不能复用 JSON 的 no-store 断言。
func assertRealCodexStreamStatus(t *testing.T, exchange httpExchange) {
	t.Helper()

	if exchange.status != http.StatusOK {
		t.Fatalf(
			"status=%d want=%d body=%s",
			exchange.status,
			http.StatusOK,
			exchange.body,
		)
	}
	if got := exchange.header.Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := exchange.header.Get("Content-Type"); !strings.HasPrefix(got, "text/event-stream") {
		t.Fatalf("Content-Type = %q", got)
	}
	if got := exchange.header.Get("X-Accel-Buffering"); got != "no" {
		t.Fatalf("X-Accel-Buffering = %q", got)
	}
	if got := exchange.header.Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
}

// readRealCodexAuthFromEnvironment 只接受显式环境变量，不猜测用户凭据路径。
func readRealCodexAuthFromEnvironment(t *testing.T) []byte {
	t.Helper()
	authFile := strings.TrimSpace(os.Getenv(realCodexAuthFileEnvironment))
	if authFile == "" {
		t.Skip(realCodexAuthFileEnvironment + " 未设置，跳过真实 Codex OAuth 验收")
	}
	return readProtectedRealCodexAuth(t, authFile)
}

// newBudgetTestResponsesRequest 构造完全不会触达网络的预算测试请求。
func newBudgetTestResponsesRequest(t *testing.T) *http.Request {
	t.Helper()
	request, err := http.NewRequest(
		http.MethodPost,
		"https://chatgpt.com/backend-api/codex/responses",
		strings.NewReader(
			`{"model":"gpt-5.6-sol","input":"AIH_REAL_ROUTE_OK","stream":true}`,
		),
	)
	if err != nil {
		t.Fatalf("创建真实请求预算夹具失败: %v", err)
	}
	request.Header.Set("Authorization", "Bearer synthetic-real-test-token")
	request.Header.Set("Originator", "codex_cli_rs")
	request.Header.Set("Version", "0.146.0")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	return request
}

// readProtectedRealCodexAuth 只读取显式文件，拒绝宽权限、目录和超大凭据文件。
func readProtectedRealCodexAuth(t *testing.T, path string) []byte {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("读取真实 Codex auth.json 元数据失败: %v", err)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		t.Fatalf("真实 Codex auth.json 必须是权限 0600 的普通文件")
	}
	if info.Size() < 2 || info.Size() > realCodexMaxAuthFileBytes {
		t.Fatalf("真实 Codex auth.json 大小超出安全边界")
	}
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读取真实 Codex auth.json 失败: %v", err)
	}
	if !json.Valid(payload) {
		clear(payload)
		t.Fatal("真实 Codex auth.json 不是合法 JSON")
	}
	return payload
}

// assertRealCodexAuthReady 使用正式 auth.json Decoder 确认凭据是 OAuth，且在整个
// 验收窗口内不会触发不受真实请求预算控制的 Token Refresh。
func assertRealCodexAuthReady(t *testing.T, payload []byte) time.Time {
	t.Helper()
	credential, err := authfile.Decode(payload, authfile.DecodeOptions{})
	if err != nil {
		t.Fatalf("真实 Codex auth.json 无法由正式 Decoder 解析: %v", err)
	}
	auth, valid := credential.(*codexauth.OAuthAuth)
	if !valid || auth == nil || auth.AccessExpiresAtMS() <= 0 {
		t.Fatal("真实 Codex auth.json 不包含可验收的 OAuth Access Token 到期时间")
	}
	expiresAt := time.UnixMilli(auth.AccessExpiresAtMS()).UTC()
	if expiresAt.Sub(time.Now()) <= accountcredentials.DefaultRefreshSkew {
		t.Fatalf(
			"真实 Codex OAuth 已进入提前刷新窗口: expires_at=%s",
			expiresAt.Format(time.RFC3339),
		)
	}
	return expiresAt
}

// newDisposableRealCodexHome 创建与正式数据隔离、并在 Server 关闭后删除的目录。
func newDisposableRealCodexHome(t *testing.T) string {
	t.Helper()
	directory, err := os.MkdirTemp("", "aih-real-codex-e2e-")
	if err != nil {
		t.Fatalf("创建临时 AIH_HOME 失败: %v", err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(directory); err != nil {
			t.Errorf("删除临时 AIH_HOME 失败: %v", err)
			return
		}
		if _, err := os.Stat(directory); !os.IsNotExist(err) {
			t.Errorf("临时 AIH_HOME 清理后仍存在: %v", err)
			return
		}
		t.Log("temporary_aih_home_removed=true")
	})
	return directory
}

// startRealCodexServer 只装配当前验收需要的真实目录与推理客户端。
func startRealCodexServer(
	t *testing.T,
	aiHomeDir string,
	upstream aihserver.InferenceHTTPClient,
	discoverers []accountapp.ProviderModelDiscoverer,
) (string, *http.Client) {
	t.Helper()
	server, err := aihserver.New(context.Background(), aihserver.Options{
		AIHomeDir:           aiHomeDir,
		ManagementKey:       func() string { return testManagementKey },
		ClientKey:           func() string { return testClientKey },
		ModelDiscoverers:    discoverers,
		InferenceHTTPClient: upstream,
		UsageHTTPClient:     syntheticUsageHTTPClient{},
		RelayHTTPClient:     nil,
	})
	if err != nil {
		t.Fatalf("创建真实 Codex 测试 Server 失败: %v", err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		_ = server.Close()
		t.Fatalf("监听临时 Server 端口失败: %v", err)
	}
	serveErrors := make(chan error, 1)
	go func() {
		serveErrors <- server.Serve(listener)
	}()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := server.Shutdown(ctx); err != nil {
			t.Errorf("关闭真实 Codex 测试 Server 失败: %v", err)
		}
		if err := <-serveErrors; err != nil {
			t.Errorf("真实 Codex 测试 Server 退出失败: %v", err)
		}
		if err := server.Close(); err != nil {
			t.Errorf("释放真实 Codex 测试 Server 资源失败: %v", err)
		}
		t.Log("temporary_server_closed=true")
	})
	return "http://" + listener.Addr().String(), &http.Client{
		Timeout: realCodexUpstreamTimeout,
	}
}

// assertRealCodexModelAvailable 校验本地快照来自导入时维护的真实远端目录。
func assertRealCodexModelAvailable(t *testing.T, body string) int {
	t.Helper()
	var document struct {
		Object string `json:"object"`
		Data   []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	decodeJSON(t, body, &document)
	if document.Object != "list" || len(document.Data) == 0 {
		t.Fatalf("真实本地模型目录无效: object=%q count=%d", document.Object, len(document.Data))
	}
	for _, model := range document.Data {
		if model.ID == realCodexModel {
			return len(document.Data)
		}
	}
	countsMessage := fmt.Sprintf("真实账号目录不包含 %s", realCodexModel)
	t.Fatal(countsMessage)
	return 0
}

// marshalRealCodexPayload 创建操作者已经确认、且没有输出上限的固定请求。
func marshalRealCodexPayload(
	t *testing.T,
	base map[string]any,
	stream bool,
) []byte {
	t.Helper()
	payload := make(map[string]any, len(base)+1)
	for key, value := range base {
		payload[key] = value
	}
	payload["stream"] = stream
	data, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("编码真实 Codex 请求失败: %v", err)
	}
	return data
}

// decodeRealResponsesDocument 解码一个完整 Responses 对象。
func decodeRealResponsesDocument(t *testing.T, payload []byte) realResponsesDocument {
	t.Helper()
	var document realResponsesDocument
	if err := json.Unmarshal(payload, &document); err != nil {
		t.Fatalf("真实 Responses JSON 无效: %v", err)
	}
	return document
}

// assertCompletedRealCodexResponse 校验模型、文本、生命周期与 usage。
func assertCompletedRealCodexResponse(
	t *testing.T,
	document realResponsesDocument,
) {
	t.Helper()
	if document.ID == "" ||
		document.Object != "response" ||
		document.Status != "completed" ||
		document.Model != realCodexModel ||
		document.CreatedAt <= 0 ||
		document.CompletedAt == nil ||
		*document.CompletedAt < document.CreatedAt {
		t.Fatalf(
			"真实 Responses 生命周期无效: id=%t object=%q status=%q model=%q created=%d completed=%v",
			document.ID != "",
			document.Object,
			document.Status,
			document.Model,
			document.CreatedAt,
			document.CompletedAt,
		)
	}
	if text := realResponsesOutputText(t, document.Output); text != realCodexMarker {
		t.Fatalf("真实 Responses 文本错误: %q", text)
	}
	if document.Usage == nil ||
		document.Usage.InputTokens == 0 ||
		document.Usage.OutputTokens == 0 ||
		document.Usage.TotalTokens !=
			document.Usage.InputTokens+document.Usage.OutputTokens {
		t.Fatalf("真实 Responses usage 无效: %+v", document.Usage)
	}
	assertRealResponsesProjection(t, document)
}

// assertRealResponsesProjection 校验真实非流式和 SSE 终态共享的 Responses 字段合同。
func assertRealResponsesProjection(t *testing.T, document realResponsesDocument) {
	t.Helper()

	want := map[string]struct {
		actual json.RawMessage
		value  string
	}{
		"instructions": {
			actual: document.Instructions,
			value:  `"` + realCodexInstructions + `"`,
		},
		"metadata": {
			actual: document.Metadata,
			value:  `{"test_scope":"aih-real-codex-e2e"}`,
		},
		"parallel_tool_calls": {
			actual: document.ParallelToolCalls,
			value:  `true`,
		},
		"temperature": {
			actual: document.Temperature,
			value:  `null`,
		},
		"tool_choice": {
			actual: document.ToolChoice,
			value:  `"auto"`,
		},
		"top_p": {
			actual: document.TopP,
			value:  `null`,
		},
	}
	for field, expected := range want {
		if !bytes.Equal(expected.actual, []byte(expected.value)) {
			t.Fatalf(
				"真实 Responses %s=%s want=%s",
				field,
				expected.actual,
				expected.value,
			)
		}
	}
}

// realResponsesOutputText 只拼接 assistant message 的 output_text。
func realResponsesOutputText(t *testing.T, output []json.RawMessage) string {
	t.Helper()
	var result strings.Builder
	for _, rawItem := range output {
		var item struct {
			Type    string `json:"type"`
			Role    string `json:"role"`
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		}
		if err := json.Unmarshal(rawItem, &item); err != nil {
			t.Fatalf("真实 Responses output item 无效: %v", err)
		}
		if item.Type != "message" || item.Role != "assistant" {
			continue
		}
		for _, content := range item.Content {
			if content.Type == "output_text" {
				result.WriteString(content.Text)
			}
		}
	}
	return result.String()
}

// decodeRealResponsesSSE 解析本地 Renderer 输出的标准 event/data 帧。
func decodeRealResponsesSSE(t *testing.T, body string) []realSSEFrame {
	t.Helper()
	normalized := strings.ReplaceAll(body, "\r\n", "\n")
	blocks := strings.Split(normalized, "\n\n")
	frames := make([]realSSEFrame, 0, len(blocks))
	for _, block := range blocks {
		if strings.TrimSpace(block) == "" {
			continue
		}
		var frame realSSEFrame
		var data []string
		for _, line := range strings.Split(block, "\n") {
			switch {
			case strings.HasPrefix(line, "event: "):
				frame.event = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				data = append(data, strings.TrimPrefix(line, "data: "))
			}
		}
		frame.data = []byte(strings.Join(data, "\n"))
		if frame.event == "" || !json.Valid(frame.data) {
			t.Fatalf("真实 Responses SSE 帧无效: event=%q", frame.event)
		}
		frames = append(frames, frame)
	}
	if len(frames) == 0 {
		t.Fatal("真实 Responses SSE 为空")
	}
	return frames
}

// assertRealCodexStream 校验首个 created、唯一 completed 终态及终态快照。
func assertRealCodexStream(t *testing.T, frames []realSSEFrame) json.RawMessage {
	t.Helper()
	if frames[0].event != "response.created" ||
		frames[len(frames)-1].event != "response.completed" {
		t.Fatalf("真实 Responses SSE 生命周期错误: %v", realSSEEventNames(frames))
	}
	completedCount := 0
	var terminalEnvelope struct {
		Type     string          `json:"type"`
		Response json.RawMessage `json:"response"`
	}
	for _, frame := range frames {
		if frame.event == "response.failed" || frame.event == "error" {
			t.Fatalf("真实 Responses SSE 包含失败事件: %s", frame.event)
		}
		if frame.event != "response.completed" {
			continue
		}
		completedCount++
		if err := json.Unmarshal(frame.data, &terminalEnvelope); err != nil {
			t.Fatalf("真实 Responses SSE 终态无效: %v", err)
		}
	}
	if completedCount != 1 || terminalEnvelope.Type != "response.completed" {
		t.Fatalf("真实 Responses SSE completed 数量错误: %d", completedCount)
	}
	document := decodeRealResponsesDocument(t, terminalEnvelope.Response)
	assertCompletedRealCodexResponse(t, document)
	return append(json.RawMessage(nil), terminalEnvelope.Response...)
}

// realSSEEventNames 返回不会携带响应正文的有序事件名。
func realSSEEventNames(frames []realSSEFrame) []string {
	names := make([]string, len(frames))
	for index, frame := range frames {
		names[index] = frame.event
	}
	return names
}
