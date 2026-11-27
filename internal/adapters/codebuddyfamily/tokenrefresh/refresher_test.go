package tokenrefresh

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

const testUID = "23ddaff9-aa4b-485f-85de-8f152eeaabf4"

func TestForceRefreshPersistsRotatedCredential(t *testing.T) {
	store, snapshot := testSnapshot(t, 1000)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != refreshPath {
			t.Errorf("path = %s, want %s", request.URL.Path, refreshPath)
		}
		if request.Header.Get("X-Refresh-Token") == "" || request.Header.Get("X-Auth-Refresh-Source") != "plugin" {
			t.Errorf("missing official refresh headers")
		}
		payload, _ := json.Marshal(map[string]any{
			"code": 0,
			"data": map[string]any{
				"accessToken":      fakeToken(testUID, 5000, 9000),
				"refreshToken":     fakeToken(testUID, 5000, 99999),
				"expiresIn":        4000,
				"refreshExpiresIn": 80000,
				"tokenType":        "Bearer",
				"domain":           "www.codebuddy.cn",
			},
		})
		_, _ = writer.Write(payload)
	}))
	defer server.Close()

	refresher, err := New(Options{
		Client:      server.Client(),
		Credentials: store,
		Clock:       func() time.Time { return time.Unix(2000, 0) },
		Endpoint:    func(string) string { return server.URL },
	})
	if err != nil {
		t.Fatal(err)
	}
	refreshed, err := refresher.ForceRefreshCredential(context.Background(), snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if !refreshed.IsValid() || refreshed.Credential().IdentitySeed() != snapshot.Credential().IdentitySeed() {
		t.Fatal("refreshed credential identity changed")
	}
	if store.snapshot.Credential().(*accountcore.NativeCredential).IdentitySeed() != snapshot.Credential().IdentitySeed() {
		t.Fatal("stored identity changed")
	}
	payload := store.snapshot.Credential().(*accountcore.NativeCredential).Payload()
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil {
		t.Fatal(err)
	}
	credentials := document["credentials"].(map[string]any)
	auth := credentials["auth"].(map[string]any)
	if auth["refreshToken"] == "" || auth["accessToken"] == "" {
		t.Fatal("rotated tokens not persisted")
	}
	if auth["lastRefreshTime"] == nil {
		t.Fatal("lastRefreshTime not persisted")
	}
}

func TestForceRefreshClassifiesRevokedToken(t *testing.T) {
	store, snapshot := testSnapshot(t, 1000)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		_, _ = writer.Write([]byte(`{"code":12153,"msg":"12153:refresh token failed:idsvc token: invalid_grant: refresh token revoked (http 401)"}`))
	}))
	defer server.Close()

	refresher, err := New(Options{
		Client:      server.Client(),
		Credentials: store,
		Clock:       func() time.Time { return time.Unix(2000, 0) },
		Endpoint:    func(string) string { return server.URL },
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = refresher.ForceRefreshCredential(context.Background(), snapshot)
	if !errors.Is(err, usageapp.ErrCredentialRejected) {
		t.Fatalf("err = %v, want credential rejected", err)
	}
}

func TestRefreshSkipsFreshTokenUnlessForced(t *testing.T) {
	store, snapshot := testSnapshot(t, 100000)
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	defer server.Close()

	refresher, err := New(Options{
		Client:      server.Client(),
		Credentials: store,
		Clock:       func() time.Time { return time.Unix(2000, 0) },
		Endpoint:    func(string) string { return server.URL },
	})
	if err != nil {
		t.Fatal(err)
	}
	refreshed, err := refresher.RefreshCredential(context.Background(), snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if called {
		t.Fatal("fresh token must not trigger a refresh request")
	}
	if !refreshed.IsValid() {
		t.Fatal("fresh snapshot must remain valid")
	}
}

type fakeStore struct {
	snapshot accountapp.CredentialSnapshot
}

func (store *fakeStore) GetCredentialSnapshot(context.Context, accountcore.AccountRef) (accountapp.CredentialSnapshot, error) {
	return store.snapshot, nil
}

func (store *fakeStore) ReplaceCredential(_ context.Context, replacement accountapp.CredentialReplacement) error {
	next, err := accountapp.NewCredentialSnapshot(
		replacement.AccountRef(),
		replacement.Credential().ProviderID(),
		replacement.Credential(),
		replacement.UpdatedAt(),
	)
	if err != nil {
		return err
	}
	store.snapshot = next
	return nil
}

func testSnapshot(t *testing.T, expiresAt int64) (*fakeStore, accountapp.CredentialSnapshot) {
	t.Helper()
	payload := map[string]any{
		"credentials": map[string]any{
			"auth": map[string]any{
				"accessToken":  fakeToken(testUID, 1000, expiresAt),
				"refreshToken": fakeToken(testUID, 1000, 99999),
				"domain":       "www.codebuddy.cn",
				"tokenType":    "Bearer",
			},
			"account": map[string]any{"uid": testUID, "nickname": "tester"},
		},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	credential, err := nativeaccount.NewDecoder().DecodeNativeAuth("codebuddycn", encoded)
	if err != nil {
		t.Fatal(err)
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := accountapp.NewCredentialSnapshot(accountRef, "codebuddycn", credential, time.Unix(1500, 0))
	if err != nil {
		t.Fatal(err)
	}
	store := &fakeStore{snapshot: snapshot}
	return store, snapshot
}

func fakeToken(uid string, issuedAt, expiresAt int64) string {
	claims, _ := json.Marshal(map[string]any{
		"iss": "https://www.codebuddy.cn/auth/realms/copilot",
		"sub": uid,
		"iat": issuedAt,
		"exp": expiresAt,
	})
	return "e30." + base64.RawURLEncoding.EncodeToString(claims) + ".signature"
}
