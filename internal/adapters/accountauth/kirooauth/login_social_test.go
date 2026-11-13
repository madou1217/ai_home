package kirooauth

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/core/accounts/kiro"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

func TestSocialDeviceFlowGoogleSuccessAndSQLiteSlots(t *testing.T) {
	var pollCount int
	desktopSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/oauth/device/authorization":
			var req map[string]string
			_ = json.NewDecoder(r.Body).Decode(&req)
			if req["clientId"] != socialClientID || req["loginProvider"] != "Google" {
				t.Fatalf("auth req = %v", req)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"deviceCode":              "social-dev-code",
				"userCode":                "ABCD-1234",
				"verificationUri":         "https://app.kiro.dev/signin",
				"verificationUriComplete": "https://app.kiro.dev/signin?code=ABCD-1234",
				"expiresInMilliseconds":   300000,
				"intervalInMilliseconds":  2000,
			})
		case "/oauth/device/poll":
			pollCount++
			if pollCount == 1 {
				_ = json.NewEncoder(w).Encode(map[string]any{"status": "authorization_pending"})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"accessToken":      "soc-access-123",
				"refreshToken":     "soc-refresh-456",
				"profileArn":       "arn:aws:codewhisperer:us-east-1:123456789012:profile/SOCIAL1",
				"identityProvider": "Google",
			})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer desktopSrv.Close()

	usageSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("profileArn") == "" {
			t.Fatalf("expected profileArn in GetUsageLimits query, got %q", r.URL.RawQuery)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"userInfo": map[string]any{
				"userId": "social-user-001",
				"email":  "social@example.com",
			},
		})
	}))
	defer usageSrv.Close()

	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
	provider, err := newLogin(loginOptions{
		client:      &http.Client{},
		clock:       func() time.Time { return now },
		oidcBase:    func(string) string { return desktopSrv.URL },
		desktopBase: func(string) string { return desktopSrv.URL },
		usageBase:   func(string) string { return usageSrv.URL },
	})
	if err != nil {
		t.Fatalf("newLogin() error = %v", err)
	}
	flowValue, err := provider.BeginWithOptions(context.Background(), accountauth.BeginOptions{
		LoginProvider: "google",
	})
	if err != nil {
		t.Fatalf("BeginWithOptions() error = %v", err)
	}
	devFlow, ok := flowValue.(accountauth.DeviceFlow)
	if !ok {
		t.Fatalf("flow = %T, want DeviceFlow", flowValue)
	}
	if devFlow.PollInterval() != 2*time.Second {
		t.Fatalf("PollInterval() = %v, want 2s", devFlow.PollInterval())
	}
	if codeProv, ok := flowValue.(accountauth.DeviceCodeProvider); !ok || codeProv.UserCode() != "ABCD-1234" {
		t.Fatalf("UserCode() mismatch")
	}
	firstPoll, err := devFlow.Poll(context.Background())
	if err != nil || firstPoll.Status != accountauth.DevicePending {
		t.Fatalf("first Poll = %+v, err=%v", firstPoll, err)
	}
	secondPoll, err := devFlow.Poll(context.Background())
	if err != nil || secondPoll.Status != accountauth.DeviceReady {
		t.Fatalf("second Poll = %+v, err=%v", secondPoll, err)
	}
	if secondPoll.Account.Email != "social@example.com" {
		t.Fatalf("Account = %+v", secondPoll.Account)
	}
	if _, _, err := nativeaccount.NewDecoder().Decode("kiro", secondPoll.Artifacts); err != nil {
		t.Fatalf("native decoder rejected social artifact: %v", err)
	}

	var env struct {
		NativeAuth struct {
			Flavor   string          `json:"flavor"`
			Database string          `json:"database"`
			Raw      json.RawMessage `json:"-"`
		} `json:"native_auth_json"`
	}
	if err := json.Unmarshal(secondPoll.Artifacts, &env); err != nil {
		t.Fatalf("unmarshal artifact: %v", err)
	}
	if env.NativeAuth.Flavor != string(kiro.FlavorDesktop) {
		t.Fatalf("flavor = %q, want desktop", env.NativeAuth.Flavor)
	}
	var rawNative map[string]json.RawMessage
	_ = json.Unmarshal(secondPoll.Artifacts, &rawNative)
	parsed, err := kiro.ParseCredential(rawNative["native_auth_json"])
	if err != nil || parsed.Flavor() != kiro.FlavorDesktop {
		t.Fatalf("kiro.ParseCredential = %+v, err=%v", parsed, err)
	}

	dbBytes, err := base64.StdEncoding.DecodeString(env.NativeAuth.Database)
	if err != nil {
		t.Fatalf("decode db base64: %v", err)
	}
	dbPath := filepath.Join(t.TempDir(), "data.sqlite3")
	if err := os.WriteFile(dbPath, dbBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	var socialSlot string
	if err := db.QueryRow(`SELECT value FROM auth_kv WHERE key = ?`, credentialSocialTokenKey).Scan(&socialSlot); err != nil {
		t.Fatalf("read social slot: %v", err)
	}
	var slotObj map[string]any
	_ = json.Unmarshal([]byte(socialSlot), &slotObj)
	if slotObj["provider"] != "google" || slotObj["profile_arn"] != "arn:aws:codewhisperer:us-east-1:123456789012:profile/SOCIAL1" {
		t.Fatalf("social slot = %v", slotObj)
	}
}

func TestBeginWithOptionsRejectsUnknownLoginProvider(t *testing.T) {
	provider, err := newLogin(loginOptions{
		client:    &http.Client{},
		clock:     time.Now,
		oidcBase:  func(string) string { return "https://example.test" },
		usageBase: func(string) string { return "https://example.test" },
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := provider.BeginWithOptions(context.Background(), accountauth.BeginOptions{LoginProvider: "okta"}); !errors.Is(err, accountauth.ErrUnsupportedLoginProvider) {
		t.Fatalf("err = %v, want ErrUnsupportedLoginProvider", err)
	}
	if _, err := provider.BeginWithOptions(context.Background(), accountauth.BeginOptions{AuthStrategy: "social"}); !errors.Is(err, accountauth.ErrUnsupportedLoginProvider) {
		t.Fatalf("err = %v, want ErrUnsupportedLoginProvider", err)
	}
}

func TestImportIDELocalAndRefreshToken(t *testing.T) {
	desktopSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/refreshToken" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["refreshToken"] != "ide-refresh-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"accessToken":  "refreshed-access",
			"refreshToken": "rotated-refresh",
			"expiresIn":    3600,
			"profileArn":   "arn:aws:codewhisperer:us-east-1:123:profile/IDE",
		})
	}))
	defer desktopSrv.Close()

	usageSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"userInfo": map[string]any{
				"userId": "ide-user-99",
				"email":  "ide@example.com",
			},
		})
	}))
	defer usageSrv.Close()

	home := t.TempDir()
	cacheDir := filepath.Join(home, ".aws", "sso", "cache")
	if err := os.MkdirAll(cacheDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cacheDir, "kiro-auth-token.json"), []byte(`{
		"refreshToken": "ide-refresh-token",
		"provider": "Google",
		"authMethod": "social"
	}`), 0o600); err != nil {
		t.Fatal(err)
	}

	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
	provider, err := newLogin(loginOptions{
		client:      &http.Client{},
		clock:       func() time.Time { return now },
		oidcBase:    func(string) string { return desktopSrv.URL },
		desktopBase: func(string) string { return desktopSrv.URL },
		usageBase:   func(string) string { return usageSrv.URL },
	})
	if err != nil {
		t.Fatal(err)
	}
	imp, err := provider.ImportIDELocal(context.Background(), home)
	if err != nil {
		t.Fatalf("ImportIDELocal() error = %v", err)
	}
	if imp.Fingerprint != KiroLocalIdentity("ide-refresh-token") {
		t.Fatalf("Fingerprint = %q, want %q", imp.Fingerprint, KiroLocalIdentity("ide-refresh-token"))
	}
	if imp.Account.Email != "ide@example.com" {
		t.Fatalf("Email = %q", imp.Account.Email)
	}
	if _, _, err := nativeaccount.NewDecoder().Decode("kiro", imp.Artifacts); err != nil {
		t.Fatalf("native decoder rejected IDE artifact: %v", err)
	}
}


func TestBeginWithOptionsRefreshTokenFlow(t *testing.T) {
	desktopSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"accessToken":  "rt-access",
			"refreshToken": "rt-rotated",
			"expiresIn":    3600,
			"profileArn":   "arn:aws:codewhisperer:us-east-1:123:profile/RT1",
		})
	}))
	defer desktopSrv.Close()

	usageSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"userInfo": map[string]any{
				"userId": "rt-user-1",
				"email":  "rt@example.com",
			},
		})
	}))
	defer usageSrv.Close()

	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
	provider, err := newLogin(loginOptions{
		client:      &http.Client{},
		clock:       func() time.Time { return now },
		oidcBase:    func(string) string { return desktopSrv.URL },
		desktopBase: func(string) string { return desktopSrv.URL },
		usageBase:   func(string) string { return usageSrv.URL },
	})
	if err != nil {
		t.Fatal(err)
	}
	flow, err := provider.BeginWithOptions(context.Background(), accountauth.BeginOptions{
		AuthStrategy: "oauth-refresh-token",
	})
	if err != nil {
		t.Fatalf("BeginWithOptions() error = %v", err)
	}
	if flow.AuthorizationURL() != "" {
		t.Fatalf("AuthorizationURL() = %q, want empty", flow.AuthorizationURL())
	}
	if mp, ok := flow.(accountauth.AuthModeProvider); !ok || mp.AuthMode() != "oauth-refresh-token" {
		t.Fatalf("AuthMode() = %q (%v)", mp.AuthMode(), ok)
	}
	artifacts, err := flow.Exchange(context.Background(), "pasted-refresh-token")
	if err != nil {
		t.Fatalf("Exchange() error = %v", err)
	}
	if _, _, err := nativeaccount.NewDecoder().Decode("kiro", artifacts); err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	if cp, ok := flow.(accountauth.AccountClaimsProvider); !ok || cp.AccountClaims().Email != "rt@example.com" {
		t.Fatalf("AccountClaims = %+v", cp.AccountClaims())
	}
}
