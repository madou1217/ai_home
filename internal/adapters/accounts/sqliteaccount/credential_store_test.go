package sqliteaccount

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

func TestCredentialStoreRoundTripsAllCodexAndClaudeVariants(t *testing.T) {
	t.Parallel()

	codexOAuth := newTestCodexOAuth(t)
	claudeOAuth := newTestClaudeOAuth(t)
	tests := []struct {
		name       string
		credential accountapp.Credential
		secret     string
	}{
		{name: "codex oauth", credential: codexOAuth, secret: codexOAuth.RefreshToken()},
		{
			name:       "codex api key",
			credential: mustCodexAPIKey(t, "sk-test-codex-roundtrip"),
			secret:     "sk-test-codex-roundtrip",
		},
		{name: "claude oauth", credential: claudeOAuth, secret: claudeOAuth.RefreshToken()},
		{
			name:       "claude setup token",
			credential: mustClaudeOAuthToken(t, "sk-ant-oat-test-roundtrip"),
			secret:     "sk-ant-oat-test-roundtrip",
		},
		{
			name:       "claude api key",
			credential: mustClaudeAPIKey(t, "sk-ant-api-test-roundtrip"),
			secret:     "sk-ant-api-test-roundtrip",
		},
		{
			name:       "claude auth token",
			credential: mustClaudeAuthToken(t, "sk-ant-auth-test-roundtrip"),
			secret:     "sk-ant-auth-test-roundtrip",
		},
	}

	for index, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			store := openTestStore(t)
			account := newAccountForCredential(t, store, test.credential, int64(index+1))
			registration, err := accountapp.NewRegistration(account, test.credential, testAccountTime())
			if err != nil {
				t.Fatalf("NewRegistration() error = %v", err)
			}
			if err := store.Register(context.Background(), registration); err != nil {
				t.Fatalf("Register() error = %v", err)
			}
			restored, err := store.GetCredential(context.Background(), account.Ref())
			if err != nil {
				t.Fatalf("GetCredential() error = %v", err)
			}
			if restored.ProviderID() != test.credential.ProviderID() ||
				restored.IdentitySeed() != test.credential.IdentitySeed() {
				t.Fatalf(
					"恢复凭据身份错误: got=(%s,%s) want=(%s,%s)",
					restored.ProviderID(),
					restored.IdentitySeed(),
					test.credential.ProviderID(),
					test.credential.IdentitySeed(),
				)
			}
			if strings.Contains(fmt.Sprintf("%v %#v", restored, restored), test.secret) {
				t.Fatal("恢复凭据的安全格式化泄漏了 secret")
			}
			assertCredentialSecret(t, restored, test.secret)
		})
	}
}

func TestCredentialStoreRejectsUnknownAndDuplicateJSONFields(t *testing.T) {
	t.Parallel()

	tests := []string{
		`{"api_key":"secret","base_url":"https://api.openai.com/v1","extra":true}`,
		`{"api_key":"first","api_key":"second","base_url":"https://api.openai.com/v1"}`,
	}
	for _, payload := range tests {
		payload := payload
		t.Run(payload, func(t *testing.T) {
			t.Parallel()

			store := openTestStore(t)
			credential := mustCodexAPIKey(t, "sk-test-strict-json")
			account := newAccountForCredential(t, store, credential, 1)
			registration, err := accountapp.NewRegistration(account, credential, testAccountTime())
			if err != nil {
				t.Fatalf("NewRegistration() error = %v", err)
			}
			if err := store.Register(context.Background(), registration); err != nil {
				t.Fatalf("Register() error = %v", err)
			}
			if _, err := store.db.Exec(
				"UPDATE account_credentials SET credential_json = ? WHERE account_ref = ?",
				payload,
				account.Ref().String(),
			); err != nil {
				t.Fatalf("corrupt credential JSON error = %v", err)
			}
			_, err = store.GetCredential(context.Background(), account.Ref())
			if !errors.Is(err, ErrInvalidCredential) {
				t.Fatalf("GetCredential() error = %v, want ErrInvalidCredential", err)
			}
		})
	}
}

func TestCredentialCodecRejectsTrailingJSON(t *testing.T) {
	t.Parallel()

	registry := newCredentialRegistry()
	_, err := registry.Decode(
		codex.ProviderID,
		codex.AuthKindAPIKey.String(),
		"",
		[]byte(`{"api_key":"secret","base_url":"https://api.openai.com/v1"}{}`),
	)
	if !errors.Is(err, ErrInvalidCredential) {
		t.Fatalf("Decode() error = %v, want ErrInvalidCredential", err)
	}
}

func TestCredentialTableRejectsMalformedJSON(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	credential := mustCodexAPIKey(t, "sk-test-database-json")
	account := newAccountForCredential(t, store, credential, 1)
	registration, err := accountapp.NewRegistration(account, credential, testAccountTime())
	if err != nil {
		t.Fatalf("NewRegistration() error = %v", err)
	}
	if err := store.Register(context.Background(), registration); err != nil {
		t.Fatalf("Register() error = %v", err)
	}
	_, err = store.db.Exec(
		"UPDATE account_credentials SET credential_json = ? WHERE account_ref = ?",
		`{"api_key":"secret"}{}`,
		account.Ref().String(),
	)
	if !isConstraintError(err) {
		t.Fatalf("UPDATE malformed JSON error = %v, want constraint error", err)
	}
}

func TestCredentialRegistrationRollsBackAccountOnConflict(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestStore(t)
	firstCredential := mustCodexAPIKey(t, "sk-test-atomic-first")
	first := newAccountForCredential(t, store, firstCredential, 1)
	firstRegistration, err := accountapp.NewRegistration(
		first,
		firstCredential,
		testAccountTime(),
	)
	if err != nil {
		t.Fatalf("NewRegistration(first) error = %v", err)
	}
	if err := store.Register(ctx, firstRegistration); err != nil {
		t.Fatalf("Register(first) error = %v", err)
	}

	secondCredential := mustCodexAPIKey(t, "sk-test-atomic-second")
	second := newAccountForCredential(t, store, secondCredential, 1)
	secondRegistration, err := accountapp.NewRegistration(
		second,
		secondCredential,
		testAccountTime(),
	)
	if err != nil {
		t.Fatalf("NewRegistration(second) error = %v", err)
	}
	if err := store.Register(ctx, secondRegistration); !errors.Is(err, accountapp.ErrAccountConflict) {
		t.Fatalf("Register(second) error = %v, want ErrAccountConflict", err)
	}
	if _, err := store.GetByRef(ctx, second.Ref()); !errors.Is(err, accountapp.ErrAccountNotFound) {
		t.Fatalf("冲突事务遗留了基础账号: %v", err)
	}
	if _, err := store.GetCredential(ctx, second.Ref()); !errors.Is(err, accountapp.ErrCredentialNotFound) {
		t.Fatalf("冲突事务遗留了凭据: %v", err)
	}
}

func TestCredentialStoreReturnsNotFoundForPendingAccount(t *testing.T) {
	t.Parallel()

	store := openTestStore(t)
	account := newCodexAPIKeyAccount(t, store, 1, "sk-test-pending-account")
	if err := store.Create(context.Background(), account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := store.GetCredential(
		context.Background(),
		account.Ref(),
	); !errors.Is(err, accountapp.ErrCredentialNotFound) {
		t.Fatalf("GetCredential() error = %v, want ErrCredentialNotFound", err)
	}
}

func newAccountForCredential(
	t *testing.T,
	store *Store,
	credential accountapp.Credential,
	alias int64,
) accountcore.Account {
	t.Helper()

	cliAccountID, err := accountcore.NewCLIAccountID(alias)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(store.catalog, accountcore.NewAccountInput{
		Identity:     credential,
		CLIAccountID: cliAccountID,
		CreatedAt:    testAccountTime(),
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	return account
}

func newTestCodexOAuth(t *testing.T) *codex.OAuthAuth {
	t.Helper()

	auth, err := codex.NewOAuthAuth(codex.OAuthInput{
		AccessToken:  testJWT(t, map[string]any{"exp": 2_000_000_000}),
		RefreshToken: "codex-refresh-secret-that-must-not-leak",
		IDToken: testJWT(t, map[string]any{
			"sub":   "codex-user",
			"email": "codex@example.com",
			"https://api.openai.com/auth": map[string]any{
				"chatgpt_user_id":    "codex-user",
				"chatgpt_account_id": "codex-workspace",
				"chatgpt_plan_type":  "plus",
			},
		}),
		RefreshedAtMS:     1_700_000_000_000,
		ExplicitAccountID: "codex-workspace",
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return auth
}

func newTestClaudeOAuth(t *testing.T) *claude.OAuthAuth {
	t.Helper()

	auth, err := claude.NewOAuthAuth(claude.OAuthInput{
		AccessToken:             "claude-access-secret-that-must-not-leak",
		RefreshToken:            "claude-refresh-secret-that-must-not-leak",
		ExpiresAtMS:             2_000_000_000_000,
		RefreshTokenExpiresAtMS: 2_100_000_000_000,
		ClientID:                "claude-client",
		Scopes:                  []string{claude.InferenceScope, "user:profile"},
		Identity: claude.OAuthIdentity{
			AccountUUID: "123e4567-e89b-12d3-a456-426614174000",
		},
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return auth
}

func mustCodexAPIKey(t *testing.T, secret string) *codex.APIKeyAuth {
	t.Helper()
	auth, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: secret})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	return auth
}

func mustClaudeOAuthToken(t *testing.T, secret string) *claude.OAuthTokenAuth {
	t.Helper()
	auth, err := claude.NewOAuthTokenAuth(claude.OAuthTokenInput{AccessToken: secret})
	if err != nil {
		t.Fatalf("NewOAuthTokenAuth() error = %v", err)
	}
	return auth
}

func mustClaudeAPIKey(t *testing.T, secret string) *claude.APIKeyAuth {
	t.Helper()
	auth, err := claude.NewAPIKeyAuth(claude.APIKeyInput{APIKey: secret})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	return auth
}

func mustClaudeAuthToken(t *testing.T, secret string) *claude.AuthTokenAuth {
	t.Helper()
	auth, err := claude.NewAuthTokenAuth(claude.AuthTokenInput{AuthToken: secret})
	if err != nil {
		t.Fatalf("NewAuthTokenAuth() error = %v", err)
	}
	return auth
}

func testJWT(t *testing.T, claims map[string]any) string {
	t.Helper()

	headerJSON, err := json.Marshal(map[string]any{"alg": "none", "typ": "JWT"})
	if err != nil {
		t.Fatalf("marshal JWT header error = %v", err)
	}
	payloadJSON, err := json.Marshal(claims)
	if err != nil {
		t.Fatalf("marshal JWT payload error = %v", err)
	}
	return base64.RawURLEncoding.EncodeToString(headerJSON) + "." +
		base64.RawURLEncoding.EncodeToString(payloadJSON) + ".signature"
}

func assertCredentialSecret(
	t *testing.T,
	credential accountapp.Credential,
	expected string,
) {
	t.Helper()

	var actual string
	switch auth := credential.(type) {
	case *codex.OAuthAuth:
		actual = auth.RefreshToken()
	case *codex.APIKeyAuth:
		actual = auth.APIKey()
	case *claude.OAuthAuth:
		actual = auth.RefreshToken()
	case *claude.OAuthTokenAuth:
		actual = auth.AccessToken()
	case *claude.APIKeyAuth:
		actual = auth.APIKey()
	case *claude.AuthTokenAuth:
		actual = auth.AuthToken()
	default:
		t.Fatalf("未知凭据类型 %T", credential)
	}
	if actual != expected {
		t.Fatal("恢复凭据没有保留原始 secret")
	}
}
