package sqliteaccount

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

// TestNativeAPIKeyCredentialRegistersAndRoundTrips 防回归：原生身份的 auth kind
// "api-key" 曾违反 account_credentials.auth_kind 的 [a-z0-9_] 约束，注册被当成
// 账号冲突，导入接口随后返回 account_not_found。
func TestNativeAPIKeyCredentialRegistersAndRoundTrips(t *testing.T) {
	store := openTestStore(t)
	payload, err := json.Marshal(map[string]any{"native_auth_json": map[string]any{
		"auth": map[string]any{"opencode": map[string]any{"type": "api", "key": "sk-opencode-fixture-0123456789"}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	credential, _, err := nativeaccount.NewDecoder().Decode("opencode", payload)
	if err != nil {
		t.Fatalf("Decode() error = %v", err)
	}
	request := newRegistrationRequest(t, store, credential, nil)
	account, err := store.RegisterNew(context.Background(), request)
	if err != nil {
		t.Fatalf("RegisterNew() error = %v", err)
	}
	restored, err := store.GetCredential(context.Background(), account.Ref())
	if err != nil {
		t.Fatalf("GetCredential() error = %v", err)
	}
	if restored.IdentitySeed() != credential.IdentitySeed() || restored.ProviderID() != "opencode" {
		t.Fatalf("restored identity=(%s,%s), want=(%s,opencode)", restored.ProviderID(), restored.IdentitySeed(), credential.IdentitySeed())
	}
	var storedKind string
	if err := store.db.QueryRow(`SELECT auth_kind FROM account_credentials WHERE account_ref = ?`, account.Ref().String()).Scan(&storedKind); err != nil {
		t.Fatal(err)
	}
	if storedKind != "api_key" {
		t.Fatalf("stored auth_kind = %q, want api_key", storedKind)
	}
}
