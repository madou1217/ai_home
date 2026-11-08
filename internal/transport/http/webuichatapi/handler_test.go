package webuichatapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

const (
	accountA accountcore.AccountRef = "acct_0000000000000000000a"
	accountB accountcore.AccountRef = "acct_0000000000000000000b"
	// commandPath 是本切片挂在 Node 同名入口上的路径。
	commandPath = CollectionPath + "s-1/commands"
)

// testCredential 是最小凭据合同实现，只提供绑定所需的事实。
type testCredential struct {
	provider string
}

func (credential testCredential) ProviderID() string   { return credential.provider }
func (credential testCredential) IdentitySeed() string { return "seed-" + credential.provider }
func (credential testCredential) String() string       { return "test-credential" }
func (credential testCredential) GoString() string     { return "testCredential" }

// testCredentials 记录每次被征召的账号，并按账号构造真实的绑定与观察。
type testCredentials struct {
	provider   string
	resolveErr error
	mutex      sync.Mutex
	resolved   []accountcore.AccountRef
}

func (resolver *testCredentials) ResolveObservedCredentialBinding(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialBinding, accountcredentials.CredentialObservation, error) {
	resolver.mutex.Lock()
	resolver.resolved = append(resolver.resolved, accountRef)
	resolver.mutex.Unlock()
	if resolver.resolveErr != nil {
		return accountapp.CredentialBinding{}, accountcredentials.CredentialObservation{}, resolver.resolveErr
	}
	credential := testCredential{provider: resolver.provider}
	binding, err := accountapp.NewCredentialBinding(accountRef, resolver.provider, credential)
	if err != nil {
		return accountapp.CredentialBinding{}, accountcredentials.CredentialObservation{}, err
	}
	snapshot, err := accountapp.NewCredentialSnapshot(
		accountRef, resolver.provider, credential, time.Unix(1_700_000_000, 0),
	)
	if err != nil {
		return accountapp.CredentialBinding{}, accountcredentials.CredentialObservation{}, err
	}
	observation, err := accountcredentials.NewCredentialObservation(snapshot)
	if err != nil {
		return accountapp.CredentialBinding{}, accountcredentials.CredentialObservation{}, err
	}
	return binding, observation, nil
}

func (resolver *testCredentials) IsCurrentCredentialObservation(
	context.Context,
	accountcredentials.CredentialObservation,
) (bool, error) {
	return true, nil
}

func (resolver *testCredentials) attempted() []accountcore.AccountRef {
	resolver.mutex.Lock()
	defer resolver.mutex.Unlock()
	return append([]accountcore.AccountRef(nil), resolver.resolved...)
}

// testProvider 复用 relaycore 的基类，只覆盖取令牌这一步。
type testProvider struct {
	relaycore.BaseProvider
	accessToken string
}

func newTestProvider(endpoint string) *testProvider {
	return &testProvider{
		BaseProvider: relaycore.NewBaseProvider("openai", endpoint),
		accessToken:  "test-token",
	}
}

// Resolve 必须返回外层类型本身：BaseProvider 的默认实现返回的是内嵌值，
// 调用方拿到的会是基类的 AccessToken（一律报凭据不适配）。
func (provider *testProvider) Resolve(input relaycore.ResolveInput) (relaycore.Provider, bool) {
	if strings.EqualFold(strings.TrimSpace(input.ProviderID), provider.ID()) {
		return provider, true
	}
	return nil, false
}

func (provider *testProvider) AccessToken(accountapp.Credential) (string, error) {
	return provider.accessToken, nil
}

var _ relaycore.Provider = (*testProvider)(nil)

// testAccounts 按给定顺序产出候选账号。
type testAccounts struct {
	refs []accountcore.AccountRef
	err  error
}

func (source *testAccounts) Accounts(
	context.Context,
	runtimecore.ModelID,
) (relaycore.AccountCursor, error) {
	if source.err != nil {
		return nil, source.err
	}
	return &testCursor{refs: source.refs}, nil
}

type testCursor struct {
	refs  []accountcore.AccountRef
	index int
}

func (cursor *testCursor) Next(context.Context) (accountcore.AccountRef, bool, error) {
	if cursor.index >= len(cursor.refs) {
		return "", false, nil
	}
	ref := cursor.refs[cursor.index]
	cursor.index++
	return ref, true, nil
}

// testAttempts 统计运行态写入次数。
type testAttempts struct {
	mutex    sync.Mutex
	success  int
	failures int
}

func (recorder *testAttempts) RecordSuccess(
	context.Context,
	runtimecore.ModelRoute,
	inferencegateway.AttemptSuccess,
) error {
	recorder.mutex.Lock()
	recorder.success++
	recorder.mutex.Unlock()
	return nil
}

func (recorder *testAttempts) RecordFailure(
	context.Context,
	runtimecore.ModelRoute,
	inferencegateway.AttemptFailure,
) error {
	recorder.mutex.Lock()
	recorder.failures++
	recorder.mutex.Unlock()
	return nil
}

func (recorder *testAttempts) counts() (int, int) {
	recorder.mutex.Lock()
	defer recorder.mutex.Unlock()
	return recorder.success, recorder.failures
}

// testUsage 收集结算出来的用量。
type testUsage struct {
	mutex  sync.Mutex
	usages []inference.Usage
}

func (recorder *testUsage) RecordAttemptUsage(
	_ context.Context,
	_ runtimecore.ModelRoute,
	usage inference.Usage,
) error {
	recorder.mutex.Lock()
	recorder.usages = append(recorder.usages, usage)
	recorder.mutex.Unlock()
	return nil
}

func (recorder *testUsage) collected() []inference.Usage {
	recorder.mutex.Lock()
	defer recorder.mutex.Unlock()
	return append([]inference.Usage(nil), recorder.usages...)
}

// testClient 记录发往上游的请求并回放预置响应。
type testClient struct {
	mutex    sync.Mutex
	requests []*http.Request
	bodies   []string
	respond  func(*http.Request) (*http.Response, error)
}

func (client *testClient) Do(request *http.Request) (*http.Response, error) {
	body := ""
	if request.Body != nil {
		payload, _ := io.ReadAll(request.Body)
		body = string(payload)
	}
	client.mutex.Lock()
	client.requests = append(client.requests, request)
	client.bodies = append(client.bodies, body)
	client.mutex.Unlock()
	return client.respond(request)
}

func (client *testClient) sent() ([]*http.Request, []string) {
	client.mutex.Lock()
	defer client.mutex.Unlock()
	requests := append([]*http.Request(nil), client.requests...)
	bodies := append([]string(nil), client.bodies...)
	return requests, bodies
}

// rig 是一套可观测的 Handler 依赖。
type rig struct {
	handler     *Handler
	accounts    *testAccounts
	credentials *testCredentials
	attempts    *testAttempts
	usage       *testUsage
	client      *testClient
}

func newRig(
	t *testing.T,
	refs []accountcore.AccountRef,
	respond func(*http.Request) (*http.Response, error),
	tweak func(*Dependencies),
) *rig {
	t.Helper()
	client := &testClient{respond: respond}
	accounts := &testAccounts{refs: refs}
	credentials := &testCredentials{provider: "openai"}
	attempts := &testAttempts{}
	usage := &testUsage{}
	dependencies := Dependencies{
		Accounts:    accounts,
		Credentials: credentials,
		Provider:    newTestProvider("https://upstream.test/v1/chat/completions"),
		Client:      client,
		Attempts:    attempts,
		Usage:       usage,
		// 固定时钟让 durationMs / ttftMs 可断言。
		Clock: func() time.Time { return time.Unix(1_700_000_000, 0) },
		NewID: func(prefix string) string { return prefix + "-fixed" },
		// 默认关闭心跳：只有心跳用例需要它。
		HeartbeatInterval: -1,
	}
	if tweak != nil {
		tweak(&dependencies)
	}
	handler, err := NewHandler(dependencies)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return &rig{
		handler:     handler,
		accounts:    accounts,
		credentials: credentials,
		attempts:    attempts,
		usage:       usage,
		client:      client,
	}
}

// post 发一条 turn.submit。headers 是额外的请求头（如钉选账号）。
func (testRig *rig) post(t *testing.T, body string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, commandPath, strings.NewReader(body))
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	recorder := httptest.NewRecorder()
	testRig.handler.ServeHTTP(recorder, request)
	return recorder
}

// submitBody 是最小合法的 turn.submit 信封。
const submitBody = `{"commandId":"c-1","type":"turn.submit","payload":{"content":"你好","model":"gpt-test"}}`

// sseResponse 拼一个 SSE 成功响应。
func sseResponse(frames string) *http.Response {
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:       io.NopCloser(strings.NewReader(frames)),
	}
}

// jsonResponse 拼一个 JSON 响应（错误体或非流式回退）。
func jsonResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

// sseFrame 是一帧解析后的 SSE 文本。
type sseFrame struct {
	id    string
	event string
	data  string
}

// parseFrames 按空行切帧，忽略心跳注释帧。
func parseFrames(t *testing.T, body string) []sseFrame {
	t.Helper()
	frames := make([]sseFrame, 0, 8)
	for _, block := range strings.Split(body, lineBreak+lineBreak) {
		block = strings.TrimSpace(block)
		if block == "" || strings.HasPrefix(block, ":") {
			continue
		}
		parsed := sseFrame{}
		for _, line := range strings.Split(block, lineBreak) {
			switch {
			case strings.HasPrefix(line, "id: "):
				parsed.id = strings.TrimPrefix(line, "id: ")
			case strings.HasPrefix(line, "event: "):
				parsed.event = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				parsed.data = strings.TrimPrefix(line, "data: ")
			}
		}
		frames = append(frames, parsed)
	}
	return frames
}

// decodedEvent 是断言用的信封视图。
type decodedEvent struct {
	Schema    string          `json:"schema"`
	EventID   string          `json:"eventId"`
	SessionID string          `json:"sessionId"`
	Seq       int64           `json:"seq"`
	Type      string          `json:"type"`
	At        int64           `json:"at"`
	TurnID    string          `json:"turnId"`
	RunID     string          `json:"runId"`
	ItemID    string          `json:"itemId"`
	Source    eventSource     `json:"source"`
	Payload   json.RawMessage `json:"payload"`
}

func decodeEvent(t *testing.T, data string) decodedEvent {
	t.Helper()
	event := decodedEvent{}
	if err := json.Unmarshal([]byte(data), &event); err != nil {
		t.Fatalf("事件解码失败: %v (%s)", err, data)
	}
	return event
}

func decodePayload[T any](t *testing.T, event decodedEvent) T {
	t.Helper()
	var payload T
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		t.Fatalf("载荷解码失败: %v (%s)", err, string(event.Payload))
	}
	return payload
}
