package geminioauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/tokenrefresh"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

// testNow 是固定刷新时刻，便于断言 expires_at 与 last_refresh。
var testNow = time.Unix(1_760_000_000, 0).UTC()

func testPayload(expiryMS int64) string {
	return fmt.Sprintf(
		`{"googleAccounts":{"active":"user@example.com"},"oauthCreds":{"access_token":"old-access","refresh_token":"old-refresh","token_type":"Bearer","scope":"cloud-platform","expiry_date":%d,"client_id":"client-1"}}`,
		expiryMS,
	)
}

// payloadWithToken 生成只有 access_token 的最简快照，用于 JWT 过期回退测试。
func payloadWithToken(token string) string {
	return fmt.Sprintf(
		`{"googleAccounts":{"active":"user@example.com"},"oauthCreds":{"access_token":%q,"refresh_token":"refresh"}}`,
		token,
	)
}

func payloadWith(extra string) string {
	return fmt.Sprintf(
		`{"googleAccounts":{"active":"user@example.com"},"oauthCreds":{"access_token":"token","refresh_token":"refresh"%s}}`,
		extra,
	)
}

func newCredential(t *testing.T, payload string) *accountcore.NativeCredential {
	t.Helper()
	credential, err := nativeaccount.NewDecoder().DecodeNativeAuth(providerID, []byte(payload))
	if err != nil {
		t.Fatalf("DecodeNativeAuth() error = %v", err)
	}
	native, ok := credential.(*accountcore.NativeCredential)
	if !ok || native == nil {
		t.Fatalf("credential type = %T", credential)
	}
	return native
}

func oauthOf(t *testing.T, credential accountapp.Credential) map[string]any {
	t.Helper()
	native := credential.(*accountcore.NativeCredential)
	document, err := tokenrefresh.DecodeDocument(native.Payload())
	if err != nil {
		t.Fatalf("DecodeDocument() error = %v", err)
	}
	oauth := tokenrefresh.Object(document["oauthCreds"])
	if oauth == nil {
		t.Fatalf("oauthCreds missing: %s", native.Payload())
	}
	return oauth
}

func newTestProvider(t *testing.T, endpoint string) *Provider {
	t.Helper()
	provider, err := New(
		&http.Client{Timeout: 5 * time.Second},
		Options{TokenEndpoint: endpoint, Clock: func() time.Time { return testNow }},
	)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return provider
}

func TestRefreshWritesOAuthCredentials(t *testing.T) {
	var mutex sync.Mutex
	var requestBody map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(io.LimitReader(request.Body, 1<<20))
		mutex.Lock()
		requestBody = map[string]string{}
		_ = json.Unmarshal(raw, &requestBody)
		mutex.Unlock()
		if request.Method != http.MethodPost || request.URL.Path != "/token" {
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Content-Type") != "application/json" {
			t.Errorf("content type = %q", request.Header.Get("Content-Type"))
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"access_token":"new-access","refresh_token":"new-refresh","expires_in":3600,"token_type":"Bearer","scope":"cloud-platform"}`)
	}))
	defer server.Close()

	original := newCredential(t, testPayload(testNow.Add(-time.Minute).UnixMilli()))
	payloadBefore := string(original.Payload())
	identityBefore := original.IdentitySeed()
	provider := newTestProvider(t, server.URL+"/token")

	refreshedCredential, err := provider.Refresh(context.Background(), original)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if string(original.Payload()) != payloadBefore {
		t.Fatal("Refresh() mutated the input credential payload")
	}
	if refreshedCredential.IdentitySeed() != identityBefore {
		t.Fatalf("identity changed: %q -> %q", identityBefore, refreshedCredential.IdentitySeed())
	}
	oauth := oauthOf(t, refreshedCredential)
	if oauth["access_token"] != "new-access" ||
		oauth["refresh_token"] != "new-refresh" ||
		oauth["token_type"] != "Bearer" ||
		oauth["scope"] != "cloud-platform" ||
		oauth["client_id"] != "client-1" {
		t.Fatalf("oauthCreds = %#v", oauth)
	}
	wantExpiry := testNow.Add(time.Hour).UnixMilli()
	if got, ok := tokenrefresh.TimestampMS(oauth["expires_at"]); !ok || got.UnixMilli() != wantExpiry {
		t.Fatalf("expires_at = %#v, want %d", oauth["expires_at"], wantExpiry)
	}
	if got, ok := tokenrefresh.TimestampMS(oauth["expiry_date"]); !ok || got.UnixMilli() != wantExpiry {
		t.Fatalf("expiry_date = %#v, want %d", oauth["expiry_date"], wantExpiry)
	}
	if oauth["expiry"] != tokenrefresh.ISOString(testNow.Add(time.Hour)) {
		t.Fatalf("expiry = %#v", oauth["expiry"])
	}
	if oauth["last_refresh"] != tokenrefresh.ISOString(testNow) {
		t.Fatalf("last_refresh = %#v", oauth["last_refresh"])
	}

	mutex.Lock()
	defer mutex.Unlock()
	if requestBody["client_id"] != "client-1" ||
		requestBody["client_secret"] != defaultClientSecret ||
		requestBody["refresh_token"] != "old-refresh" ||
		requestBody["grant_type"] != "refresh_token" {
		t.Fatalf("request body = %#v", requestBody)
	}
}

func TestRefreshKeepsRefreshTokenWhenResponseOmitsIt(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(writer, `{"access_token":"new-access","expires_in":3600}`)
	}))
	defer server.Close()

	refreshed, err := newTestProvider(t, server.URL).Refresh(
		context.Background(),
		newCredential(t, testPayload(testNow.Add(-time.Minute).UnixMilli())),
	)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if got := oauthOf(t, refreshed)["refresh_token"]; got != "old-refresh" {
		t.Fatalf("refresh_token = %#v", got)
	}
}

func TestExpiresAtReadsEveryHistoricalShape(t *testing.T) {
	expiresAt := testNow.Add(90 * time.Minute)
	jwt := func(expiryUnix int64) string {
		claims, _ := json.Marshal(map[string]any{"exp": expiryUnix})
		return "eyJhbGciOiJub25lIn0." +
			base64.RawURLEncoding.EncodeToString(claims) + ".sig"
	}
	cases := []struct {
		name    string
		payload string
		want    time.Time
		ok      bool
	}{
		{"expires_at 毫秒", payloadWith(fmt.Sprintf(`,"expires_at":%d`, expiresAt.UnixMilli())), expiresAt, true},
		{"expiry_date 秒", payloadWith(fmt.Sprintf(`,"expiry_date":%d`, expiresAt.Unix())), expiresAt, true},
		{"expiry ISO", payloadWith(fmt.Sprintf(`,"expiry":%q`, expiresAt.Format(time.RFC3339))), expiresAt, true},
		{"JWT exp 回退", payloadWithToken(jwt(expiresAt.Unix())), expiresAt, true},
		{"未知", payloadWith(""), time.Time{}, false},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got, ok := newTestProvider(t, "http://127.0.0.1:1/token").
				ExpiresAt(newCredential(t, testCase.payload))
			if ok != testCase.ok {
				t.Fatalf("ok = %v, want %v (payload %s)", ok, testCase.ok, testCase.payload)
			}
			if ok && !got.Equal(testCase.want) {
				t.Fatalf("expiresAt = %s, want %s", got, testCase.want)
			}
		})
	}
}

func TestExpiresAtTreatsMissingAccessTokenAsDue(t *testing.T) {
	payload := `{"googleAccounts":{"active":"user@example.com"},"oauthCreds":{"refresh_token":"refresh"}}`
	expiresAt, ok := newTestProvider(t, "http://127.0.0.1:1").
		ExpiresAt(newCredential(t, payload))
	if !ok || !expiresAt.Before(testNow) {
		t.Fatalf("expiresAt = %s, ok = %v", expiresAt, ok)
	}
}

func TestRefreshRequiresRefreshToken(t *testing.T) {
	provider := newTestProvider(t, "http://127.0.0.1:1/token")
	credential := newCredential(t, `{"googleAccounts":{"active":"user@example.com"},"oauthCreds":{"access_token":"token","expiry_date":1}}`)
	_, err := provider.Refresh(context.Background(), credential)
	if !errors.Is(err, accountcredentials.ErrReauthenticationRequired) {
		t.Fatalf("error = %v", err)
	}
}

func TestRefreshClassifiesInvalidGrant(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(writer, `{"error":"invalid_grant","error_description":"Token has been expired or revoked."}`)
	}))
	defer server.Close()

	_, err := newTestProvider(t, server.URL).Refresh(
		context.Background(),
		newCredential(t, testPayload(testNow.Add(-time.Minute).UnixMilli())),
	)
	if !errors.Is(err, accountcredentials.ErrReauthenticationRequired) {
		t.Fatalf("error = %v", err)
	}
	if strings.Contains(err.Error(), "old-refresh") {
		t.Fatalf("error leaks refresh token: %v", err)
	}
}
