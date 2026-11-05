package nativeaccount

import (
	"testing"
)

func clineNative(accessToken string, expiresAt int64, lastUsed string) map[string]any {
	auth := map[string]any{
		"accessToken":  accessToken,
		"refreshToken": "r",
		"accountId":    "usr-0abc",
	}
	if expiresAt > 0 {
		auth["expiresAt"] = float64(expiresAt)
	}
	return map[string]any{"auth": map[string]any{
		"lastUsedProvider": lastUsed,
		"providers": map[string]any{
			"cline":      map[string]any{"settings": map[string]any{"auth": auth}},
			"cline-pass": map[string]any{"settings": map[string]any{"auth": auth}},
		},
	}}
}

func TestClineGenerationPrefersAccessTokenIat(t *testing.T) {
	token := clineAccessTokenPrefix + fakeJWT(t, map[string]any{"sub": "user_01ABC", "iat": 1793880000})
	generations := nativeGenerations("cline", clineNative(token, 1793900000000, "cline-pass"))
	if len(generations) != 1 {
		t.Fatalf("generations = %v, want 1", generations)
	}
	if generations[0].Scope != "cline.access.iat" {
		t.Fatalf("scope = %q", generations[0].Scope)
	}
	if generations[0].Value != 1793880000*1000 {
		t.Fatalf("value = %d, want iat*1000", generations[0].Value)
	}
}

func TestClineGenerationFallsBackToExpiry(t *testing.T) {
	token := clineAccessTokenPrefix + "not-a-jwt"
	generations := nativeGenerations("cline", clineNative(token, 1793900000000, "cline"))
	if len(generations) != 1 {
		t.Fatalf("generations = %v, want 1", generations)
	}
	if generations[0].Scope != "cline.expires_at" {
		t.Fatalf("scope = %q", generations[0].Scope)
	}
	if generations[0].Value != 1793900000000 {
		t.Fatalf("value = %d, want expiresAt 毫秒", generations[0].Value)
	}
}

// 两个 provider 槽位不同步时，只看 lastUsedProvider：否则会出现一新一旧的部分序。
func TestClineGenerationUsesSelectedProviderSlotOnly(t *testing.T) {
	native := map[string]any{"auth": map[string]any{
		"lastUsedProvider": "cline-pass",
		"providers": map[string]any{
			"cline": map[string]any{"settings": map[string]any{"auth": map[string]any{
				"accessToken": clineAccessTokenPrefix + "x", "expiresAt": float64(1000),
			}}},
			"cline-pass": map[string]any{"settings": map[string]any{"auth": map[string]any{
				"accessToken": clineAccessTokenPrefix + "y", "expiresAt": float64(2000),
			}}},
		},
	}}
	generations := nativeGenerations("cline", native)
	if len(generations) != 1 || generations[0].Value != 2000 {
		t.Fatalf("generations = %v, want 只有 lastUsedProvider 的 2000", generations)
	}
}

func TestClineGenerationMissingFacts(t *testing.T) {
	if generations := nativeGenerations("cline", map[string]any{}); len(generations) != 0 {
		t.Fatalf("空 native 不应产生代际: %v", generations)
	}
}
