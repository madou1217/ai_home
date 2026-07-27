package accountauthapi_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/claudeoauth"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/codexoauth"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/transport/http/accountauthapi"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

const (
	smokeManagementKey   = "synthetic-oauth-live-smoke-management-key"
	smokeCodexAccess     = "synthetic-oauth-live-codex-access"
	smokeCodexRefresh    = "synthetic-oauth-live-codex-refresh"
	smokeClaudeAccess    = "sk-ant-oat01-synthetic-oauth-live-claude-access"
	smokeClaudeRefresh   = "sk-ant-ort01-synthetic-oauth-live-claude-refresh"
	smokeClaudeAccountID = "123e4567-e89b-12d3-a456-426614174555"
)

// TestOAuthJobLiveSmoke 使用真实 TCP、SQLite 和伪造 OAuth 上游验证两种 Provider 完整链路。
func TestOAuthJobLiveSmoke(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			handleFakeOAuthUpstream(t, response, request)
		},
	))
	defer upstream.Close()

	handler := newLiveManagementHandler(t, upstream.URL)
	server := httptest.NewServer(handler)
	defer server.Close()

	codexJob := startLiveJob(t, server, "codex")
	codexCallback := "http://localhost:1455/auth/callback?code=codex-live-code&state=" +
		url.QueryEscape(codexJob.state)
	codexCompleted := completeLiveJob(
		t,
		server,
		codexJob.id,
		codexCallback,
	)
	assertCompletedJob(t, codexCompleted, "codex", 1)

	claudeJob := startLiveJob(t, server, "claude")
	claudeCompleted := completeLiveJob(
		t,
		server,
		claudeJob.id,
		"claude-live-code#"+claudeJob.state,
	)
	assertCompletedJob(t, claudeCompleted, "claude", 1)

	listed := performLiveRequest(
		t,
		server.Client(),
		http.MethodGet,
		server.URL+accountsapi.CollectionPath+"?limit=10",
		nil,
	)
	logLiveExchange(t, listed)
	if listed.status != http.StatusOK {
		t.Fatalf("账号列表 status=%d body=%s", listed.status, listed.responseBody)
	}
	var listDocument struct {
		Data []struct {
			ProviderID       string `json:"provider_id"`
			CLIAccountID     int64  `json:"cli_account_id"`
			AuthKind         string `json:"auth_kind"`
			AuthMode         string `json:"auth_mode"`
			Email            string `json:"email"`
			SubscriptionKind string `json:"subscription_kind"`
		} `json:"data"`
	}
	decodeLiveJSON(t, listed.responseBody, &listDocument)
	if len(listDocument.Data) != 2 {
		t.Fatalf("账号列表 data = %#v", listDocument.Data)
	}
	found := make(map[string]struct {
		mode  string
		email string
		plan  string
	})
	for _, account := range listDocument.Data {
		if account.AuthKind != "oauth" || account.CLIAccountID != 1 {
			t.Fatalf("账号列表 OAuth 投影错误: %#v", account)
		}
		found[account.ProviderID] = struct {
			mode  string
			email string
			plan  string
		}{
			mode:  account.AuthMode,
			email: account.Email,
			plan:  account.SubscriptionKind,
		}
	}
	if found["codex"].email != "oauth-live-codex@example.invalid" ||
		found["codex"].plan != "business" ||
		found["claude"].mode != "refreshable" ||
		found["claude"].email != "oauth-live-claude@example.invalid" ||
		found["claude"].plan != "max" {
		t.Fatalf("账号列表 Provider 结果错误: %#v", found)
	}

	for _, secret := range []string{
		smokeCodexAccess,
		smokeCodexRefresh,
		smokeClaudeAccess,
		smokeClaudeRefresh,
		"codex-live-code",
		"claude-live-code",
	} {
		if strings.Contains(codexCompleted.responseBody, secret) ||
			strings.Contains(claudeCompleted.responseBody, secret) ||
			strings.Contains(listed.responseBody, secret) {
			t.Fatalf("公开 API 响应泄漏 OAuth 私有值")
		}
	}
}

// liveJob 保存 smoke 提交回调所需但不会写入日志的短期值。
type liveJob struct {
	id    string
	state string
}

// startLiveJob 创建 OAuth Job，并从一次性授权 URL 提取测试 state。
func startLiveJob(
	t *testing.T,
	server *httptest.Server,
	providerID string,
) liveJob {
	t.Helper()

	payload, err := json.Marshal(map[string]string{"provider_id": providerID})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	exchange := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		server.URL+accountauthapi.CollectionPath,
		payload,
	)
	logLiveExchange(t, redactStartExchange(t, exchange))
	if exchange.status != http.StatusCreated {
		t.Fatalf("创建 %s Job status=%d body=%s", providerID, exchange.status, exchange.responseBody)
	}
	var document struct {
		Data struct {
			JobID            string `json:"job_id"`
			Status           string `json:"status"`
			AuthorizationURL string `json:"authorization_url"`
		} `json:"data"`
	}
	decodeLiveJSON(t, exchange.responseBody, &document)
	authorizationURL, err := url.Parse(document.Data.AuthorizationURL)
	if err != nil ||
		document.Data.Status != "pending" ||
		len(document.Data.JobID) != 32 ||
		authorizationURL.Query().Get("state") == "" {
		t.Fatalf("创建 %s Job 响应无效", providerID)
	}
	return liveJob{
		id:    document.Data.JobID,
		state: authorizationURL.Query().Get("state"),
	}
}

// completeLiveJob 提交回调，但日志只显示脱敏后的 payload。
func completeLiveJob(
	t *testing.T,
	server *httptest.Server,
	jobID string,
	callback string,
) liveExchange {
	t.Helper()

	payload, err := json.Marshal(map[string]string{"callback": callback})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	exchange := performLiveRequest(
		t,
		server.Client(),
		http.MethodPost,
		server.URL+accountauthapi.CollectionPath+"/"+jobID+"/callback",
		payload,
	)
	redacted := exchange
	redacted.requestBody = `{"callback":"<redacted>"}`
	logLiveExchange(t, redacted)
	if exchange.status != http.StatusOK {
		t.Fatalf("完成 Job status=%d body=%s", exchange.status, exchange.responseBody)
	}
	return exchange
}

// assertCompletedJob 校验 OAuth Job 成功后的公开账号身份。
func assertCompletedJob(
	t *testing.T,
	exchange liveExchange,
	providerID string,
	cliAccountID int64,
) {
	t.Helper()

	var document struct {
		Data struct {
			ProviderID   string `json:"provider_id"`
			Status       string `json:"status"`
			AccountRef   string `json:"account_ref"`
			CLIAccountID int64  `json:"cli_account_id"`
		} `json:"data"`
	}
	decodeLiveJSON(t, exchange.responseBody, &document)
	if document.Data.ProviderID != providerID ||
		document.Data.Status != "completed" ||
		!strings.HasPrefix(document.Data.AccountRef, "acct_") ||
		document.Data.CLIAccountID != cliAccountID {
		t.Fatalf("completed Job = %#v", document.Data)
	}
}

// newLiveManagementHandler 装配真实 SQLite、账号注册、OAuth Job 和两个 HTTP Handler。
func newLiveManagementHandler(
	t *testing.T,
	upstreamURL string,
) http.Handler {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	store, err := sqliteaccount.Open(context.Background(), sqliteaccount.OpenOptions{
		AIHomeDir: t.TempDir(),
		Catalog:   catalog,
	})
	if err != nil {
		t.Fatalf("sqliteaccount.Open() error = %v", err)
	}
	t.Cleanup(func() {
		if err := store.Close(); err != nil {
			t.Errorf("store.Close() error = %v", err)
		}
	})
	registrar, err := accountapp.NewRegistrar(catalog, store, liveClock)
	if err != nil {
		t.Fatalf("accounts.NewRegistrar() error = %v", err)
	}
	management, err := accountapp.NewManagement(store, store, liveClock)
	if err != nil {
		t.Fatalf("accounts.NewManagement() error = %v", err)
	}
	authorizer, err := accountsapi.NewBearerAuthorizer(
		func() string { return smokeManagementKey },
	)
	if err != nil {
		t.Fatalf("accountsapi.NewBearerAuthorizer() error = %v", err)
	}
	targetURL, err := url.Parse(upstreamURL)
	if err != nil {
		t.Fatalf("url.Parse(upstream) error = %v", err)
	}
	oauthClient := &http.Client{
		Timeout: time.Second,
		Transport: &rewriteTransport{
			target: targetURL,
			base:   http.DefaultTransport,
		},
	}
	codexProvider, err := codexoauth.New(oauthClient, liveClock)
	if err != nil {
		t.Fatalf("codexoauth.New() error = %v", err)
	}
	claudeProvider, err := claudeoauth.New(oauthClient, liveClock)
	if err != nil {
		t.Fatalf("claudeoauth.New() error = %v", err)
	}
	decoder := nativeaccount.NewDecoder()
	jobs, err := accountauth.NewService(accountauth.Dependencies{
		Providers: []accountauth.OAuthProvider{
			codexProvider,
			claudeProvider,
		},
		Decoder:    decoder,
		Registrar:  registrar,
		Clock:      liveClock,
		GenerateID: accountauth.NewRandomJobID,
	})
	if err != nil {
		t.Fatalf("accountauth.NewService() error = %v", err)
	}
	authHandler, err := accountauthapi.NewHandler(accountauthapi.Dependencies{
		Jobs:       jobs,
		Authorizer: authorizer,
	})
	if err != nil {
		t.Fatalf("accountauthapi.NewHandler() error = %v", err)
	}
	accountsHandler, err := accountsapi.NewHandler(accountsapi.Dependencies{
		Management:     management,
		Registrar:      registrar,
		APIKeys:        accountsapi.NewBuiltinAPIKeyCredentialFactory(),
		NativeAccounts: decoder,
		Authorizer:     authorizer,
	})
	if err != nil {
		t.Fatalf("accountsapi.NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle(accountauthapi.CollectionPath, authHandler)
	mux.Handle(accountauthapi.CollectionPath+"/", authHandler)
	mux.Handle(accountsapi.CollectionPath, accountsHandler)
	mux.Handle(accountsapi.CollectionPath+"/", accountsHandler)
	return mux
}

// rewriteTransport 把官方 OAuth 请求透明转发到本地 fake upstream。
type rewriteTransport struct {
	target *url.URL
	base   http.RoundTripper
}

// RoundTrip 保留官方请求 path/body，只替换测试网络目标。
func (transport *rewriteTransport) RoundTrip(
	request *http.Request,
) (*http.Response, error) {
	cloned := request.Clone(request.Context())
	cloned.URL.Scheme = transport.target.Scheme
	cloned.URL.Host = transport.target.Host
	cloned.Host = transport.target.Host
	return transport.base.RoundTrip(cloned)
}

// handleFakeOAuthUpstream 提供 Codex Token、Claude Token 和 Claude Profile 响应。
func handleFakeOAuthUpstream(
	t *testing.T,
	response http.ResponseWriter,
	request *http.Request,
) {
	t.Helper()

	switch request.URL.Path {
	case "/oauth/token":
		if err := request.ParseForm(); err != nil {
			t.Fatalf("Codex ParseForm() error = %v", err)
		}
		if request.Form.Get("code") != "codex-live-code" ||
			request.Form.Get("code_verifier") == "" {
			t.Fatal("Codex token request 缺少 code 或 verifier")
		}
		writeUpstreamJSON(t, response, map[string]any{
			"id_token":      liveCodexJWT(t),
			"access_token":  smokeCodexAccess,
			"refresh_token": smokeCodexRefresh,
		})
	case "/v1/oauth/token":
		var input struct {
			Code         string `json:"code"`
			CodeVerifier string `json:"code_verifier"`
			State        string `json:"state"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil ||
			input.Code != "claude-live-code" ||
			input.CodeVerifier == "" ||
			input.State == "" {
			t.Fatal("Claude token request 无效")
		}
		writeUpstreamJSON(t, response, map[string]any{
			"access_token":  smokeClaudeAccess,
			"refresh_token": smokeClaudeRefresh,
			"expires_in":    3600,
			"scope":         "user:profile user:inference",
		})
	case "/api/oauth/profile":
		if request.Header.Get("Authorization") != "Bearer "+smokeClaudeAccess {
			t.Fatal("Claude Profile 缺少正确 Bearer Token")
		}
		writeUpstreamJSON(t, response, map[string]any{
			"account": map[string]any{
				"uuid":         smokeClaudeAccountID,
				"email":        "oauth-live-claude@example.invalid",
				"display_name": "OAuth Live Claude",
				"created_at":   "2025-01-02T03:04:05Z",
			},
			"organization": map[string]any{
				"uuid":                    "123e4567-e89b-12d3-a456-426614174556",
				"name":                    "OAuth Live Org",
				"organization_type":       "claude_max",
				"rate_limit_tier":         "default_claude_max_20x",
				"billing_type":            "stripe_subscription",
				"has_extra_usage_enabled": true,
				"subscription_created_at": "2025-02-03T04:05:06Z",
			},
		})
	default:
		http.NotFound(response, request)
	}
}

// liveClock 返回 smoke 中所有持久化时间的固定值。
func liveClock() time.Time {
	return time.Date(2026, 7, 27, 15, 0, 0, 0, time.UTC)
}

// liveCodexJWT 创建 fake 官方 token endpoint 返回的合成 ID Token。
func liveCodexJWT(t *testing.T) string {
	t.Helper()

	header, err := json.Marshal(map[string]any{"alg": "none", "typ": "JWT"})
	if err != nil {
		t.Fatalf("json.Marshal(header) error = %v", err)
	}
	payload, err := json.Marshal(map[string]any{
		"sub":   "oauth-live-codex-user",
		"email": "oauth-live-codex@example.invalid",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "oauth-live-codex-workspace",
			"chatgpt_plan_type":  "team",
		},
	})
	if err != nil {
		t.Fatalf("json.Marshal(payload) error = %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}

// liveExchange 保存真实 HTTP 请求和响应证据。
type liveExchange struct {
	method       string
	url          string
	requestBody  string
	status       int
	responseBody string
}

// performLiveRequest 使用真实 HTTP Client 调用本地 Listener。
func performLiveRequest(
	t *testing.T,
	client *http.Client,
	method string,
	requestURL string,
	body []byte,
) liveExchange {
	t.Helper()

	request, err := http.NewRequestWithContext(
		context.Background(),
		method,
		requestURL,
		bytes.NewReader(body),
	)
	if err != nil {
		t.Fatalf("http.NewRequestWithContext() error = %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+smokeManagementKey)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatalf("%s %s error = %v", method, requestURL, err)
	}
	defer func() {
		_ = response.Body.Close()
	}()
	responseBody, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("io.ReadAll() error = %v", err)
	}
	return liveExchange{
		method:       method,
		url:          requestURL,
		requestBody:  strings.TrimSpace(string(body)),
		status:       response.StatusCode,
		responseBody: strings.TrimSpace(string(responseBody)),
	}
}

// redactStartExchange 隐藏创建响应授权 URL 中的 state 和 challenge。
func redactStartExchange(
	t *testing.T,
	exchange liveExchange,
) liveExchange {
	t.Helper()

	var document map[string]any
	decodeLiveJSON(t, exchange.responseBody, &document)
	data, valid := document["data"].(map[string]any)
	if !valid {
		t.Fatal("OAuth Job 创建响应缺少 data")
	}
	rawURL, valid := data["authorization_url"].(string)
	if !valid {
		t.Fatal("OAuth Job 创建响应缺少 authorization_url")
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("url.Parse(authorization_url) error = %v", err)
	}
	data["authorization_url"] = parsed.Scheme + "://" + parsed.Host +
		parsed.Path + "?<redacted>"
	redacted, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("json.Marshal(redacted) error = %v", err)
	}
	exchange.responseBody = string(redacted)
	return exchange
}

// logLiveExchange 输出用户可核对的地址、payload、status 和 response。
func logLiveExchange(t *testing.T, exchange liveExchange) {
	t.Helper()

	t.Logf(
		"%s %s\npayload: %s\nstatus: %d\nresponse: %s",
		exchange.method,
		exchange.url,
		exchange.requestBody,
		exchange.status,
		exchange.responseBody,
	)
}

// decodeLiveJSON 解码 smoke 响应。
func decodeLiveJSON(t *testing.T, document string, target any) {
	t.Helper()

	if err := json.Unmarshal([]byte(document), target); err != nil {
		t.Fatalf("json.Unmarshal(response) error = %v body=%s", err, document)
	}
}

// writeUpstreamJSON 写入 fake OAuth 上游 JSON 响应。
func writeUpstreamJSON(
	t *testing.T,
	response http.ResponseWriter,
	document any,
) {
	t.Helper()

	response.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(response).Encode(document); err != nil {
		t.Fatalf("json.Encode() error = %v", err)
	}
}
