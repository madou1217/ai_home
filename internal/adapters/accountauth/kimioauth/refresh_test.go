package kimioauth

import (
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
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

const (
	// testRefreshedAtUnix 是固定的刷新时刻，便于断言 expires_at = refreshedAt + expires_in。
	testRefreshedAtUnix = int64(1_760_000_000)
	// defaultPayload 是最小可用的 kimi 登录快照：user_id 提供稳定身份，
	// device_id 让刷新请求带上与账号一致的设备指纹。
	defaultPayload = `{
		"credentials": {
			"access_token": "old-access",
			"refresh_token": "old-refresh",
			"expires_at": 1759999000,
			"token_type": "Bearer",
			"user_id": "user-1",
			"device_id": "device-123"
		},
		"deviceId": "device-123"
	}`
)

func testRefreshedAt() time.Time { return time.Unix(testRefreshedAtUnix, 0).UTC() }

// recordedRequest 只保留断言需要的事实，避免把 request body 里的令牌打进失败信息。
type recordedRequest struct {
	method string
	path   string
	header http.Header
	form   url.Values
}

// newTestServer 启动固定响应的 OAuth 端点并记录每个请求。
func newTestServer(
	t *testing.T,
	status int,
	body string,
) (*httptest.Server, func() []recordedRequest) {
	t.Helper()
	var mutex sync.Mutex
	var records []recordedRequest
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(io.LimitReader(request.Body, 1<<20))
		form, _ := url.ParseQuery(string(raw))
		mutex.Lock()
		records = append(records, recordedRequest{
			method: request.Method,
			path:   request.URL.Path,
			header: request.Header.Clone(),
			form:   form,
		})
		mutex.Unlock()
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(status)
		_, _ = io.WriteString(writer, body)
	}))
	t.Cleanup(server.Close)
	return server, func() []recordedRequest {
		mutex.Lock()
		defer mutex.Unlock()
		return append([]recordedRequest(nil), records...)
	}
}

func newTestProvider(t *testing.T, server *httptest.Server) *Provider {
	t.Helper()
	provider, err := newProvider(
		server.Client(),
		server.URL+"/api/oauth/token",
		Options{ClientVersion: "2.2.0"},
	)
	if err != nil {
		t.Fatalf("newProvider() error = %v", err)
	}
	return provider
}

func newKimiCredential(t *testing.T, payload string) *accountcore.NativeCredential {
	t.Helper()
	credential, err := nativeaccount.NewDecoder().DecodeNativeAuth("kimi", []byte(payload))
	if err != nil {
		t.Fatalf("DecodeNativeAuth() error = %v", err)
	}
	native, valid := credential.(*accountcore.NativeCredential)
	if !valid || native == nil {
		t.Fatalf("credential type = %T", credential)
	}
	return native
}

func credentialDocument(t *testing.T, native *accountcore.NativeCredential) map[string]any {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal(native.Payload(), &document); err != nil {
		t.Fatalf("payload is not a JSON object: %v", err)
	}
	return document
}

func credentialSection(t *testing.T, native *accountcore.NativeCredential) map[string]any {
	t.Helper()
	section, valid := credentialDocument(t, native)["credentials"].(map[string]any)
	if !valid {
		t.Fatalf("credentials section missing: %s", native.Payload())
	}
	return section
}

func stringField(t *testing.T, record map[string]any, key string) string {
	t.Helper()
	value, valid := record[key].(string)
	if !valid {
		t.Fatalf("field %q is not a string: %#v", key, record[key])
	}
	return value
}

func integerField(t *testing.T, record map[string]any, key string) int64 {
	t.Helper()
	value, valid := record[key].(float64)
	if !valid {
		t.Fatalf("field %q is not a number: %#v", key, record[key])
	}
	return int64(value)
}

// testJWT 构造只有 payload 有意义的未签名 JWT（服务端不校验签名，只读声明）。
func testJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal claims: %v", err)
	}
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	return header + "." + base64.RawURLEncoding.EncodeToString(payload) + ".sig"
}

func assertNoSecretLeak(t *testing.T, err error, secrets ...string) {
	t.Helper()
	for _, secret := range secrets {
		if secret != "" && strings.Contains(err.Error(), secret) {
			t.Fatalf("error leaks secret %q: %v", secret, err)
		}
	}
}

func TestRefreshRotatesTokensAndWritesBackWholeGrant(t *testing.T) {
	server, requests := newTestServer(t, http.StatusOK, `{
		"access_token": "new-access",
		"refresh_token": "new-refresh",
		"expires_in": 900,
		"token_type": "Bearer",
		"scope": "chat"
	}`)
	provider := newTestProvider(t, server)
	original := newKimiCredential(t, defaultPayload)
	identityBefore := original.IdentitySeed()
	payloadBefore := string(original.Payload())

	refreshedCredential, err := provider.Refresh(context.Background(), original, testRefreshedAt())
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if string(original.Payload()) != payloadBefore {
		t.Fatal("Refresh() mutated the input credential payload")
	}
	refreshed, valid := refreshedCredential.(*accountcore.NativeCredential)
	if !valid || refreshed == nil {
		t.Fatalf("refreshed credential type = %T", refreshedCredential)
	}
	if refreshed.ProviderID() != providerID {
		t.Fatalf("provider = %q", refreshed.ProviderID())
	}
	if refreshed.IdentitySeed() != identityBefore {
		t.Fatalf("identity changed: %q -> %q", identityBefore, refreshed.IdentitySeed())
	}

	section := credentialSection(t, refreshed)
	if stringField(t, section, "access_token") != "new-access" {
		t.Fatalf("access_token = %q", section["access_token"])
	}
	if stringField(t, section, "refresh_token") != "new-refresh" {
		t.Fatalf("refresh_token = %q", section["refresh_token"])
	}
	if got := integerField(t, section, "expires_at"); got != testRefreshedAtUnix+900 {
		t.Fatalf("expires_at = %d", got)
	}
	if got := integerField(t, section, "expires_in"); got != 900 {
		t.Fatalf("expires_in = %d", got)
	}
	if stringField(t, section, "token_type") != "Bearer" ||
		stringField(t, section, "scope") != "chat" ||
		stringField(t, section, "user_id") != "user-1" ||
		stringField(t, section, "device_id") != "device-123" {
		t.Fatalf("credentials section = %#v", section)
	}

	records := requests()
	if len(records) != 1 {
		t.Fatalf("requests = %d", len(records))
	}
	record := records[0]
	if record.method != http.MethodPost || record.path != "/api/oauth/token" {
		t.Fatalf("request = %s %s", record.method, record.path)
	}
	if record.header.Get("Content-Type") != "application/x-www-form-urlencoded" {
		t.Fatalf("content type = %q", record.header.Get("Content-Type"))
	}
	if record.header.Get("Authorization") != "" {
		t.Fatalf("authorization header must stay empty: %q", record.header.Get("Authorization"))
	}
	if record.form.Get("client_id") != clientID ||
		record.form.Get("grant_type") != "refresh_token" ||
		record.form.Get("refresh_token") != "old-refresh" {
		t.Fatalf("form = %#v", record.form)
	}
	if record.header.Get("User-Agent") != "kimi-code-cli/2.2.0" ||
		record.header.Get("X-Msh-Platform") != "kimi_code_cli" ||
		record.header.Get("X-Msh-Version") != "2.2.0" ||
		record.header.Get("X-Msh-Device-Id") != "device-123" {
		t.Fatalf("client headers = %#v", record.header)
	}
	if record.header.Get("X-Msh-Device-Name") == "" ||
		record.header.Get("X-Msh-Device-Model") == "" ||
		record.header.Get("X-Msh-Os-Version") == "" {
		t.Fatalf("device headers = %#v", record.header)
	}
}

func TestRefreshKeepsRefreshTokenWhenResponseOmitsIt(t *testing.T) {
	server, _ := newTestServer(t, http.StatusOK, `{
		"access_token": "new-access",
		"expires_in": 900
	}`)
	provider := newTestProvider(t, server)
	refreshed, err := provider.Refresh(
		context.Background(),
		newKimiCredential(t, defaultPayload),
		testRefreshedAt(),
	)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	section := credentialSection(t, refreshed.(*accountcore.NativeCredential))
	if stringField(t, section, "refresh_token") != "old-refresh" {
		t.Fatalf("refresh_token = %q", section["refresh_token"])
	}
	if stringField(t, section, "token_type") != "Bearer" {
		t.Fatalf("token_type = %q", section["token_type"])
	}
	if scope, exists := section["scope"]; !exists || scope != "" {
		t.Fatalf("scope = %#v", scope)
	}
}

func TestRefreshMergesLegacyAuthIntoCanonicalCredentials(t *testing.T) {
	server, _ := newTestServer(t, http.StatusOK, `{
		"access_token": "new-access",
		"refresh_token": "new-refresh",
		"expires_in": 900
	}`)
	provider := newTestProvider(t, server)
	original := newKimiCredential(t, `{
		"auth": {
			"access_token": "old-access",
			"refresh_token": "old-refresh",
			"expires_at": 1759999000,
			"user_id": "user-1"
		},
		"deviceId": "device-9"
	}`)
	refreshed, err := provider.Refresh(context.Background(), original, testRefreshedAt())
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	document := credentialDocument(t, refreshed.(*accountcore.NativeCredential))
	if _, exists := document["auth"]; exists {
		t.Fatalf("legacy auth section must be removed: %#v", document)
	}
	section, valid := document["credentials"].(map[string]any)
	if !valid {
		t.Fatalf("credentials section missing: %#v", document)
	}
	if stringField(t, section, "access_token") != "new-access" ||
		stringField(t, section, "refresh_token") != "new-refresh" ||
		stringField(t, section, "user_id") != "user-1" {
		t.Fatalf("credentials section = %#v", section)
	}
	if stringField(t, document, "deviceId") != "device-9" {
		t.Fatalf("deviceId = %#v", document["deviceId"])
	}
}

func TestRefreshClassifiesFailures(t *testing.T) {
	cases := []struct {
		name   string
		status int
		body   string
		want   error
	}{
		{
			name:   "invalid grant needs reauthentication",
			status: http.StatusBadRequest,
			body:   `{"error":"invalid_grant","error_description":"refresh token expired"}`,
			want:   accountcredentials.ErrReauthenticationRequired,
		},
		{
			name:   "unauthorized still needs reauthentication",
			status: http.StatusUnauthorized,
			body:   `{"error":"invalid_grant"}`,
			want:   accountcredentials.ErrReauthenticationRequired,
		},
		{
			name:   "other client error is rejected",
			status: http.StatusBadRequest,
			body:   `{"error":"invalid_request"}`,
			want:   accountcredentials.ErrRefreshRejected,
		},
		{
			name:   "server error is unavailable",
			status: http.StatusInternalServerError,
			body:   `{"error":"internal_error"}`,
			want:   accountcredentials.ErrRefreshUnavailable,
		},
		{
			name:   "bad gateway is unavailable",
			status: http.StatusBadGateway,
			body:   `<html>bad gateway</html>`,
			want:   accountcredentials.ErrRefreshUnavailable,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			server, _ := newTestServer(t, testCase.status, testCase.body)
			provider := newTestProvider(t, server)
			_, err := provider.Refresh(
				context.Background(),
				newKimiCredential(t, defaultPayload),
				testRefreshedAt(),
			)
			if !errors.Is(err, testCase.want) {
				t.Fatalf("Refresh() error = %v, want %v", err, testCase.want)
			}
			assertNoSecretLeak(t, err, "old-refresh", "old-access")
		})
	}
}

// failingClient 模拟 DNS/连接失败，验证网络错误统一归为「暂时不可用」。
type failingClient struct {
	err error
}

func (client failingClient) Do(*http.Request) (*http.Response, error) {
	return nil, client.err
}

func TestRefreshMapsTransportFailureToUnavailable(t *testing.T) {
	provider, err := newProvider(
		failingClient{err: errors.New("dial tcp: connection refused")},
		"https://auth.kimi.com/api/oauth/token",
		Options{},
	)
	if err != nil {
		t.Fatalf("newProvider() error = %v", err)
	}
	_, refreshErr := provider.Refresh(
		context.Background(),
		newKimiCredential(t, defaultPayload),
		testRefreshedAt(),
	)
	if !errors.Is(refreshErr, accountcredentials.ErrRefreshUnavailable) {
		t.Fatalf("Refresh() error = %v", refreshErr)
	}
	assertNoSecretLeak(t, refreshErr, "old-refresh", "old-access")
}

func TestRefreshRejectsInvalidResponses(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{name: "invalid json", body: `{"access_token":`},
		{name: "missing access token", body: `{"refresh_token":"new-refresh","expires_in":900}`},
		{name: "empty access token", body: `{"access_token":"","refresh_token":"new-refresh","expires_in":900}`},
		{name: "zero expires in", body: `{"access_token":"new-access","refresh_token":"new-refresh","expires_in":0}`},
		{name: "negative expires in", body: `{"access_token":"new-access","refresh_token":"new-refresh","expires_in":-1}`},
		{name: "blank refresh token", body: `{"access_token":"new-access","refresh_token":"  ","expires_in":900}`},
		{name: "oversized body", body: `{"access_token":"` + strings.Repeat("a", maxTokenBodyBytes) + `"}`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			server, _ := newTestServer(t, http.StatusOK, testCase.body)
			provider := newTestProvider(t, server)
			_, err := provider.Refresh(
				context.Background(),
				newKimiCredential(t, defaultPayload),
				testRefreshedAt(),
			)
			if !errors.Is(err, accountcredentials.ErrInvalidRefreshResult) {
				t.Fatalf("Refresh() error = %v", err)
			}
			assertNoSecretLeak(t, err, "old-refresh", "old-access")
		})
	}
}

func TestRefreshRejectsIdentityChange(t *testing.T) {
	originalToken := testJWT(t, map[string]any{"sub": "user-1", "exp": testRefreshedAtUnix + 900})
	replacementToken := testJWT(t, map[string]any{"sub": "user-2", "exp": testRefreshedAtUnix + 900})
	server, _ := newTestServer(t, http.StatusOK, fmt.Sprintf(
		`{"access_token":%q,"refresh_token":"new-refresh","expires_in":900}`,
		replacementToken,
	))
	provider := newTestProvider(t, server)
	original := newKimiCredential(t, fmt.Sprintf(
		`{"credentials":{"access_token":%q,"refresh_token":"old-refresh"}}`,
		originalToken,
	))
	_, err := provider.Refresh(context.Background(), original, testRefreshedAt())
	if !errors.Is(err, accountcredentials.ErrInvalidRefreshResult) {
		t.Fatalf("Refresh() error = %v", err)
	}
	assertNoSecretLeak(t, err, "old-refresh", originalToken, replacementToken)
}

func TestRefreshRequiresUsableRefreshToken(t *testing.T) {
	provider, err := newProvider(
		failingClient{err: errors.New("should never be called")},
		"https://auth.kimi.com/api/oauth/token",
		Options{},
	)
	if err != nil {
		t.Fatalf("newProvider() error = %v", err)
	}
	credential := newKimiCredential(t, `{"credentials":{"access_token":"old-access","user_id":"user-1"}}`)
	_, refreshErr := provider.Refresh(context.Background(), credential, testRefreshedAt())
	if !errors.Is(refreshErr, accountcredentials.ErrReauthenticationRequired) {
		t.Fatalf("Refresh() error = %v", refreshErr)
	}
}

func TestRefreshRejectsInvalidCredentials(t *testing.T) {
	provider, err := newProvider(
		failingClient{err: errors.New("should never be called")},
		"https://auth.kimi.com/api/oauth/token",
		Options{},
	)
	if err != nil {
		t.Fatalf("newProvider() error = %v", err)
	}
	credential := newKimiCredential(t, defaultPayload)
	cases := []struct {
		name       string
		credential accountapp.Credential
		at         time.Time
	}{
		{name: "nil credential", credential: nil, at: testRefreshedAt()},
		{name: "zero refreshedAt", credential: credential, at: time.Time{}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			_, refreshErr := provider.Refresh(context.Background(), testCase.credential, testCase.at)
			if !errors.Is(refreshErr, accountcredentials.ErrInvalidRefreshResult) {
				t.Fatalf("Refresh() error = %v", refreshErr)
			}
		})
	}
}

func TestExpiresAt(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		want    time.Time
		ok      bool
	}{
		{
			name:    "seconds epoch",
			payload: `{"credentials":{"access_token":"a","refresh_token":"r","user_id":"user-1","expires_at":1760000900}}`,
			want:    time.Unix(1760000900, 0).UTC(),
			ok:      true,
		},
		{
			name:    "millisecond epoch is normalized",
			payload: `{"credentials":{"access_token":"a","refresh_token":"r","user_id":"user-1","expires_at":1760000900000}}`,
			want:    time.Unix(1760000900, 0).UTC(),
			ok:      true,
		},
		{
			name:    "numeric string",
			payload: `{"credentials":{"access_token":"a","refresh_token":"r","user_id":"user-1","expires_at":"1760000900"}}`,
			want:    time.Unix(1760000900, 0).UTC(),
			ok:      true,
		},
		{
			name:    "legacy auth section",
			payload: `{"auth":{"access_token":"a","refresh_token":"r","user_id":"user-1","expires_at":1760000900}}`,
			want:    time.Unix(1760000900, 0).UTC(),
			ok:      true,
		},
		{
			name:    "missing expires_at",
			payload: `{"credentials":{"access_token":"a","refresh_token":"r","user_id":"user-1"}}`,
			ok:      false,
		},
		{
			name:    "zero expires_at",
			payload: `{"credentials":{"access_token":"a","refresh_token":"r","user_id":"user-1","expires_at":0}}`,
			ok:      false,
		},
		{
			name:    "out of range expires_at",
			payload: `{"credentials":{"access_token":"a","refresh_token":"r","user_id":"user-1","expires_at":253402300799}}`,
			ok:      false,
		},
		{
			name: "jwt exp fallback",
			payload: fmt.Sprintf(
				`{"credentials":{"access_token":%q,"refresh_token":"r"}}`,
				testJWT(t, map[string]any{"sub": "user-1", "exp": 1760000900}),
			),
			want: time.Unix(1760000900, 0).UTC(),
			ok:   true,
		},
	}
	provider, err := New(http.DefaultClient, Options{})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			credential := newKimiCredential(t, testCase.payload)
			got, ok := provider.ExpiresAt(credential)
			if ok != testCase.ok {
				t.Fatalf("ExpiresAt() ok = %v, want %v", ok, testCase.ok)
			}
			if ok && !got.Equal(testCase.want) {
				t.Fatalf("ExpiresAt() = %s, want %s", got, testCase.want)
			}
		})
	}

	if _, ok := provider.ExpiresAt(nil); ok {
		t.Fatal("ExpiresAt(nil) must not report a known expiry")
	}
}

func TestProviderIdentityAndConstructor(t *testing.T) {
	if provider := (&Provider{}); provider.ProviderID() != "kimi" {
		t.Fatalf("ProviderID() = %q", provider.ProviderID())
	}
	if _, err := New(nil, Options{}); !errors.Is(err, accountcredentials.ErrInvalidDependencies) {
		t.Fatalf("New(nil) error = %v", err)
	}
	provider, err := New(http.DefaultClient, Options{ClientVersion: "9.9.9"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if provider.tokenEndpoint != defaultTokenEndpoint || provider.version != "9.9.9" {
		t.Fatalf("provider = %#v", provider)
	}
	fallback, err := New(http.DefaultClient, Options{})
	if err != nil || fallback.version != defaultClientVersion {
		t.Fatalf("default version = %q, error = %v", fallback.version, err)
	}
}
