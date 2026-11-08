package grokoauth

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
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/tokenrefresh"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

var testNow = time.Unix(1_760_000_000, 0).UTC()

func testPayload(expiresAt time.Time) string {
	return fmt.Sprintf(
		`{"auth":{"grok-cli::client-1":{"key":"old-access","refresh_token":"old-refresh","user_id":"user-1","email":"g@example.com","expires_at":%q}}}`,
		tokenrefresh.ISOString(expiresAt),
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

func authOf(t *testing.T, credential accountapp.Credential) map[string]any {
	t.Helper()
	native := credential.(*accountcore.NativeCredential)
	document, err := tokenrefresh.DecodeDocument(native.Payload())
	if err != nil {
		t.Fatalf("DecodeDocument() error = %v", err)
	}
	auth := tokenrefresh.Object(document["auth"])
	if auth == nil {
		t.Fatalf("auth missing: %s", native.Payload())
	}
	return auth
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

func TestRefreshWritesBackToSameProfile(t *testing.T) {
	var form url.Values
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(io.LimitReader(request.Body, 1<<20))
		form, _ = url.ParseQuery(string(raw))
		if request.Method != http.MethodPost || request.URL.Path != "/oauth2/token" {
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Content-Type") != "application/x-www-form-urlencoded" {
			t.Errorf("content type = %q", request.Header.Get("Content-Type"))
		}
		_, _ = io.WriteString(writer, `{"access_token":"new-access","refresh_token":"new-refresh","expires_in":7200}`)
	}))
	defer server.Close()

	original := newCredential(t, testPayload(testNow.Add(-time.Minute)))
	identityBefore := original.IdentitySeed()
	refreshed, err := newTestProvider(t, server.URL+"/oauth2/token").
		Refresh(context.Background(), original)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if refreshed.IdentitySeed() != identityBefore {
		t.Fatalf("identity changed: %q -> %q", identityBefore, refreshed.IdentitySeed())
	}
	profile := tokenrefresh.Object(authOf(t, refreshed)["grok-cli::client-1"])
	if profile == nil {
		t.Fatalf("profile missing: %s", refreshed.(*accountcore.NativeCredential).Payload())
	}
	if profile["key"] != "new-access" ||
		profile["refresh_token"] != "new-refresh" ||
		profile["user_id"] != "user-1" ||
		profile["email"] != "g@example.com" {
		t.Fatalf("profile = %#v", profile)
	}
	if got, ok := tokenrefresh.TimestampMS(profile["expires_at"]); !ok ||
		!got.Equal(testNow.Add(2*time.Hour)) {
		t.Fatalf("expires_at = %#v", profile["expires_at"])
	}
	if form.Get("grant_type") != "refresh_token" ||
		form.Get("client_id") != "client-1" ||
		form.Get("refresh_token") != "old-refresh" {
		t.Fatalf("form = %#v", form)
	}
}

func TestRefreshKeepsDocumentOrderWhenMultipleProfiles(t *testing.T) {
	payload := `{"auth":{
		"a::client-a":{"key":"first-access","refresh_token":"first-refresh","user_id":"user-a","expires_at":"2030-01-01T00:00:00.000Z"},
		"b::client-b":{"key":"second-access","refresh_token":"second-refresh","user_id":"user-b","expires_at":"2030-01-01T00:00:00.000Z"}
	}}`
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(writer, `{"access_token":"rotated-access","refresh_token":"rotated-refresh"}`)
	}))
	defer server.Close()

	refreshed, err := newTestProvider(t, server.URL).Refresh(
		context.Background(),
		newCredential(t, payload),
	)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	auth := authOf(t, refreshed)
	first := tokenrefresh.Object(auth["a::client-a"])
	second := tokenrefresh.Object(auth["b::client-b"])
	if first["key"] != "rotated-access" ||
		first["refresh_token"] != "rotated-refresh" {
		t.Fatalf("first profile = %#v", first)
	}
	if second["key"] != "second-access" || second["refresh_token"] != "second-refresh" {
		t.Fatalf("second profile was modified: %#v", second)
	}
}

func TestRefreshFallsBackToClientIDFromProfileKey(t *testing.T) {
	var form url.Values
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(io.LimitReader(request.Body, 1<<20))
		form, _ = url.ParseQuery(string(raw))
		_, _ = io.WriteString(writer, `{"access_token":"new-access"}`)
	}))
	defer server.Close()

	payload := `{"auth":{"scope::client-from-key":{"key":"old-access","refresh_token":"old-refresh","user_id":"user-1"}}}`
	if _, err := newTestProvider(t, server.URL).Refresh(
		context.Background(),
		newCredential(t, payload),
	); err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if form.Get("client_id") != "client-from-key" {
		t.Fatalf("client_id = %q", form.Get("client_id"))
	}
}

func TestExpiresAtPrefersJWTExp(t *testing.T) {
	claims, _ := json.Marshal(map[string]any{"exp": testNow.Add(2 * time.Hour).Unix()})
	token := "eyJhbGciOiJub25lIn0." + base64.RawURLEncoding.EncodeToString(claims) + ".sig"
	payload := fmt.Sprintf(
		`{"auth":{"p::c":{"key":%q,"refresh_token":"r","user_id":"u","expires_at":"2020-01-01T00:00:00.000Z"}}}`,
		token,
	)
	expiresAt, ok := newTestProvider(t, "http://127.0.0.1:1").
		ExpiresAt(newCredential(t, payload))
	if !ok || !expiresAt.Equal(testNow.Add(2*time.Hour)) {
		t.Fatalf("expiresAt = %s, ok = %v", expiresAt, ok)
	}
}

func TestExpiresAtUnknownReturnsFalse(t *testing.T) {
	payload := `{"auth":{"p::c":{"key":"opaque-access","refresh_token":"r","user_id":"u"}}}`
	if _, ok := newTestProvider(t, "http://127.0.0.1:1").
		ExpiresAt(newCredential(t, payload)); ok {
		t.Fatal("opaque token without expiry must not be reported as refreshable")
	}
}

func TestRefreshUnauthorizedNeedsReauthentication(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusUnauthorized)
		_, _ = io.WriteString(writer, `{"error":"invalid_grant"}`)
	}))
	defer server.Close()

	_, err := newTestProvider(t, server.URL).Refresh(
		context.Background(),
		newCredential(t, testPayload(testNow.Add(-time.Minute))),
	)
	if !errors.Is(err, accountcredentials.ErrReauthenticationRequired) {
		t.Fatalf("error = %v", err)
	}
}
