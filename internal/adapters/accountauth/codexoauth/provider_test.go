package codexoauth

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

const (
	testAccessToken  = "synthetic-codex-oauth-access"
	testRefreshToken = "synthetic-codex-oauth-refresh"
)

// TestProviderBuildsOfficialFlowAndArtifacts 验证 Codex 官方 URL、Token 请求和 auth.json 产物。
func TestProviderBuildsOfficialFlowAndArtifacts(t *testing.T) {
	t.Parallel()

	var tokenCalls atomic.Int32
	tokenServer := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			tokenCalls.Add(1)
			if request.Method != http.MethodPost ||
				request.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
				t.Fatalf("token request = %s %s", request.Method, request.Header.Get("Content-Type"))
			}
			if err := request.ParseForm(); err != nil {
				t.Fatalf("ParseForm() error = %v", err)
			}
			assertFormValue(t, request.Form, "grant_type", "authorization_code")
			assertFormValue(t, request.Form, "code", "official-codex-code")
			assertFormValue(t, request.Form, "redirect_uri", redirectURI)
			assertFormValue(t, request.Form, "client_id", clientID)
			expectedVerifier := base64.RawURLEncoding.EncodeToString(
				bytes.Repeat([]byte{0x11}, 64),
			)
			assertFormValue(t, request.Form, "code_verifier", expectedVerifier)
			writeJSON(t, response, map[string]any{
				"id_token":      codexTestJWT(t),
				"access_token":  testAccessToken,
				"refresh_token": testRefreshToken,
			})
		},
	))
	defer tokenServer.Close()

	provider := newTestProvider(t, tokenServer.URL)
	oauthFlow, err := provider.Begin(context.Background())
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	authorizationURL, err := url.Parse(oauthFlow.AuthorizationURL())
	if err != nil {
		t.Fatalf("url.Parse() error = %v", err)
	}
	assertAuthorizationQuery(t, authorizationURL.Query())
	state := authorizationURL.Query().Get("state")

	artifacts, err := oauthFlow.Exchange(
		context.Background(),
		redirectURI+"?code=official-codex-code&state="+url.QueryEscape(state),
	)
	if err != nil {
		t.Fatalf("Exchange() error = %v", err)
	}
	if tokenCalls.Load() != 1 {
		t.Fatalf("token calls = %d", tokenCalls.Load())
	}
	credential, profile, err := nativeaccount.NewDecoder().Decode("codex", artifacts)
	if err != nil {
		t.Fatalf("nativeaccount.Decode() error = %v", err)
	}
	auth, valid := credential.(*codex.OAuthAuth)
	if !valid ||
		auth.AccessToken() != testAccessToken ||
		auth.RefreshToken() != testRefreshToken ||
		auth.AccountID() != "codex-test-workspace" ||
		auth.Email() != "codex-oauth@example.invalid" ||
		auth.RefreshedAtMS() != testClock().UnixMilli() ||
		profile == nil {
		t.Fatalf("decoded Codex OAuth = %T %#v", credential, profile)
	}
}

// TestProviderRejectsStateMismatchBeforeTokenExchange 验证错误 state 不会触发上游请求。
func TestProviderRejectsStateMismatchBeforeTokenExchange(t *testing.T) {
	t.Parallel()

	var tokenCalls atomic.Int32
	tokenServer := httptest.NewServer(http.HandlerFunc(
		func(http.ResponseWriter, *http.Request) {
			tokenCalls.Add(1)
		},
	))
	defer tokenServer.Close()

	oauthFlow, err := newTestProvider(t, tokenServer.URL).Begin(context.Background())
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	_, err = oauthFlow.Exchange(
		context.Background(),
		redirectURI+"?code=must-not-be-sent&state=wrong-state",
	)
	if !errors.Is(err, accountauth.ErrStateMismatch) {
		t.Fatalf("Exchange() error = %v", err)
	}
	if tokenCalls.Load() != 0 {
		t.Fatalf("state mismatch token calls = %d", tokenCalls.Load())
	}
}

// TestProviderRedactsRejectedTokenResponse 验证上游错误体不会进入返回错误。
func TestProviderRedactsRejectedTokenResponse(t *testing.T) {
	t.Parallel()

	tokenServer := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, _ *http.Request) {
			response.WriteHeader(http.StatusBadRequest)
			_, _ = response.Write([]byte(`{"error":"secret-token-body"}`))
		},
	))
	defer tokenServer.Close()

	oauthFlow, err := newTestProvider(t, tokenServer.URL).Begin(context.Background())
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	authorizationURL, _ := url.Parse(oauthFlow.AuthorizationURL())
	_, err = oauthFlow.Exchange(
		context.Background(),
		redirectURI+"?code=rejected&state="+url.QueryEscape(
			authorizationURL.Query().Get("state"),
		),
	)
	if !errors.Is(err, accountauth.ErrProviderRejected) {
		t.Fatalf("Exchange() error = %v", err)
	}
	if strings.Contains(fmt.Sprint(err), "secret-token-body") {
		t.Fatal("Provider 错误泄漏上游响应体")
	}
}

// newTestProvider 创建使用确定性随机源和本地 token endpoint 的 Codex Strategy。
func newTestProvider(t *testing.T, tokenURL string) *Provider {
	t.Helper()

	randomBytes := append(
		bytes.Repeat([]byte{0x11}, 64),
		bytes.Repeat([]byte{0x22}, 32)...,
	)
	provider, err := newProvider(providerOptions{
		client:            &http.Client{Timeout: time.Second},
		clock:             testClock,
		random:            bytes.NewReader(randomBytes),
		authorizeEndpoint: authorizeEndpoint,
		tokenEndpoint:     tokenURL,
		redirectURI:       redirectURI,
	})
	if err != nil {
		t.Fatalf("newProvider() error = %v", err)
	}
	return provider
}

// testClock 返回 auth.json 断言使用的固定刷新时间。
func testClock() time.Time {
	return time.Date(2026, 7, 27, 13, 0, 0, 0, time.UTC)
}

// assertAuthorizationQuery 校验 Codex 官方授权参数及固定值。
func assertAuthorizationQuery(t *testing.T, query url.Values) {
	t.Helper()

	expected := map[string]string{
		"response_type":              "code",
		"client_id":                  clientID,
		"redirect_uri":               redirectURI,
		"scope":                      oauthScope,
		"code_challenge_method":      "S256",
		"id_token_add_organizations": "true",
		"codex_cli_simplified_flow":  "true",
		"originator":                 "codex_cli_rs",
	}
	for key, value := range expected {
		assertFormValue(t, query, key, value)
	}
	if query.Get("state") == "" || query.Get("code_challenge") == "" {
		t.Fatalf("授权 URL 缺少随机参数: %s", query.Encode())
	}
	if len(query) != len(expected)+2 {
		t.Fatalf("授权 URL 出现额外参数: %s", query.Encode())
	}
}

// assertFormValue 校验单值 URL 参数。
func assertFormValue(
	t *testing.T,
	values url.Values,
	key string,
	expected string,
) {
	t.Helper()

	if len(values[key]) != 1 || values.Get(key) != expected {
		t.Fatalf("%s = %#v, want %q", key, values[key], expected)
	}
}

// codexTestJWT 创建可信本地 token endpoint 使用的合成 ID Token。
func codexTestJWT(t *testing.T) string {
	t.Helper()

	header, err := json.Marshal(map[string]any{"alg": "none", "typ": "JWT"})
	if err != nil {
		t.Fatalf("json.Marshal(header) error = %v", err)
	}
	payload, err := json.Marshal(map[string]any{
		"sub":   "codex-test-user",
		"email": "codex-oauth@example.invalid",
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_account_id": "codex-test-workspace",
			"chatgpt_plan_type":  "team",
		},
	})
	if err != nil {
		t.Fatalf("json.Marshal(payload) error = %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}

// writeJSON 写入 fake upstream 的 JSON 响应。
func writeJSON(t *testing.T, response http.ResponseWriter, document any) {
	t.Helper()

	response.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(response).Encode(document); err != nil {
		t.Fatalf("json.Encode() error = %v", err)
	}
}
