package nativeaccount

import (
	"encoding/base64"
	"encoding/json"
	"testing"
)

// 这些用例复现真机上被 Go 误判为 invalid_native_artifacts 的凭据形态（全部为合成数据）。

func fakeJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	body, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	return header + "." + base64.RawURLEncoding.EncodeToString(body) + ".c2ln"
}

func decodeReal(t *testing.T, provider string, native map[string]any) error {
	t.Helper()
	raw, err := json.Marshal(native)
	if err != nil {
		t.Fatal(err)
	}
	envelope, _ := json.Marshal(map[string]json.RawMessage{"native_auth_json": raw})
	_, _, err = NewDecoder().Decode(provider, envelope)
	return err
}

func TestZcodeAccessTokenNumericZaiUserIDIsNotAConflict(t *testing.T) {
	const zcodeUser = "4a1c9d2e-0000-4000-8000-000000000001"
	userInfo, _ := json.Marshal(map[string]any{"user_id": zcodeUser, "email": "a@example.com"})
	native := map[string]any{"credentials": map[string]any{
		"zcodejwttoken":          fakeJWT(t, map[string]any{"user_id": zcodeUser, "sub": zcodeUser}),
		"oauth:zai:access_token": fakeJWT(t, map[string]any{"user_id": 31415926, "api_key": "x"}),
		"oauth:zai:user_info":    string(userInfo),
	}}
	if err := decodeReal(t, "zcode", native); err != nil {
		t.Fatalf("real zcode shape must decode, got %v", err)
	}
	// 真正的串号（ZCode JWT 与 user_info 不一致）仍然拒绝。
	native["credentials"].(map[string]any)["zcodejwttoken"] = fakeJWT(t, map[string]any{"user_id": "someone-else"})
	if err := decodeReal(t, "zcode", native); err == nil {
		t.Fatal("mismatched zcode subject must still be rejected")
	}
}

func TestClineAccountIDMayMatchExternalID(t *testing.T) {
	token := clineAccessTokenPrefix + fakeJWT(t, map[string]any{"sub": "user_01ABC", "external_id": "usr-0abc"})
	native := map[string]any{"auth": map[string]any{"providers": map[string]any{"cline": map[string]any{
		"settings": map[string]any{"auth": map[string]any{"accessToken": token, "refreshToken": "r", "accountId": "usr-0abc"}},
	}}}}
	if err := decodeReal(t, "cline", native); err != nil {
		t.Fatalf("accountId equal to external_id must decode, got %v", err)
	}
	native["auth"].(map[string]any)["providers"].(map[string]any)["cline"].(map[string]any)["settings"].(map[string]any)["auth"].(map[string]any)["accountId"] = "usr-other"
	if err := decodeReal(t, "cline", native); err == nil {
		t.Fatal("accountId matching neither sub nor external_id must be rejected")
	}
}

func TestQoderOpaqueEncryptedCredentialsAreAccepted(t *testing.T) {
	native := map[string]any{
		"credentials": "QUDWJ07opaqueEncryptedBlobFromQoderCli",
		"machineId":   "11111111-2222-3333-4444-555555555555",
		"userInfo":    map[string]any{"uid": "0f1e2d3c-0000-4000-8000-000000000002", "email": "q@example.com"},
	}
	if err := decodeReal(t, "qoder", native); err != nil {
		t.Fatalf("qoder with opaque credentials must decode, got %v", err)
	}
	delete(native, "credentials")
	if err := decodeReal(t, "qoder", native); err == nil {
		t.Fatal("qoder with no secret anywhere must be rejected")
	}
}

func TestOpenCodeConsoleIdentityComesFromMetadata(t *testing.T) {
	native := map[string]any{"auth": map[string]any{"opencode": map[string]any{
		"type": "oauth", "methodID": "github", "access": "opaque-access", "refresh": "opaque-refresh", "expires": 1,
		"metadata": map[string]any{"accountID": "acc_01XYZ", "email": "o@example.com", "orgID": "org_1"},
	}}}
	if err := decodeReal(t, "opencode", native); err != nil {
		t.Fatalf("opencode console oauth must decode, got %v", err)
	}
	delete(native["auth"].(map[string]any)["opencode"].(map[string]any), "metadata")
	if err := decodeReal(t, "opencode", native); err == nil {
		t.Fatal("opencode oauth without any identity must be rejected")
	}
}
