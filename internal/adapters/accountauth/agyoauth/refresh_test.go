package agyoauth

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync/atomic"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/core/accounts/agy"
)

func TestProviderRefreshesAgyOAuthAndPreservesStableIdentity(t *testing.T) {
	t.Parallel()

	var requestForm url.Values
	server := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			if request.Method != http.MethodPost ||
				request.Header.Get("Content-Type") != "application/x-www-form-urlencoded" ||
				request.Header.Get("Accept-Encoding") != "identity" {
				t.Fatalf("refresh request = %s %#v", request.Method, request.Header)
			}
			body, err := io.ReadAll(request.Body)
			if err != nil {
				t.Fatalf("ReadAll() error = %v", err)
			}
			requestForm, err = url.ParseQuery(string(body))
			if err != nil {
				t.Fatalf("ParseQuery() error = %v", err)
			}
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"access_token":"agy-access-new","refresh_token":"agy-refresh-new","expires_in":3600,"token_type":"Bearer"}`))
		},
	))
	defer server.Close()

	provider := newTestProvider(t, server.URL)
	initial := testCredential(t)
	expiresAt, refreshable := provider.ExpiresAt(initial)
	if !refreshable || expiresAt.UnixMilli() != initial.ExpiresAtMS() {
		t.Fatalf("ExpiresAt() = %s, %t", expiresAt, refreshable)
	}
	refreshedAt := testTime()
	credential, err := provider.Refresh(context.Background(), initial, refreshedAt)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	refreshed, ok := credential.(*agy.OAuthAuth)
	if !ok ||
		refreshed.AccessToken() != "agy-access-new" ||
		refreshed.RefreshToken() != "agy-refresh-new" ||
		refreshed.ExpiresAtMS() != refreshedAt.Add(time.Hour).UnixMilli() ||
		refreshed.RefreshedAtMS() != refreshedAt.UnixMilli() ||
		refreshed.Email() != initial.Email() ||
		refreshed.IdentitySeed() != initial.IdentitySeed() ||
		refreshed.AuthMethod() != agy.AuthMethodConsumer {
		t.Fatalf("refreshed credential = %T %#v", credential, credential)
	}
	want := map[string]string{
		"client_id":     provider.clientCredential.clientID,
		"client_secret": provider.clientCredential.clientSecret,
		"refresh_token": initial.RefreshToken(),
		"grant_type":    "refresh_token",
	}
	if len(requestForm) != len(want) {
		t.Fatalf("request form = %#v", requestForm)
	}
	for key, value := range want {
		if requestForm.Get(key) != value {
			t.Fatalf("request form[%s] = %q", key, requestForm.Get(key))
		}
	}
}

func TestProviderClassifiesAgyRefreshFailuresWithoutLeakingBody(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		status int
		body   string
		want   error
	}{
		{name: "invalid grant", status: http.StatusBadRequest, body: `{"error":"invalid_grant","error_description":"token secret"}`, want: accountcredentials.ErrReauthenticationRequired},
		{name: "rate limit", status: http.StatusTooManyRequests, body: `{"error":"rate_limited"}`, want: accountcredentials.ErrRefreshUnavailable},
		{name: "invalid response", status: http.StatusOK, body: `{"access_token":""}`, want: accountcredentials.ErrInvalidRefreshResult},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(
				func(response http.ResponseWriter, _ *http.Request) {
					response.WriteHeader(test.status)
					_, _ = response.Write([]byte(test.body))
				},
			))
			defer server.Close()
			_, err := newTestProvider(t, server.URL).Refresh(
				context.Background(),
				testCredential(t),
				testTime(),
			)
			if !errors.Is(err, test.want) {
				t.Fatalf("Refresh() error = %v, want %v", err, test.want)
			}
		})
	}
}

func TestProviderRejectsNonAgyCredentialWithoutNetwork(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		calls.Add(1)
	}))
	defer server.Close()
	provider := newTestProvider(t, server.URL)
	if _, err := provider.Refresh(context.Background(), nil, testTime()); !errors.Is(err, accountcredentials.ErrInvalidRefreshResult) {
		t.Fatalf("Refresh(nil) error = %v", err)
	}
	if calls.Load() != 0 {
		t.Fatalf("invalid credential network calls = %d", calls.Load())
	}
}

func newTestProvider(t *testing.T, endpoint string) *Provider {
	t.Helper()
	provider, err := newProvider(&http.Client{Timeout: time.Second}, endpoint)
	if err != nil {
		t.Fatalf("newProvider() error = %v", err)
	}
	return provider
}

func testCredential(t *testing.T) *agy.OAuthAuth {
	t.Helper()
	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "agy@example.com",
		AccessToken:   "agy-access-old",
		RefreshToken:  "agy-refresh-old",
		ExpiresAtMS:   testTime().Add(-time.Minute).UnixMilli(),
		RefreshedAtMS: testTime().Add(-time.Hour).UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return auth
}

func testTime() time.Time {
	return time.Date(2026, 8, 14, 1, 0, 0, 0, time.UTC)
}
