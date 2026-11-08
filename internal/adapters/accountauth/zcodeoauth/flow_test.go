package zcodeoauth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/accountauth"
)

// tokenServer 记录收到的请求并按脚本返回响应。
type tokenServer struct {
	server  *httptest.Server
	request *http.Request
	body    map[string]any

	status  int
	payload string
}

func newTokenServer(t *testing.T, status int, payload string) *tokenServer {
	t.Helper()
	fake := &tokenServer{status: status, payload: payload}
	fake.server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		fake.request = request
		raw, err := io.ReadAll(io.LimitReader(request.Body, 64*1024))
		if err != nil {
			t.Errorf("读取请求体失败: %v", err)
		}
		_ = json.Unmarshal(raw, &fake.body)
		response.WriteHeader(fake.status)
		_, _ = response.Write([]byte(fake.payload))
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

// stateOf 取出当前流程的 state，用来构造合法回调。
func stateOf(t *testing.T, flowValue *flow) string {
	t.Helper()
	parsed, err := url.Parse(flowValue.AuthorizationURL())
	if err != nil {
		t.Fatalf("authorization URL 无效: %v", err)
	}
	return parsed.Query().Get("state")
}

// callbackFor 构造官方自定义协议回调地址。
func callbackFor(state string) string {
	return "zcode://oauth/callback?code=auth-code&state=" + url.QueryEscape(state)
}

func TestExchangeUsesOfficialTokenContract(t *testing.T) {
	fake := newTokenServer(t, http.StatusOK, `{"code":0,"msg":"ok","data":{
		"token":"zcode-jwt",
		"zai":{"access_token":"access-1","refresh_token":"refresh-1"},
		"user":{"user_id":"user-1","email":"u@example.test","name":"User One"}}}`)
	flowValue := beginFlow(t, newTestProvider(t, fake.server.URL, "zai"))
	state := stateOf(t, flowValue)

	artifacts, err := flowValue.Exchange(context.Background(), callbackFor(state))
	if err != nil {
		t.Fatalf("Exchange() error = %v", err)
	}
	if fake.request.Method != http.MethodPost {
		t.Fatalf("method = %s, want POST", fake.request.Method)
	}
	if got := fake.request.Header.Get("Content-Type"); got != "application/json" {
		t.Fatalf("content-type = %q", got)
	}
	if got := fake.request.Header.Get("Accept"); got != "application/json" {
		t.Fatalf("accept = %q", got)
	}
	for key, want := range map[string]string{
		"provider":     "zai",
		"code":         "auth-code",
		"redirect_uri": "zcode://oauth/callback",
		"state":        state,
	} {
		if got, _ := fake.body[key].(string); got != want {
			t.Fatalf("body[%s] = %q, want %q", key, got, want)
		}
	}
	if len(fake.body) != 4 {
		t.Fatalf("请求体字段 = %v, want 4 个", fake.body)
	}
	if !strings.Contains(string(artifacts), `"oauth:zai:access_token":"access-1"`) {
		t.Fatalf("artifact 缺少 access_token: %s", artifacts)
	}
	if claims := flowValue.AccountClaims(); claims.Email != "u@example.test" || claims.DisplayName != "User One" {
		t.Fatalf("AccountClaims() = %+v", claims)
	}
	// 一次性值必须立刻失效：同一 Flow 不能再次兑换。
	if flowValue.AuthorizationURL() != "" {
		t.Fatalf("Exchange 后 AuthorizationURL() = %q", flowValue.AuthorizationURL())
	}
	if _, err := flowValue.Exchange(context.Background(), callbackFor(state)); !errors.Is(err, accountauth.ErrStateMismatch) {
		t.Fatalf("第二次 Exchange() error = %v, want state_mismatch", err)
	}
}

func TestExchangeMapsUpstreamFailures(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		payload string
		want    error
	}{
		{name: "4xx", status: http.StatusUnauthorized, payload: `{"code":401}`, want: accountauth.ErrProviderRejected},
		{name: "5xx", status: http.StatusBadGateway, payload: `oops`, want: accountauth.ErrProviderUnavailable},
		{name: "business code", status: http.StatusOK, payload: `{"code":1001,"msg":"denied"}`, want: accountauth.ErrProviderRejected},
		{name: "invalid json", status: http.StatusOK, payload: `not-json`, want: accountauth.ErrProviderUnavailable},
		{name: "missing data", status: http.StatusOK, payload: `{"code":0}`, want: accountauth.ErrProviderRejected},
		{name: "missing jwt", status: http.StatusOK, payload: `{"code":0,"data":{"zai":{"access_token":"a"}}}`, want: accountauth.ErrProviderRejected},
		{name: "missing access token", status: http.StatusOK, payload: `{"code":0,"data":{"token":"j"}}`, want: accountauth.ErrProviderRejected},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fake := newTokenServer(t, testCase.status, testCase.payload)
			flowValue := beginFlow(t, newTestProvider(t, fake.server.URL, "zai"))
			if _, err := flowValue.Exchange(context.Background(), callbackFor(stateOf(t, flowValue))); !errors.Is(err, testCase.want) {
				t.Fatalf("Exchange() error = %v, want %v", err, testCase.want)
			}
		})
	}
}

func TestExchangeReadsRegionTokens(t *testing.T) {
	payload := `{"code":0,"data":{"token":"jwt","bigmodel":{"access_token":"bm","refresh_token":"bmr"},
		"user":{"user_id":"u","name":"N"}}}`
	fake := newTokenServer(t, http.StatusOK, payload)
	flowValue := beginFlow(t, newTestProvider(t, fake.server.URL, "bigmodel"))
	artifacts, err := flowValue.Exchange(context.Background(), callbackFor(stateOf(t, flowValue)))
	if err != nil {
		t.Fatalf("Exchange() error = %v", err)
	}
	// Node 的 custom-scheme 分支固定发 zai；区域只影响授权入口与凭据键。
	if got, _ := fake.body["provider"].(string); got != "zai" {
		t.Fatalf("body provider = %q, want zai", got)
	}
	if !strings.Contains(string(artifacts), `"oauth:bigmodel:access_token":"bm"`) {
		t.Fatalf("artifact 缺少 bigmodel token: %s", artifacts)
	}
}

func TestParseCallbackAcceptsPastedForms(t *testing.T) {
	const state = "state-value"
	cases := []struct {
		name string
		raw  string
	}{
		{name: "full custom scheme url", raw: "zcode://oauth/callback?code=abc&state=" + state},
		{name: "query only", raw: "?code=abc&state=" + state},
		{name: "bare query", raw: "code=abc&state=" + state},
		{name: "path form", raw: "/callback?code=abc&state=" + state},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			code, err := parseCallback(testCase.raw, redirectURI, state)
			if err != nil {
				t.Fatalf("parseCallback() error = %v", err)
			}
			if code != "abc" {
				t.Fatalf("code = %q", code)
			}
		})
	}
}

func TestParseCallbackRejectsInvalidInput(t *testing.T) {
	const state = "state-value"
	cases := []struct {
		name string
		raw  string
		want error
	}{
		{name: "empty", raw: "", want: accountauth.ErrInvalidCallback},
		{name: "bare code without state", raw: "abc", want: accountauth.ErrStateMismatch},
		{name: "missing state", raw: "zcode://oauth/callback?code=abc", want: accountauth.ErrStateMismatch},
		{name: "wrong state", raw: "zcode://oauth/callback?code=abc&state=other", want: accountauth.ErrStateMismatch},
		{name: "wrong endpoint", raw: "zcode://evil/callback?code=abc&state=" + state, want: accountauth.ErrInvalidCallback},
		{name: "wrong path", raw: "zcode://oauth/other?code=abc&state=" + state, want: accountauth.ErrInvalidCallback},
		{name: "provider error", raw: "zcode://oauth/callback?error=access_denied&state=" + state, want: accountauth.ErrProviderRejected},
		{name: "missing code", raw: "zcode://oauth/callback?state=" + state, want: accountauth.ErrInvalidCallback},
		{name: "duplicate code", raw: "zcode://oauth/callback?code=a&code=b&state=" + state, want: accountauth.ErrInvalidCallback},
		{name: "userinfo", raw: "zcode://user@oauth/callback?code=abc&state=" + state, want: accountauth.ErrInvalidCallback},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := parseCallback(testCase.raw, redirectURI, state); !errors.Is(err, testCase.want) {
				t.Fatalf("parseCallback() error = %v, want %v", err, testCase.want)
			}
		})
	}
}
