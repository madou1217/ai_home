package nativeaccount

import (
	"fmt"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/accounts/agy"
)

// 早期同步把 agy 的 auth_method 写成 "oauth"，antigravity CLI 只认 "consumer"。
// Node 刷新时会自愈；导入路径必须给出同一结论，否则这些凭据整条加载失败。
func TestDecodeAGYUpgradesLegacyOAuthAuthMethod(t *testing.T) {
	credential, err := NewDecoder().DecodeNativeAuth(
		"agy",
		[]byte(agyNativeAuthJSON(t, "oauth")),
	)
	if err != nil {
		t.Fatalf("DecodeNativeAuth() error = %v", err)
	}
	auth, ok := credential.(*agy.OAuthAuth)
	if !ok || auth == nil {
		t.Fatalf("credential = %T, want *agy.OAuthAuth", credential)
	}
	if auth.AuthMethod() != agy.AuthMethodConsumer {
		t.Fatalf("auth method = %q, want consumer", auth.AuthMethod())
	}
}

// 自定义 OAuth 客户端可能写在 oauthToken 或 oauthToken.token；Node 两处都读。
func TestDecodeAGYKeepsCustomOAuthClient(t *testing.T) {
	expiresAt := time.Now().Add(time.Hour).UnixMilli()
	payload := fmt.Sprintf(
		`{"email":"agy@example.test","oauthToken":{"auth_method":"consumer","client_id":"client-top.apps.googleusercontent.com","client_secret":"secret-top","token":{"access_token":"agy-access","refresh_token":"agy-refresh","expires_at_ms":%d,"refreshed_at_ms":%d,"token_type":"Bearer"}}}`,
		expiresAt,
		expiresAt-int64(time.Hour/time.Millisecond),
	)
	credential, err := NewDecoder().DecodeNativeAuth("agy", []byte(payload))
	if err != nil {
		t.Fatalf("DecodeNativeAuth() error = %v", err)
	}
	auth, ok := credential.(*agy.OAuthAuth)
	if !ok || auth == nil {
		t.Fatalf("credential = %T", credential)
	}
	if auth.ClientID() != "client-top.apps.googleusercontent.com" ||
		auth.ClientSecret() != "secret-top" {
		t.Fatalf("client = %q / %q", auth.ClientID(), auth.ClientSecret())
	}
}

func TestDecodeAGYRejectsUnknownAuthMethod(t *testing.T) {
	if _, err := NewDecoder().DecodeNativeAuth(
		"agy",
		[]byte(agyNativeAuthJSON(t, "api-key")),
	); err == nil {
		t.Fatal("DecodeNativeAuth() error = nil, want rejection")
	}
}

func agyNativeAuthJSON(t *testing.T, authMethod string) string {
	t.Helper()
	expiresAt := time.Now().Add(time.Hour).UnixMilli()
	return fmt.Sprintf(
		`{"email":"agy@example.test","oauthToken":{"auth_method":%q,"token":{"access_token":"agy-access","refresh_token":"agy-refresh","expires_at_ms":%d,"refreshed_at_ms":%d,"token_type":"Bearer"}}}`,
		authMethod,
		expiresAt,
		expiresAt-int64(time.Hour/time.Millisecond),
	)
}
