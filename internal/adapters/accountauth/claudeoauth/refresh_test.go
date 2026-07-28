package claudeoauth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/core/accounts/claude"
)

// TestProviderRefreshesClaudeOAuthAndPreservesIdentity 验证官方请求、过期时间和稳定身份。
func TestProviderRefreshesClaudeOAuthAndPreservesIdentity(t *testing.T) {
	t.Parallel()

	var requestDocument map[string]string
	tokenServer := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			if request.Method != http.MethodPost ||
				request.Header.Get("Content-Type") != "application/json" ||
				request.Header.Get("Accept-Encoding") != "identity" {
				t.Fatalf(
					"refresh request = %s %#v",
					request.Method,
					request.Header,
				)
			}
			body, err := io.ReadAll(request.Body)
			if err != nil {
				t.Fatalf("io.ReadAll() error = %v", err)
			}
			if err := json.Unmarshal(body, &requestDocument); err != nil {
				t.Fatalf("json.Unmarshal() error = %v", err)
			}
			writeJSON(t, response, map[string]any{
				"access_token": "sk-ant-oat01-refreshed-claude-access",
				"expires_in":   3600,
				"scope":        "user:profile user:inference",
			})
		},
	))
	defer tokenServer.Close()

	provider := newTestProvider(
		t,
		tokenServer.URL,
		"https://example.invalid/profile",
	)
	initial := claudeRefreshCredential(t)
	expiresAt, refreshable := provider.ExpiresAt(initial)
	if !refreshable || expiresAt.UnixMilli() != initial.ExpiresAtMS() {
		t.Fatalf(
			"ExpiresAt() = (%s,%t)",
			expiresAt,
			refreshable,
		)
	}
	refreshedAt := testClock()
	credential, err := provider.Refresh(
		context.Background(),
		initial,
		refreshedAt,
	)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	refreshed, valid := credential.(*claude.OAuthAuth)
	if !valid ||
		refreshed.AccessToken() != "sk-ant-oat01-refreshed-claude-access" ||
		refreshed.RefreshToken() != initial.RefreshToken() ||
		refreshed.ExpiresAtMS() != refreshedAt.Add(time.Hour).UnixMilli() ||
		refreshed.RefreshTokenExpiresAtMS() != initial.RefreshTokenExpiresAtMS() ||
		refreshed.AccountUUID() != initial.AccountUUID() ||
		refreshed.IdentitySeed() != initial.IdentitySeed() ||
		!refreshed.HasScope(claude.InferenceScope) {
		t.Fatalf("refreshed credential = %T %#v", credential, credential)
	}
	expectedRequest := map[string]string{
		"client_id":     clientID,
		"grant_type":    "refresh_token",
		"refresh_token": initial.RefreshToken(),
		"scope":         refreshScope,
	}
	if len(requestDocument) != len(expectedRequest) {
		t.Fatalf("refresh request document = %#v", requestDocument)
	}
	for key, expected := range expectedRequest {
		if requestDocument[key] != expected {
			t.Fatalf(
				"refresh request %s = %q, want %q",
				key,
				requestDocument[key],
				expected,
			)
		}
	}
}

// TestProviderRejectsExpiredClaudeRefreshTokenWithoutNetwork 验证本地过期时不请求上游。
func TestProviderRejectsExpiredClaudeRefreshTokenWithoutNetwork(t *testing.T) {
	t.Parallel()

	var calls atomic.Int32
	tokenServer := httptest.NewServer(http.HandlerFunc(
		func(http.ResponseWriter, *http.Request) {
			calls.Add(1)
		},
	))
	defer tokenServer.Close()

	provider := newTestProvider(
		t,
		tokenServer.URL,
		"https://example.invalid/profile",
	)
	initial := claudeRefreshCredential(t)
	expired, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:             initial.AccessToken(),
		RefreshToken:            initial.RefreshToken(),
		ExpiresAtMS:             initial.ExpiresAtMS(),
		RefreshTokenExpiresAtMS: testClock().Add(-time.Second).UnixMilli(),
		ClientID:                initial.ClientID(),
		Scopes:                  initial.Scopes(),
		Identity:                initial.Identity(),
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthAuth() error = %v", err)
	}
	_, err = provider.Refresh(context.Background(), expired, testClock())
	if !errors.Is(err, accountcredentials.ErrReauthenticationRequired) {
		t.Fatalf("Refresh() error = %v", err)
	}
	if calls.Load() != 0 {
		t.Fatalf("expired refresh token network calls = %d", calls.Load())
	}
}

// TestProviderDoesNotRefreshClaudeSetupToken 验证 setup-token 不进入 refreshable OAuth。
func TestProviderDoesNotRefreshClaudeSetupToken(t *testing.T) {
	t.Parallel()

	provider := newTestProvider(
		t,
		"https://example.invalid/token",
		"https://example.invalid/profile",
	)
	setupToken, err := claude.NewOAuthTokenAuth(claude.OAuthTokenInput{
		AccessToken: "sk-ant-oat01-static-setup-token",
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthTokenAuth() error = %v", err)
	}
	if _, refreshable := provider.ExpiresAt(setupToken); refreshable {
		t.Fatal("Claude setup-token 被误判为 refreshable OAuth")
	}
}

// claudeRefreshCredential 创建过期但 Refresh Token 仍有效的 Claude OAuth。
func claudeRefreshCredential(t *testing.T) *claude.OAuthAuth {
	t.Helper()

	auth, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:             "sk-ant-oat01-old-claude-access",
		RefreshToken:            "sk-ant-ort01-old-claude-refresh",
		ExpiresAtMS:             testClock().Add(-time.Minute).UnixMilli(),
		RefreshTokenExpiresAtMS: testClock().Add(24 * time.Hour).UnixMilli(),
		Scopes:                  []string{"user:profile", claude.InferenceScope},
		Identity: claude.OAuthIdentity{
			AccountUUID: testAccountUUID,
		},
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthAuth() error = %v", err)
	}
	return auth
}
