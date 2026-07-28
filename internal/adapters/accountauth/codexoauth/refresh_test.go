package codexoauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

// TestProviderRefreshesCodexOAuthAndPreservesOptionalTokens 验证官方请求及可选 Token 保留。
func TestProviderRefreshesCodexOAuthAndPreservesOptionalTokens(t *testing.T) {
	t.Parallel()

	var requestDocument map[string]string
	tokenServer := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, request *http.Request) {
			if request.Method != http.MethodPost ||
				request.Header.Get("Content-Type") != "application/json" {
				t.Fatalf(
					"refresh request = %s %s",
					request.Method,
					request.Header.Get("Content-Type"),
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
				"access_token": codexRefreshAccessToken(t, 2_100_000_000),
				"expires_in":   3600,
			})
		},
	))
	defer tokenServer.Close()

	provider := newTestProvider(t, tokenServer.URL)
	initial := codexRefreshCredential(t, 1_900_000_000)
	expiresAt, refreshable := provider.ExpiresAt(initial)
	if !refreshable || expiresAt.Unix() != 1_900_000_000 {
		t.Fatalf(
			"ExpiresAt() = (%s,%t)",
			expiresAt,
			refreshable,
		)
	}
	refreshedAt := testClock().Add(time.Minute)
	credential, err := provider.Refresh(
		context.Background(),
		initial,
		refreshedAt,
	)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	refreshed, valid := credential.(*codex.OAuthAuth)
	if !valid ||
		refreshed.AccessExpiresAtMS() != 2_100_000_000_000 ||
		refreshed.RefreshToken() != initial.RefreshToken() ||
		refreshed.IDToken() != initial.IDToken() ||
		refreshed.RefreshedAtMS() != refreshedAt.UnixMilli() ||
		refreshed.IdentitySeed() != initial.IdentitySeed() {
		t.Fatalf("refreshed credential = %T %#v", credential, credential)
	}
	expectedRequest := map[string]string{
		"client_id":     clientID,
		"grant_type":    "refresh_token",
		"refresh_token": initial.RefreshToken(),
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

// TestProviderDoesNotRefreshCodexAPIKey 验证静态 API Key 不进入 OAuth 刷新。
func TestProviderDoesNotRefreshCodexAPIKey(t *testing.T) {
	t.Parallel()

	provider := newTestProvider(t, "https://example.invalid/token")
	apiKey, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey: "sk-test-static-codex",
	})
	if err != nil {
		t.Fatalf("codex.NewAPIKeyAuth() error = %v", err)
	}
	if _, refreshable := provider.ExpiresAt(apiKey); refreshable {
		t.Fatal("Codex API Key 被误判为可刷新 OAuth")
	}
}

// TestProviderDoesNotUseCodexIDTokenExpiry 验证身份 Token 过期不代表 Access Token 失效。
func TestProviderDoesNotUseCodexIDTokenExpiry(t *testing.T) {
	t.Parallel()

	auth, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken:   "opaque-codex-access-without-exp",
		RefreshToken:  "synthetic-codex-refresh-for-id-token-test",
		IDToken:       codexRefreshIDToken(t, "stable-user", "stable-workspace", 1),
		RefreshedAtMS: testClock().UnixMilli(),
	})
	if err != nil {
		t.Fatalf("codex.NewOAuthAuth() error = %v", err)
	}
	provider := newTestProvider(t, "https://example.invalid/token")
	if _, refreshable := provider.ExpiresAt(auth); refreshable {
		t.Fatal("Codex ID Token exp 被误用为 Access Token 过期时间")
	}
}

// TestProviderClassifiesCodexInvalidGrantAsReauthentication 验证失效 Refresh Token 要求 reauth。
func TestProviderClassifiesCodexInvalidGrantAsReauthentication(t *testing.T) {
	t.Parallel()

	tokenServer := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, _ *http.Request) {
			response.WriteHeader(http.StatusBadRequest)
			writeJSON(t, response, map[string]any{
				"error": "invalid_grant",
			})
		},
	))
	defer tokenServer.Close()

	_, err := newTestProvider(t, tokenServer.URL).Refresh(
		context.Background(),
		codexRefreshCredential(t, 1_900_000_000),
		testClock(),
	)
	if !errors.Is(err, accountcredentials.ErrReauthenticationRequired) {
		t.Fatalf("Refresh() error = %v", err)
	}
}

// TestProviderRejectsCodexRefreshIdentityChange 验证新 ID Token 不能切换稳定账号。
func TestProviderRejectsCodexRefreshIdentityChange(t *testing.T) {
	t.Parallel()

	tokenServer := httptest.NewServer(http.HandlerFunc(
		func(response http.ResponseWriter, _ *http.Request) {
			writeJSON(t, response, map[string]any{
				"access_token": codexRefreshAccessToken(t, 2_100_000_000),
				"id_token": codexRefreshIDToken(
					t,
					"other-user",
					"other-workspace",
					0,
				),
			})
		},
	))
	defer tokenServer.Close()

	_, err := newTestProvider(t, tokenServer.URL).Refresh(
		context.Background(),
		codexRefreshCredential(t, 1_900_000_000),
		testClock(),
	)
	if !errors.Is(err, accountcredentials.ErrInvalidRefreshResult) {
		t.Fatalf("Refresh() error = %v", err)
	}
}

// codexRefreshCredential 创建身份稳定且 Access Token 到期时间可控的 OAuth。
func codexRefreshCredential(
	t *testing.T,
	expiresAtSeconds int64,
) *codex.OAuthAuth {
	t.Helper()

	auth, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken:   codexRefreshAccessToken(t, expiresAtSeconds),
		RefreshToken:  "synthetic-codex-refresh-for-refresh-test",
		IDToken:       codexTestJWT(t),
		RefreshedAtMS: testClock().Add(-time.Hour).UnixMilli(),
	})
	if err != nil {
		t.Fatalf("codex.NewOAuthAuth() error = %v", err)
	}
	return auth
}

// codexRefreshAccessToken 创建只携带 exp 的合成 Access Token。
func codexRefreshAccessToken(
	t *testing.T,
	expiresAtSeconds int64,
) string {
	t.Helper()

	header, err := json.Marshal(map[string]any{"alg": "none", "typ": "JWT"})
	if err != nil {
		t.Fatalf("json.Marshal(header) error = %v", err)
	}
	payload, err := json.Marshal(map[string]any{
		"exp": expiresAtSeconds,
	})
	if err != nil {
		t.Fatalf("json.Marshal(payload) error = %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(payload) + ".signature"
}

// codexRefreshIDToken 创建身份和可选 exp 均可控的合成 ID Token。
func codexRefreshIDToken(
	t *testing.T,
	userID string,
	accountID string,
	expiresAtSeconds int64,
) string {
	t.Helper()

	header, err := json.Marshal(map[string]any{"alg": "none", "typ": "JWT"})
	if err != nil {
		t.Fatalf("json.Marshal(header) error = %v", err)
	}
	payload := map[string]any{
		"sub": userID,
		"https://api.openai.com/auth": map[string]any{
			"chatgpt_user_id":    userID,
			"chatgpt_account_id": accountID,
		},
	}
	if expiresAtSeconds > 0 {
		payload["exp"] = expiresAtSeconds
	}
	encodedPayload, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("json.Marshal(payload) error = %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(header) + "." +
		base64.RawURLEncoding.EncodeToString(encodedPayload) + ".signature"
}
