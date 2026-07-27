package claudeoauth

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

const (
	testAccessToken  = "sk-ant-oat01-synthetic-claude-access"
	testRefreshToken = "sk-ant-ort01-synthetic-claude-refresh"
	testAccountUUID  = "123e4567-e89b-12d3-a456-426614174444"
)

// TestProviderBuildsOfficialFlowProfileAndArtifacts 验证 Claude URL、Token、Profile 和官方产物。
func TestProviderBuildsOfficialFlowProfileAndArtifacts(t *testing.T) {
	t.Parallel()

	var tokenCalls atomic.Int32
	var profileCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			switch request.URL.Path {
			case "/token":
				tokenCalls.Add(1)
				assertTokenRequest(t, request)
				writeJSON(t, response, map[string]any{
					"access_token":  testAccessToken,
					"refresh_token": testRefreshToken,
					"expires_in":    3600,
					"scope":         "user:profile user:inference",
				})
			case "/profile":
				profileCalls.Add(1)
				if request.Method != http.MethodGet ||
					request.Header.Get("Authorization") != "Bearer "+testAccessToken {
					t.Fatalf("profile request = %s %#v", request.Method, request.Header)
				}
				writeJSON(t, response, validProfileResponse())
			default:
				http.NotFound(response, request)
			}
		},
	))
	defer upstream.Close()

	provider := newTestProvider(t, upstream.URL+"/token", upstream.URL+"/profile")
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
		"official-claude-code#"+state,
	)
	if err != nil {
		t.Fatalf("Exchange() error = %v", err)
	}
	if tokenCalls.Load() != 1 || profileCalls.Load() != 1 {
		t.Fatalf(
			"upstream calls: token=%d profile=%d",
			tokenCalls.Load(),
			profileCalls.Load(),
		)
	}
	credential, profile, err := nativeaccount.NewDecoder().Decode("claude", artifacts)
	if err != nil {
		t.Fatalf("nativeaccount.Decode() error = %v", err)
	}
	auth, valid := credential.(*claude.OAuthAuth)
	if !valid ||
		auth.AccessToken() != testAccessToken ||
		auth.RefreshToken() != testRefreshToken ||
		auth.AccountUUID() != testAccountUUID ||
		auth.ExpiresAtMS() != testClock().Add(time.Hour).UnixMilli() {
		t.Fatalf("decoded Claude OAuth = %T", credential)
	}
	accountProfile, valid := profile.(claude.AccountProfile)
	if !valid ||
		accountProfile.Email() != "claude-oauth@example.invalid" ||
		accountProfile.Subscription().Kind() != claude.SubscriptionKindMax {
		t.Fatalf("decoded Claude profile = %T %#v", profile, profile)
	}
}

// TestProviderAcceptsExactManualRedirectURL 验证完整官方回调 URL 与 code#state 共用严格状态校验。
func TestProviderAcceptsExactManualRedirectURL(t *testing.T) {
	t.Parallel()

	upstream := newSuccessfulUpstream(t)
	defer upstream.Close()
	oauthFlow, err := newTestProvider(
		t,
		upstream.URL+"/token",
		upstream.URL+"/profile",
	).Begin(context.Background())
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	authorizationURL, _ := url.Parse(oauthFlow.AuthorizationURL())
	callback := redirectURI + "?code=official-claude-code&state=" +
		url.QueryEscape(authorizationURL.Query().Get("state"))
	if _, err := oauthFlow.Exchange(context.Background(), callback); err != nil {
		t.Fatalf("Exchange(full URL) error = %v", err)
	}
}

// TestProviderFailsClosedWhenProfileCannotConfirmIdentity 验证 Profile 失败不使用 token 猜身份。
func TestProviderFailsClosedWhenProfileCannotConfirmIdentity(t *testing.T) {
	t.Parallel()

	var profileCalls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			if request.URL.Path == "/token" {
				writeJSON(t, response, map[string]any{
					"access_token":  testAccessToken,
					"refresh_token": testRefreshToken,
					"expires_in":    3600,
					"scope":         "user:profile user:inference",
				})
				return
			}
			profileCalls.Add(1)
			response.WriteHeader(http.StatusServiceUnavailable)
			_, _ = response.Write([]byte(`profile-secret-body`))
		},
	))
	defer upstream.Close()

	oauthFlow, err := newTestProvider(
		t,
		upstream.URL+"/token",
		upstream.URL+"/profile",
	).Begin(context.Background())
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	authorizationURL, _ := url.Parse(oauthFlow.AuthorizationURL())
	_, err = oauthFlow.Exchange(
		context.Background(),
		"official-claude-code#"+authorizationURL.Query().Get("state"),
	)
	if !errors.Is(err, accountauth.ErrProviderUnavailable) {
		t.Fatalf("Exchange() error = %v", err)
	}
	if profileCalls.Load() != 1 {
		t.Fatalf("profile calls = %d", profileCalls.Load())
	}
	if strings.Contains(fmt.Sprint(err), "profile-secret-body") {
		t.Fatal("Profile 错误泄漏上游响应体")
	}
}

// TestProviderRejectsStateMismatchBeforeUpstreamCalls 验证错误 state 不触发 Token 或 Profile。
func TestProviderRejectsStateMismatchBeforeUpstreamCalls(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(
		func(http.ResponseWriter, *http.Request) {
			calls.Add(1)
		},
	))
	defer upstream.Close()

	oauthFlow, err := newTestProvider(
		t,
		upstream.URL+"/token",
		upstream.URL+"/profile",
	).Begin(context.Background())
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	_, err = oauthFlow.Exchange(
		context.Background(),
		"must-not-be-sent#wrong-state",
	)
	if !errors.Is(err, accountauth.ErrStateMismatch) {
		t.Fatalf("Exchange() error = %v", err)
	}
	if calls.Load() != 0 {
		t.Fatalf("state mismatch upstream calls = %d", calls.Load())
	}
}

// newSuccessfulUpstream 创建同时提供 Token 与 Profile 的 fake OAuth 上游。
func newSuccessfulUpstream(t *testing.T) *httptest.Server {
	t.Helper()

	return httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			switch request.URL.Path {
			case "/token":
				writeJSON(t, response, map[string]any{
					"access_token":  testAccessToken,
					"refresh_token": testRefreshToken,
					"expires_in":    3600,
					"scope":         "user:profile user:inference",
				})
			case "/profile":
				writeJSON(t, response, validProfileResponse())
			default:
				http.NotFound(response, request)
			}
		},
	))
}

// newTestProvider 创建使用确定性随机源和本地端点的 Claude Strategy。
func newTestProvider(
	t *testing.T,
	tokenURL string,
	profileURL string,
) *Provider {
	t.Helper()

	randomBytes := append(
		bytes.Repeat([]byte{0x31}, 32),
		bytes.Repeat([]byte{0x32}, 32)...,
	)
	provider, err := newProvider(providerOptions{
		client:            &http.Client{Timeout: time.Second},
		clock:             testClock,
		random:            bytes.NewReader(randomBytes),
		authorizeEndpoint: authorizeEndpoint,
		tokenEndpoint:     tokenURL,
		profileEndpoint:   profileURL,
		redirectURI:       redirectURI,
	})
	if err != nil {
		t.Fatalf("newProvider() error = %v", err)
	}
	return provider
}

// testClock 返回 secure storage 过期时间断言使用的固定时间。
func testClock() time.Time {
	return time.Date(2026, 7, 27, 14, 0, 0, 0, time.UTC)
}

// assertAuthorizationQuery 校验 Claude 官方手动登录参数。
func assertAuthorizationQuery(t *testing.T, query url.Values) {
	t.Helper()

	expected := map[string]string{
		"code":                  "true",
		"client_id":             clientID,
		"response_type":         "code",
		"redirect_uri":          redirectURI,
		"scope":                 oauthScope,
		"code_challenge_method": "S256",
	}
	for key, value := range expected {
		assertQueryValue(t, query, key, value)
	}
	if query.Get("state") == "" || query.Get("code_challenge") == "" {
		t.Fatalf("授权 URL 缺少随机参数: %s", query.Encode())
	}
	if len(query) != len(expected)+2 {
		t.Fatalf("授权 URL 出现额外参数: %s", query.Encode())
	}
}

// assertTokenRequest 校验 Claude token endpoint 的 JSON 请求。
func assertTokenRequest(t *testing.T, request *http.Request) {
	t.Helper()

	if request.Method != http.MethodPost ||
		request.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("token request = %s %s", request.Method, request.Header.Get("Content-Type"))
	}
	body, err := io.ReadAll(request.Body)
	if err != nil {
		t.Fatalf("io.ReadAll() error = %v", err)
	}
	var document map[string]any
	if err := json.Unmarshal(body, &document); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	expectedVerifier := base64.RawURLEncoding.EncodeToString(
		bytes.Repeat([]byte{0x31}, 32),
	)
	expected := map[string]string{
		"grant_type":    "authorization_code",
		"code":          "official-claude-code",
		"redirect_uri":  redirectURI,
		"client_id":     clientID,
		"code_verifier": expectedVerifier,
	}
	for key, value := range expected {
		if document[key] != value {
			t.Fatalf("%s = %#v, want %q", key, document[key], value)
		}
	}
	state, valid := document["state"].(string)
	if !valid || state == "" {
		t.Fatalf("token state = %#v", document["state"])
	}
}

// validProfileResponse 返回 Claude Profile API 的完整合成响应。
func validProfileResponse() map[string]any {
	extraUsage := true
	return map[string]any{
		"account": map[string]any{
			"uuid":         testAccountUUID,
			"email":        "claude-oauth@example.invalid",
			"display_name": "Claude OAuth Test",
			"created_at":   "2025-01-02T03:04:05Z",
		},
		"organization": map[string]any{
			"uuid":                    "123e4567-e89b-12d3-a456-426614174445",
			"name":                    "Claude Test Org",
			"organization_type":       "claude_max",
			"rate_limit_tier":         "default_claude_max_20x",
			"billing_type":            "stripe_subscription",
			"has_extra_usage_enabled": extraUsage,
			"subscription_created_at": "2025-02-03T04:05:06Z",
		},
	}
}

// assertQueryValue 校验单值 URL 参数。
func assertQueryValue(
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

// writeJSON 写入 fake upstream 的 JSON 响应。
func writeJSON(t *testing.T, response http.ResponseWriter, document any) {
	t.Helper()

	response.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(response).Encode(document); err != nil {
		t.Fatalf("json.Encode() error = %v", err)
	}
}
