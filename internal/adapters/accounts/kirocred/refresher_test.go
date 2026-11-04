package kirocred

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/kiro"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

const testRegion = "us-east-1"
const testEndpoint = "https://codewhisperer.us-east-1.amazonaws.com"

func testNativeCredential(t *testing.T, flavor string, expiresAt time.Time) accountapp.Credential {
	t.Helper()
	auth := map[string]any{
		"access_token":  "aoa-old",
		"refresh_token": "aor-old",
		"expires_at":    expiresAt.UTC().Format("2006-01-02T15:04:05.000Z"),
		"region":        testRegion,
	}
	document := map[string]any{
		"auth": auth,
		"identityEvidence": map[string]any{
			"version":      1,
			"source":       "aws-codewhisperer:GetUsageLimits",
			"endpoint":     testEndpoint,
			"subject":      "d-1",
			"tokenBinding": "placeholder",
			"observedAtMs": 1_700_000_000_000,
		},
		"flavor": flavor,
	}
	if flavor == "oidc" {
		document["registration"] = map[string]any{
			"clientId":     "client-id",
			"clientSecret": "client-secret",
			"region":       testRegion,
		}
	} else {
		document["profileArn"] = "arn:aws:codewhisperer:us-east-1:123:profile/OLD"
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var parsed map[string]json.RawMessage
	_ = json.Unmarshal(encoded, &parsed)
	var parsedAuth map[string]json.RawMessage
	_ = json.Unmarshal(parsed["auth"], &parsedAuth)
	if !kiro.RebindIdentityEvidence(parsed, parsedAuth) {
		t.Fatal("rebind failed")
	}
	payload, _ := json.Marshal(parsed)
	credential, err := nativeaccount.NewDecoder().DecodeNativeAuth("kiro", payload)
	if err != nil {
		t.Fatalf("DecodeNativeAuth() error = %v", err)
	}
	return credential
}

type fakeStore struct {
	snapshot     accountapp.CredentialSnapshot
	current      accountapp.CredentialSnapshot
	replaceError error
	replaced     accountapp.CredentialReplacement
	replaceCalls int
}

func (store *fakeStore) GetCredentialSnapshot(context.Context, accountcore.AccountRef) (accountapp.CredentialSnapshot, error) {
	return store.snapshot, nil
}

func (store *fakeStore) ReplaceCredential(_ context.Context, replacement accountapp.CredentialReplacement) error {
	store.replaceCalls++
	if store.replaceError != nil {
		store.snapshot = store.current
		return store.replaceError
	}
	store.replaced = replacement
	store.snapshot = store.current
	return nil
}

func newSnapshot(t *testing.T, credential accountapp.Credential, updatedAt time.Time) accountapp.CredentialSnapshot {
	t.Helper()
	ref, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	snapshot, err := accountapp.NewCredentialSnapshot(ref, "kiro", credential, updatedAt)
	if err != nil {
		t.Fatalf("NewCredentialSnapshot() error = %v", err)
	}
	return snapshot
}

func TestRefresherSkipsFreshTokens(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	credential := testNativeCredential(t, "oidc", now.Add(time.Hour))
	store := &fakeStore{snapshot: newSnapshot(t, credential, now.Add(-time.Minute))}
	refresher, err := New(store, http.DefaultClient, func() time.Time { return now })
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	result, err := refresher.RefreshCredential(context.Background(), store.snapshot)
	if err != nil {
		t.Fatalf("RefreshCredential() error = %v", err)
	}
	if store.replaceCalls != 0 || result.UpdatedAt() != store.snapshot.UpdatedAt() {
		t.Fatalf("replaceCalls = %d", store.replaceCalls)
	}
}

func TestRefresherUsesOIDCForDeviceRegistration(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	credential := testNativeCredential(t, "oidc", now.Add(-time.Minute))
	store := &fakeStore{snapshot: newSnapshot(t, credential, now.Add(-time.Minute))}
	var requestBody map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		payload, _ := io.ReadAll(request.Body)
		_ = json.Unmarshal(payload, &requestBody)
		_, _ = response.Write([]byte(`{"accessToken":"aoa-new","refreshToken":"aor-new","expiresIn":3600}`))
	}))
	defer server.Close()
	refresher, err := New(store, server.Client(), func() time.Time { return now })
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	refresher.oidcURL = func(string) string { return server.URL }
	result, err := refresher.RefreshCredential(context.Background(), store.snapshot)
	if err != nil {
		t.Fatalf("RefreshCredential() error = %v", err)
	}
	if requestBody["clientId"] != "client-id" || requestBody["grantType"] != "refresh_token" {
		t.Fatalf("body = %#v", requestBody)
	}
	if store.replaceCalls != 1 {
		t.Fatalf("replaceCalls = %d", store.replaceCalls)
	}
	native := result.Credential().(*accountcore.NativeCredential)
	parsed, err := kiro.ParseCredential(native.Payload())
	if err != nil {
		t.Fatalf("ParseCredential() error = %v", err)
	}
	if parsed.AccessToken() != "aoa-new" || parsed.RefreshToken() != "aor-new" {
		t.Fatalf("tokens = %q / %q", parsed.AccessToken(), parsed.RefreshToken())
	}
	if !parsed.ExpiresAt().Equal(now.Add(time.Hour)) {
		t.Fatalf("expiresAt = %v", parsed.ExpiresAt())
	}
	beforeSeed := credential.IdentitySeed()
	if result.Credential().IdentitySeed() != beforeSeed {
		t.Fatalf("identity seed changed")
	}
	if !strings.Contains(string(native.Payload()), "aoa-new") {
		t.Fatal("payload not updated")
	}
}

func TestRefresherUsesDesktopEndpointAndKeepsProfileARN(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	credential := testNativeCredential(t, "desktop", now.Add(-time.Minute))
	store := &fakeStore{snapshot: newSnapshot(t, credential, now.Add(-time.Minute))}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = response.Write([]byte(`{"accessToken":"aoa-d","expiresIn":1800,"profileArn":"arn:aws:codewhisperer:us-east-1:123:profile/NEW"}`))
	}))
	defer server.Close()
	refresher, err := New(store, server.Client(), func() time.Time { return now })
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	refresher.desktopURL = func(string) string { return server.URL }
	result, err := refresher.RefreshCredential(context.Background(), store.snapshot)
	if err != nil {
		t.Fatalf("RefreshCredential() error = %v", err)
	}
	native := result.Credential().(*accountcore.NativeCredential)
	parsed, err := kiro.ParseCredential(native.Payload())
	if err != nil {
		t.Fatalf("ParseCredential() error = %v", err)
	}
	if !strings.HasSuffix(parsed.ProfileARN(), "profile/NEW") {
		t.Fatalf("profileARN = %q", parsed.ProfileARN())
	}
	if parsed.RefreshToken() != "aor-old" {
		t.Fatalf("refresh token should be preserved, got %q", parsed.RefreshToken())
	}
}

func TestRefresherReturnsWinningSnapshotOnConflict(t *testing.T) {
	t.Parallel()
	now := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	credential := testNativeCredential(t, "oidc", now.Add(-time.Minute))
	winner := testNativeCredential(t, "oidc", now.Add(time.Hour))
	store := &fakeStore{
		snapshot:     newSnapshot(t, credential, now.Add(-time.Minute)),
		current:      newSnapshot(t, winner, now.Add(-30*time.Second)),
		replaceError: accountapp.ErrCredentialConflict,
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = response.Write([]byte(`{"accessToken":"aoa-new","expiresIn":3600}`))
	}))
	defer server.Close()
	refresher, err := New(store, server.Client(), func() time.Time { return now })
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	refresher.oidcURL = func(string) string { return server.URL }
	result, err := refresher.RefreshCredential(context.Background(), store.snapshot)
	if err != nil {
		t.Fatalf("RefreshCredential() error = %v", err)
	}
	if !result.UpdatedAt().Equal(store.current.UpdatedAt()) {
		t.Fatalf("result updatedAt = %v", result.UpdatedAt())
	}
}
