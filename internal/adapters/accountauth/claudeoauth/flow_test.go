package claudeoauth

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
)

// claudeTestNow 固定 Flow 时间，避免 artifact 依赖真实时钟。
func claudeTestNow() time.Time {
	return time.Date(2026, time.November, 8, 12, 0, 0, 0, time.UTC)
}

// claudeTestProfile 是 /api/oauth/profile 的最小合法响应。
const claudeTestProfile = `{
  "account": {"uuid": "11111111-1111-4111-8111-111111111111", "email": "claude@example.test", "display_name": "Claude Test"},
  "organization": {"uuid": "22222222-2222-4222-8222-222222222222", "name": "Test Org", "organization_type": "claude_max", "rate_limit_tier": "default_claude_max_20x"}
}`

// claudeTestServer 记录 token 请求体并返回固定 token / profile。
type claudeTestServer struct {
	server      *httptest.Server
	tokenBody   map[string]any
	tokenCalls  int
	profileAuth string
	status      int
}

func newClaudeTestServer(t *testing.T) *claudeTestServer {
	t.Helper()
	fake := &claudeTestServer{status: http.StatusOK}
	fake.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/token":
			fake.tokenCalls++
			raw, _ := io.ReadAll(request.Body)
			_ = json.Unmarshal(raw, &fake.tokenBody)
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(fake.status)
			if fake.status != http.StatusOK {
				_, _ = io.WriteString(writer, `{"error":"invalid_grant"}`)
				return
			}
			_, _ = io.WriteString(writer, `{"access_token":"access-token-1","refresh_token":"refresh-token-1","expires_in":3600,"scope":"user:inference user:profile"}`)
		case "/profile":
			fake.profileAuth = request.Header.Get("Authorization")
			writer.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(writer, claudeTestProfile)
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func newClaudeFlow(t *testing.T, fake *claudeTestServer) *flow {
	t.Helper()
	provider, err := newProvider(providerOptions{
		client:            fake.server.Client(),
		clock:             claudeTestNow,
		random:            rand.Reader,
		authorizeEndpoint: fake.server.URL + "/authorize",
		tokenEndpoint:     fake.server.URL + "/token",
		profileEndpoint:   fake.server.URL + "/profile",
		redirectURI:       redirectURI,
	})
	if err != nil {
		t.Fatalf("newProvider() error = %v", err)
	}
	value, err := provider.Begin(context.Background())
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	typed, ok := value.(*flow)
	if !ok {
		t.Fatalf("Begin() flow type = %T", value)
	}
	return typed
}

func callbackState(t *testing.T, authorizationURL string) string {
	t.Helper()
	parsed, err := url.Parse(authorizationURL)
	if err != nil {
		t.Fatalf("parse authorization url: %v", err)
	}
	state := parsed.Query().Get("state")
	if state == "" {
		t.Fatal("授权地址缺少 state")
	}
	return state
}

// TestBeginBuildsClaudeAuthorizationURL 验证授权参数与 Node 生产路径一致。
func TestBeginBuildsClaudeAuthorizationURL(t *testing.T) {
	fake := newClaudeTestServer(t)
	flowValue := newClaudeFlow(t, fake)

	parsed, err := url.Parse(flowValue.AuthorizationURL())
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	query := parsed.Query()
	if parsed.Host != strings.TrimPrefix(fake.server.URL, "http://") {
		t.Fatalf("host = %q", parsed.Host)
	}
	if query.Get("code") != "true" ||
		query.Get("client_id") != clientID ||
		query.Get("response_type") != "code" ||
		query.Get("redirect_uri") != redirectURI ||
		query.Get("scope") != oauthScope ||
		query.Get("code_challenge_method") != "S256" ||
		query.Get("code_challenge") == "" ||
		query.Get("state") == "" {
		t.Fatalf("authorization query = %v", query)
	}
}

// TestExchangeBuildsClaudeArtifacts 验证换码、profile 补全与 artifact 形状。
func TestExchangeBuildsClaudeArtifacts(t *testing.T) {
	fake := newClaudeTestServer(t)
	flowValue := newClaudeFlow(t, fake)
	state := callbackState(t, flowValue.AuthorizationURL())
	callback := redirectURI + "?code=test-code&state=" + url.QueryEscape(state)

	artifacts, err := flowValue.Exchange(context.Background(), callback)
	if err != nil {
		t.Fatalf("Exchange() error = %v", err)
	}
	if fake.tokenCalls != 1 {
		t.Fatalf("token calls = %d, want 1", fake.tokenCalls)
	}
	if fake.tokenBody["grant_type"] != "authorization_code" ||
		fake.tokenBody["code"] != "test-code" ||
		fake.tokenBody["redirect_uri"] != redirectURI ||
		fake.tokenBody["client_id"] != clientID ||
		fake.tokenBody["state"] != state ||
		fake.tokenBody["code_verifier"] == "" {
		t.Fatalf("token body = %v", fake.tokenBody)
	}
	if fake.profileAuth != "Bearer access-token-1" {
		t.Fatalf("profile authorization = %q", fake.profileAuth)
	}
	var envelope struct {
		CredentialsJSON  json.RawMessage `json:"credentials_json"`
		GlobalConfigJSON json.RawMessage `json:"global_config_json"`
	}
	if err := json.Unmarshal(artifacts, &envelope); err != nil {
		t.Fatalf("artifacts unmarshal: %v", err)
	}
	if len(envelope.CredentialsJSON) == 0 || len(envelope.GlobalConfigJSON) == 0 {
		t.Fatalf("artifacts 缺少 envelope: %s", artifacts)
	}
	if !strings.Contains(string(envelope.GlobalConfigJSON), "11111111-1111-4111-8111-111111111111") {
		t.Fatalf("global_config_json 缺少账号身份: %s", envelope.GlobalConfigJSON)
	}
}

// TestExchangeRejectsStateMismatch 验证回调 state 与 Job 不一致时拒绝换码。
func TestExchangeRejectsStateMismatch(t *testing.T) {
	fake := newClaudeTestServer(t)
	flowValue := newClaudeFlow(t, fake)
	callback := redirectURI + "?code=test-code&state=forged-state"
	if _, err := flowValue.Exchange(context.Background(), callback); !errors.Is(err, accountauth.ErrStateMismatch) {
		t.Fatalf("Exchange() error = %v, want ErrStateMismatch", err)
	}
	if fake.tokenCalls != 0 {
		t.Fatalf("state 不匹配时不得调用 token endpoint: %d", fake.tokenCalls)
	}
}

// TestExchangeRejectsProviderError 验证 token endpoint 4xx 收敛为 provider_rejected。
func TestExchangeRejectsProviderError(t *testing.T) {
	fake := newClaudeTestServer(t)
	fake.status = http.StatusBadRequest
	flowValue := newClaudeFlow(t, fake)
	state := callbackState(t, flowValue.AuthorizationURL())
	callback := redirectURI + "?code=test-code&state=" + url.QueryEscape(state)
	if _, err := flowValue.Exchange(context.Background(), callback); !errors.Is(err, accountauth.ErrProviderRejected) {
		t.Fatalf("Exchange() error = %v, want ErrProviderRejected", err)
	}
}
