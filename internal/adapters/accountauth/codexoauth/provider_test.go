package codexoauth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
)

const (
	testLoginRedirectURI = "http://localhost:1455/auth/callback"
	testLoginUserID      = "user-codex-login"
	testLoginAccountID   = "ws_codex_login"
	testLoginCode        = "test-authorization-code"
)

// testLoginClock 固定 Begin/Exchange 的时钟，保证 last_refresh 断言稳定。
func testLoginClock() time.Time {
	return time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
}

// testLoginTokens 生成一组结构合法但签名不参与校验的官方 Token。
func testLoginTokens(accountID string) (string, string, string) {
	idToken := fakeJWT(fmt.Sprintf(
		`{"sub":%q,"email":"codex-login@example.com","https://api.openai.com/auth":{"chatgpt_user_id":%q,"chatgpt_account_id":%q,"chatgpt_plan_type":"plus"}}`,
		testLoginUserID, testLoginUserID, accountID,
	))
	accessToken := fakeJWT(fmt.Sprintf(`{"sub":%q,"exp":4102444800}`, testLoginUserID))
	refreshToken := fakeJWT(fmt.Sprintf(`{"sub":%q,"exp":4102444800}`, testLoginUserID))
	return idToken, accessToken, refreshToken
}

// encodeTokenBody 用真实 JSON 编码构造上游响应，避免手写转义出错。
func encodeTokenBody(t *testing.T, fields map[string]string) string {
	t.Helper()
	body, err := json.Marshal(fields)
	if err != nil {
		t.Fatalf("marshal token body: %v", err)
	}
	return string(body)
}

// tokenEndpointRecorder 记录假 token 端点的调用次数和表单内容。
type tokenEndpointRecorder struct {
	calls int
	form  url.Values
}

// newLoginTestProvider 用 httptest 假上游替换唯一的 token 端点。
func newLoginTestProvider(
	t *testing.T,
	status int,
	body string,
	recorder *tokenEndpointRecorder,
) *Provider {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		recorder.calls++
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("读取 token 请求体失败: %v", err)
		}
		recorder.form, _ = url.ParseQuery(string(raw))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(server.Close)
	provider, err := newProvider(providerOptions{
		client:            server.Client(),
		clock:             testLoginClock,
		random:            rand.Reader,
		authorizeEndpoint: "https://auth.openai.com/oauth/authorize",
		tokenEndpoint:     server.URL,
		redirectURI:       testLoginRedirectURI,
	})
	if err != nil {
		t.Fatalf("newProvider() error = %v", err)
	}
	return provider
}

// validLoginCallback 生成与官方 redirect 完全匹配的回调 URL。
func validLoginCallback(state string) string {
	return testLoginRedirectURI +
		"?code=" + url.QueryEscape(testLoginCode) +
		"&state=" + url.QueryEscape(state)
}

// TestBeginBuildsOfficialAuthorizationURL 锁死 Begin 的授权地址合同：
// 官方查询参数、PKCE S256、state 与 verifier 长度。
func TestBeginBuildsOfficialAuthorizationURL(t *testing.T) {
	provider := newLoginTestProvider(t, http.StatusOK, "{}", &tokenEndpointRecorder{})
	begin, err := provider.Begin(context.Background())
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	loginFlow, ok := begin.(*flow)
	if !ok {
		t.Fatalf("Begin() = %T, want *flow", begin)
	}
	if begin.AuthorizationURL() != loginFlow.authorization {
		t.Fatal("AuthorizationURL() 必须与 Flow 持有的授权地址一致")
	}

	parsed, err := url.Parse(begin.AuthorizationURL())
	if err != nil {
		t.Fatalf("授权 URL 无法解析: %v", err)
	}
	if parsed.Scheme != "https" || parsed.Host != "auth.openai.com" ||
		parsed.Path != "/oauth/authorize" {
		t.Fatalf("授权 URL 目标错误: %s", begin.AuthorizationURL())
	}

	want := map[string]string{
		"response_type":              "code",
		"client_id":                  clientID,
		"redirect_uri":               testLoginRedirectURI,
		"scope":                      oauthScope,
		"code_challenge_method":      "S256",
		"id_token_add_organizations": "true",
		"codex_cli_simplified_flow":  "true",
		"originator":                 "codex_cli_rs",
		"state":                      loginFlow.state,
	}
	query := parsed.Query()
	for key, value := range want {
		if got := query.Get(key); got != value {
			t.Errorf("query[%q] = %q, want %q", key, got, value)
		}
	}
	for key := range query {
		if _, expected := want[key]; !expected && key != "code_challenge" {
			t.Errorf("授权 URL 出现未预期参数 %q", key)
		}
	}

	digest := sha256.Sum256([]byte(loginFlow.verifier))
	wantChallenge := base64.RawURLEncoding.EncodeToString(digest[:])
	if got := query.Get("code_challenge"); got != wantChallenge {
		t.Errorf("code_challenge 不是 verifier 的 S256: got %q want %q", got, wantChallenge)
	}
	// 64 字节随机数编码后为 86 字符，32 字节 state 为 43 字符。
	if len(loginFlow.verifier) != 86 {
		t.Errorf("verifier 长度 = %d, want 86", len(loginFlow.verifier))
	}
	if len(loginFlow.state) != 43 {
		t.Errorf("state 长度 = %d, want 43", len(loginFlow.state))
	}
}

// TestExchangeTable 覆盖回调校验、上游状态码与 artifact 生成。
func TestExchangeTable(t *testing.T) {
	idToken, accessToken, refreshToken := testLoginTokens(testLoginAccountID)
	fullBody := encodeTokenBody(t, map[string]string{
		"id_token":      idToken,
		"access_token":  accessToken,
		"refresh_token": refreshToken,
	})
	missingIDTokenBody := encodeTokenBody(t, map[string]string{
		"access_token":  accessToken,
		"refresh_token": refreshToken,
	})

	testCases := []struct {
		name           string
		status         int
		body           string
		callback       func(state string) string
		wantErr        error
		wantTokenCalls int
		wantAccountID  string
	}{
		{
			name:           "good_callback",
			status:         http.StatusOK,
			body:           fullBody,
			callback:       validLoginCallback,
			wantTokenCalls: 1,
			wantAccountID:  testLoginAccountID,
		},
		{
			name:   "state_mismatch",
			status: http.StatusOK,
			body:   fullBody,
			callback: func(string) string {
				return validLoginCallback("forged-state")
			},
			wantErr:        accountauth.ErrStateMismatch,
			wantTokenCalls: 0,
		},
		{
			name:   "redirect_scheme_mismatch",
			status: http.StatusOK,
			body:   fullBody,
			callback: func(state string) string {
				return strings.Replace(validLoginCallback(state), "http://", "https://", 1)
			},
			wantErr:        accountauth.ErrInvalidCallback,
			wantTokenCalls: 0,
		},
		{
			name:   "redirect_host_mismatch",
			status: http.StatusOK,
			body:   fullBody,
			callback: func(state string) string {
				return strings.Replace(validLoginCallback(state), "localhost:1455", "evil.example:1455", 1)
			},
			wantErr:        accountauth.ErrInvalidCallback,
			wantTokenCalls: 0,
		},
		{
			name:   "redirect_path_mismatch",
			status: http.StatusOK,
			body:   fullBody,
			callback: func(state string) string {
				return strings.Replace(validLoginCallback(state), "/auth/callback?", "/auth/callback/extra?", 1)
			},
			wantErr:        accountauth.ErrInvalidCallback,
			wantTokenCalls: 0,
		},
		{
			name:           "upstream_4xx",
			status:         http.StatusBadRequest,
			body:           `{"error":"invalid_grant"}`,
			callback:       validLoginCallback,
			wantErr:        accountauth.ErrProviderRejected,
			wantTokenCalls: 1,
		},
		{
			name:           "upstream_5xx",
			status:         http.StatusServiceUnavailable,
			body:           "",
			callback:       validLoginCallback,
			wantErr:        accountauth.ErrProviderUnavailable,
			wantTokenCalls: 1,
		},
		{
			name:           "missing_id_token",
			status:         http.StatusOK,
			body:           missingIDTokenBody,
			callback:       validLoginCallback,
			wantTokenCalls: 1,
			// 缺口（锁现状）：上游只给 access+refresh 时被归类为
			// provider_unavailable，和网络故障同码。切流前应改成
			// provider_rejected / invalid_artifacts，避免把上游合同
			// 破坏误判为可重试故障。
			wantErr: accountauth.ErrProviderUnavailable,
		},
	}

	for _, testCase := range testCases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := &tokenEndpointRecorder{}
			provider := newLoginTestProvider(t, testCase.status, testCase.body, recorder)
			begin, err := provider.Begin(context.Background())
			if err != nil {
				t.Fatalf("Begin() error = %v", err)
			}
			loginFlow, ok := begin.(*flow)
			if !ok {
				t.Fatalf("Begin() = %T, want *flow", begin)
			}
			// Exchange 完成后会清空一次性私有值，断言前必须先取快照。
			verifier, state := loginFlow.verifier, loginFlow.state

			artifacts, err := begin.Exchange(
				context.Background(),
				testCase.callback(state),
			)
			if testCase.wantErr != nil {
				if !errors.Is(err, testCase.wantErr) {
					t.Fatalf("Exchange() error = %v, want %v", err, testCase.wantErr)
				}
				if artifacts != nil {
					t.Fatal("失败时不得返回 artifact")
				}
			} else if err != nil {
				t.Fatalf("Exchange() error = %v", err)
			}

			if loginFlow.verifier != "" || loginFlow.state != "" {
				t.Error("Exchange 后必须清空 verifier 与 state")
			}
			if recorder.calls != testCase.wantTokenCalls {
				t.Fatalf("token 端点调用次数 = %d, want %d", recorder.calls, testCase.wantTokenCalls)
			}
			if testCase.wantAccountID != "" {
				assertLoginAuthJSON(t, artifacts, testCase.wantAccountID)
				assertLoginTokenForm(t, recorder.form, verifier)
			}
		})
	}
}

// assertLoginAuthJSON 校验产出是官方 auth.json 且带工作区 account_id。
func assertLoginAuthJSON(t *testing.T, artifacts []byte, wantAccountID string) {
	t.Helper()
	var envelope struct {
		AuthJSON json.RawMessage `json:"auth_json"`
	}
	if err := json.Unmarshal(artifacts, &envelope); err != nil {
		t.Fatalf("artifact 不是有效 JSON: %v", err)
	}
	var document struct {
		AuthMode string `json:"auth_mode"`
		Tokens   struct {
			IDToken      string  `json:"id_token"`
			AccessToken  string  `json:"access_token"`
			RefreshToken string  `json:"refresh_token"`
			AccountID    *string `json:"account_id"`
		} `json:"tokens"`
		LastRefresh *string `json:"last_refresh"`
	}
	if err := json.Unmarshal(envelope.AuthJSON, &document); err != nil {
		t.Fatalf("auth_json 无法解析: %v", err)
	}
	if document.AuthMode != "chatgpt" {
		t.Errorf("auth_mode = %q, want chatgpt", document.AuthMode)
	}
	if document.Tokens.AccountID == nil || *document.Tokens.AccountID != wantAccountID {
		t.Errorf("tokens.account_id = %v, want %q", document.Tokens.AccountID, wantAccountID)
	}
	if document.Tokens.IDToken == "" || document.Tokens.AccessToken == "" ||
		document.Tokens.RefreshToken == "" {
		t.Error("auth_json 缺少任一 Token")
	}
	wantRefresh := "2026-11-06T12:00:00Z"
	if document.LastRefresh == nil || *document.LastRefresh != wantRefresh {
		t.Errorf("last_refresh = %v, want %q", document.LastRefresh, wantRefresh)
	}
}

// assertLoginTokenForm 校验换 Token 请求的官方 form 合同。
func assertLoginTokenForm(t *testing.T, form url.Values, verifier string) {
	t.Helper()
	want := map[string]string{
		"grant_type":    "authorization_code",
		"code":          testLoginCode,
		"redirect_uri":  testLoginRedirectURI,
		"client_id":     clientID,
		"code_verifier": verifier,
	}
	for key, value := range want {
		if got := form.Get(key); got != value {
			t.Errorf("form[%q] = %q, want %q", key, got, value)
		}
	}
}
