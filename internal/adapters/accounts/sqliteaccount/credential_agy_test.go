package sqliteaccount

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
)

func TestAgyCredentialCodecRoundTripsNativeOAuthWithoutLeakingSecrets(t *testing.T) {
	t.Parallel()

	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "agy@example.com",
		AccessToken:   "agy-access-roundtrip-secret",
		RefreshToken:  "agy-refresh-roundtrip-secret",
		ExpiresAtMS:   2_000_000_000_000,
		RefreshedAtMS: 1_900_000_000_000,
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	store := openTestStore(t)
	account := newAccountForCredential(t, store, auth, 1)
	registration, err := accountapp.NewRegistration(account, auth, testAccountTime())
	if err != nil {
		t.Fatalf("newRegistration() error = %v", err)
	}
	if err := store.Register(context.Background(), registration); err != nil {
		t.Fatalf("Register() error = %v", err)
	}

	restored, err := store.GetCredential(context.Background(), account.Ref())
	if err != nil {
		t.Fatalf("GetCredential() error = %v", err)
	}
	restoredAuth, ok := restored.(*agy.OAuthAuth)
	if !ok {
		t.Fatalf("GetCredential() type = %T", restored)
	}
	if restoredAuth.Email() != auth.Email() ||
		restoredAuth.AccessToken() != auth.AccessToken() ||
		restoredAuth.RefreshToken() != auth.RefreshToken() ||
		restoredAuth.ExpiresAtMS() != auth.ExpiresAtMS() ||
		restoredAuth.RefreshedAtMS() != auth.RefreshedAtMS() ||
		restoredAuth.TokenType() != auth.TokenType() ||
		restoredAuth.AuthMethod() != auth.AuthMethod() {
		t.Fatal("AGY OAuth codec 没有无损 round-trip")
	}
	formatted := fmt.Sprintf("%v %#v", restored, restored)
	for _, secret := range []string{auth.AccessToken(), auth.RefreshToken()} {
		if strings.Contains(formatted, secret) {
			t.Fatalf("恢复凭据安全格式化泄漏 secret: %q", formatted)
		}
	}
}

func TestAgyCredentialCodecRejectsUnknownFieldsAndModes(t *testing.T) {
	t.Parallel()

	registry := newCredentialRegistry()
	valid := `{"email":"agy@example.com","access_token":"access","refresh_token":"refresh","expires_at_ms":2000000000000,"refreshed_at_ms":1900000000000,"token_type":"Bearer","auth_method":"consumer"}`
	tests := []struct {
		name     string
		authKind string
		authMode string
		payload  string
	}{
		{name: "unknown field", authKind: "oauth", authMode: "consumer", payload: strings.TrimSuffix(valid, "}") + `,"extra":true}`},
		{name: "duplicate field", authKind: "oauth", authMode: "consumer", payload: strings.Replace(valid, `"email":`, `"email":"first@example.com","email":`, 1)},
		{name: "wrong kind", authKind: "api_key", authMode: "consumer", payload: valid},
		{name: "wrong mode", authKind: "oauth", authMode: "oauth", payload: valid},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, err := registry.Decode(
				agy.ProviderID,
				test.authKind,
				test.authMode,
				[]byte(test.payload),
			)
			if !errors.Is(err, ErrInvalidCredential) {
				t.Fatalf("Decode() error = %v, want ErrInvalidCredential", err)
			}
		})
	}
}
