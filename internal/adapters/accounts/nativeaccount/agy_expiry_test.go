package nativeaccount_test

import (
	"encoding/json"
	"testing"

	"github.com/madou1217/ai_home/core/accounts/agy"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

// TestDecodeAGYUsesLatestExpiryRepresentation 防回归：Node 刷新曾只更新 expiry、遗留陈旧的
// expires_at_ms；优先取毫秒字段会把刚刷新的 token 判成早已过期（生产 agy 经 Go 全部 401）。
func TestDecodeAGYUsesLatestExpiryRepresentation(t *testing.T) {
	t.Parallel()

	const staleMS = int64(1_790_000_000_000)
	const freshISO = "2026-09-25T01:41:50.160Z"
	const freshMS = int64(1_790_300_510_160)
	payload, err := json.Marshal(map[string]any{"native_auth_json": map[string]any{
		"email": "agy-expiry@example.com",
		"oauthToken": map[string]any{
			"auth_method": "consumer",
			"token": map[string]any{
				"access_token":  "ya29.synthetic-fresh-access",
				"refresh_token": "1//synthetic-refresh",
				"token_type":    "Bearer",
				"expiry":        freshISO,
				"expires_at_ms": staleMS,
			},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	credential, _, err := nativeaccount.NewDecoder().Decode("agy", payload)
	if err != nil {
		t.Fatalf("Decode(agy) error = %v", err)
	}
	auth, ok := credential.(*agy.OAuthAuth)
	if !ok {
		t.Fatalf("credential type = %T, want *agy.OAuthAuth", credential)
	}
	if auth.ExpiresAtMS() != freshMS {
		t.Fatalf("ExpiresAtMS() = %d, want the fresher expiry %d", auth.ExpiresAtMS(), freshMS)
	}
}
