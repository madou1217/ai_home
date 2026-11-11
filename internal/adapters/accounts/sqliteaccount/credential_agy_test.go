package sqliteaccount

import (
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/accounts/agy"
)

func testAgyCredentialWithClient(t *testing.T) *agy.OAuthAuth {
	t.Helper()
	refreshedAt := time.Date(2026, time.November, 11, 10, 0, 0, 0, time.UTC)
	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "agy@example.test",
		AccessToken:   "agy-access",
		RefreshToken:  "agy-refresh",
		ExpiresAtMS:   refreshedAt.Add(time.Hour).UnixMilli(),
		RefreshedAtMS: refreshedAt.UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
		ClientID:      "custom.apps.googleusercontent.com",
		ClientSecret:  "custom-secret",
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return auth
}

func TestAgyCredentialCodecRoundTripsCustomClient(t *testing.T) {
	codec := agyCredentialCodec{}
	encoded, err := codec.Encode(testAgyCredentialWithClient(t))
	if err != nil {
		t.Fatalf("Encode() error = %v", err)
	}
	decoded, err := codec.Decode(encoded.authKind, encoded.authMode, encoded.json)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	auth, ok := decoded.(*agy.OAuthAuth)
	if !ok || auth.ClientID() != "custom.apps.googleusercontent.com" ||
		auth.ClientSecret() != "custom-secret" {
		t.Fatalf("decoded client = %v", decoded)
	}
}

// 老凭据没有 client_id/client_secret 字段，必须照常解码成内置默认客户端。
func TestAgyCredentialCodecDecodesLegacyWithoutClient(t *testing.T) {
	codec := agyCredentialCodec{}
	legacy := []byte(`{"email":"agy@example.test","access_token":"agy-access","refresh_token":"agy-refresh","expires_at_ms":1794394800000,"refreshed_at_ms":1794391200000,"token_type":"Bearer","auth_method":"consumer"}`)
	decoded, err := codec.Decode("oauth", "consumer", legacy)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	auth, ok := decoded.(*agy.OAuthAuth)
	if !ok || auth.ClientID() != "" || auth.ClientSecret() != "" {
		t.Fatalf("legacy client = %v", decoded)
	}
}
