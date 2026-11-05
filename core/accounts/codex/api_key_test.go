package codex

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// 静态账号身份必须与 Node 的 `api_key:<provider>:<base>:sha256(key)[:16]` 逐字节一致；
// 完整 64 位哈希会让同一个 key+base 在两端派生出不同的 accountRef。
func TestAPIKeyIdentitySeedUsesNodeFingerprint(t *testing.T) {
	auth, err := NewAPIKeyAuth(APIKeyInput{APIKey: "sk-test-1", BaseURL: ""})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth: %v", err)
	}
	digest := sha256.Sum256([]byte("sk-test-1"))
	fingerprint := hex.EncodeToString(digest[:])[:16]
	want := "api_key:codex:https://api.openai.com/v1:" + fingerprint
	if got := auth.IdentitySeed(); got != want {
		t.Fatalf("identity seed = %q, want %q", got, want)
	}
	if len(auth.Fingerprint()) != 16 {
		t.Fatalf("fingerprint length = %d, want 16", len(auth.Fingerprint()))
	}
}
