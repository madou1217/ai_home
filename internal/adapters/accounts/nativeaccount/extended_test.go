package nativeaccount_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

func TestExtendedDecoderDerivesStableProviderIdentity(t *testing.T) {
	t.Parallel()
	globalIssuer := "https://www.codebuddy.ai/auth/realms/copilot"
	workIssuer := "https://www.workbuddy.ai/auth/realms/copilot"
	cnIssuer := "https://www.workbuddy.cn/auth/realms/copilot"
	tests := []struct {
		provider, want string
		auth           map[string]any
	}{
		{"gemini", "oauth:gemini:user@example.invalid", map[string]any{"googleAccounts": map[string]any{"active": "User@Example.Invalid"}, "oauthCreds": map[string]any{"refresh_token": "gemini-refresh"}}},
		{"opencode", "oauth:opencode:auth:" + hash16("opencode-go:oauth:id:user-42"), map[string]any{"auth": map[string]any{"opencode-go": map[string]any{"type": "oauth", "account_id": "user-42", "refresh": "rotate-1"}}}},
		{"grok", "oauth:grok:auth:" + hash16("id:grok-user"), map[string]any{"auth": map[string]any{"default": map[string]any{"user_id": "grok-user", "email": "ignored@example.invalid", "access_token": "access"}}}},
		{"qoder", "oauth:qoder:uid:qoder-id", map[string]any{"userInfo": map[string]any{"email": "Qoder@Example.Invalid", "uid": "qoder-id", "security_oauth_token": "token"}}},
		{"qodercn", "oauth:qodercn:uid:qoder-cn-id", map[string]any{"userInfo": map[string]any{"uid": "qoder-cn-id", "security_oauth_token": "token"}}},
		{"kimi", "oauth:kimi:user:" + hash16("kimi-user"), map[string]any{"credentials": map[string]any{"user_id": "kimi-user", "refresh_token": jwt(t, map[string]any{"sub": "kimi-user"})}}},
		{"zcode", "oauth:zcode:user:" + hash16("zcode-user"), map[string]any{"credentials": map[string]any{"oauth:zai:user_info": `{"user_id":"zcode-user"}`, "zcodejwttoken": jwt(t, map[string]any{"sub": "zcode-user"})}}},
		{"codebuddy", "oauth:codebuddy:user:" + hash16("cb-user"), buddyAuth(t, globalIssuer, "cb-user")},
		{"codebuddycn", "oauth:codebuddycn:user:" + hash16("cbcn-user"), buddyAuth(t, cnIssuer, "cbcn-user")},
		{"workbuddy", "oauth:workbuddy:user:" + hash16("wb-user"), buddyAuth(t, workIssuer, "wb-user")},
		{"workbuddycn", "oauth:workbuddycn:user:" + hash16("wbcn-user"), buddyAuth(t, cnIssuer, "wbcn-user")},
	}
	decoder := nativeaccount.NewDecoder()
	for _, test := range tests {
		test := test
		t.Run(test.provider, func(t *testing.T) {
			t.Parallel()
			credential, profile, err := decoder.Decode(test.provider, envelope(t, test.auth))
			if err != nil {
				t.Fatalf("Decode() error = %v", err)
			}
			if profile != nil || credential.ProviderID() != test.provider || credential.IdentitySeed() != test.want {
				t.Fatalf("credential = %#v profile=%T, want %q", credential, profile, test.want)
			}
			native, ok := credential.(*accountcore.NativeCredential)
			if !ok || native.AuthKind() != "oauth" {
				t.Fatalf("credential type = %T", credential)
			}
			if got := fmt.Sprintf("%v %#v", native, native); containsAny(got, "rotate-1", "gemini-refresh", "security_oauth_token") {
				t.Fatalf("安全格式化泄漏 secret: %s", got)
			}
		})
	}
}

func TestExtendedDecoderRejectsUnverifiableAndMixedIdentity(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name, provider string
		auth           map[string]any
	}{
		{"kiro token only", "kiro", map[string]any{"auth": map[string]any{"refresh_token": "must-not-be-identity"}}},
		{"kimi token only", "kimi", map[string]any{"credentials": map[string]any{"refresh_token": "opaque-token"}}},
		{"zcode email only", "zcode", map[string]any{"credentials": map[string]any{"oauth:zai:user_info": `{"email":"unstable@example.invalid"}`, "zcodejwttoken": "opaque"}}},
		{"opencode email only", "opencode", map[string]any{"auth": map[string]any{"opencode-go": map[string]any{"email": "unstable@example.invalid", "refresh": "opaque"}}}},
		{"codebuddy subject mismatch", "codebuddy", buddyMismatch(t)},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			_, _, err := nativeaccount.NewDecoder().Decode(test.provider, envelope(t, test.auth))
			if !errors.Is(err, nativeaccount.ErrInvalidNativeArtifacts) {
				t.Fatalf("error=%v", err)
			}
		})
	}
}

func envelope(t *testing.T, auth map[string]any) []byte {
	t.Helper()
	raw, err := json.Marshal(map[string]any{"native_auth_json": auth})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
func hash16(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])[:16]
}
func jwt(t *testing.T, claims map[string]any) string {
	t.Helper()
	body, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	return "e30." + base64.RawURLEncoding.EncodeToString(body) + ".signature"
}
func buddyAuth(t *testing.T, issuer, uid string) map[string]any {
	return map[string]any{
		"credentials": map[string]any{
			"account": map[string]any{"uid": uid},
			"auth": map[string]any{
				"domain":       issuerDomainForTest(issuer),
				"accessToken":  jwt(t, map[string]any{"iss": issuer, "sub": uid}),
				"refreshToken": jwt(t, map[string]any{"iss": issuer, "sub": uid}),
			},
		},
	}
}
func issuerDomainForTest(issuer string) string {
	value := strings.TrimPrefix(issuer, "https://")
	if index := strings.IndexByte(value, '/'); index >= 0 {
		return value[:index]
	}
	return value
}
func buddyMismatch(t *testing.T) map[string]any {
	value := buddyAuth(t, "https://www.codebuddy.ai/auth/realms/copilot", "one")
	value["credentials"].(map[string]any)["account"].(map[string]any)["uid"] = "two"
	return value
}
func containsAny(value string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(value, needle) {
			return true
		}
	}
	return false
}
