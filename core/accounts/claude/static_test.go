package claude

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// 静态账号身份必须与 Node 的 `<kind>:claude:<base>:sha256(secret)[:16]` 逐字节一致。
func TestStaticIdentitySeedUsesNodeFingerprint(t *testing.T) {
	auth, err := NewAPIKeyAuth(APIKeyInput{APIKey: "sk-ant-1", BaseURL: ""})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth: %v", err)
	}
	digest := sha256.Sum256([]byte("sk-ant-1"))
	fingerprint := hex.EncodeToString(digest[:])[:16]
	want := "api_key:claude:https://api.anthropic.com:" + fingerprint
	if got := auth.IdentitySeed(); got != want {
		t.Fatalf("identity seed = %q, want %q", got, want)
	}
	if len(auth.Fingerprint()) != 16 {
		t.Fatalf("fingerprint length = %d, want 16", len(auth.Fingerprint()))
	}

	token, err := NewAuthTokenAuth(AuthTokenInput{AuthToken: "tok-1", BaseURL: ""})
	if err != nil {
		t.Fatalf("NewAuthTokenAuth: %v", err)
	}
	tokenDigest := sha256.Sum256([]byte("tok-1"))
	tokenFingerprint := hex.EncodeToString(tokenDigest[:])[:16]
	if got, want := token.IdentitySeed(), "auth_token:claude:https://api.anthropic.com:"+tokenFingerprint; got != want {
		t.Fatalf("auth token identity seed = %q, want %q", got, want)
	}
}
