package clinestorage

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/accountprojection"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const tokenInitial = "workos:eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ1c2VyX2NsaW5lXzEiLCJpYXQiOjE3MDAwMDAwMDB9.sig"
const tokenRefreshed = "workos:eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ1c2VyX2NsaW5lXzEiLCJpYXQiOjE3MDAwMDM2MDB9.sig"

func authDocument(token string) []byte {
	return []byte(`{"version":1,"lastUsedProvider":"cline","providers":{"cline":{"settings":{"auth":{"accessToken":"TOKEN","refreshToken":"refresh-1","expiresAt":4070903045000}}}}}`)
}

func nativePayload(t *testing.T, token string) []byte {
	t.Helper()
	inner := authDocument(token)
	inner = []byte(replaceToken(string(inner), token))
	wrapped, err := json.Marshal(map[string]json.RawMessage{"auth": inner})
	if err != nil {
		t.Fatalf("payload: %v", err)
	}
	return wrapped
}

func testCredential(t *testing.T, token string) *accountcore.NativeCredential {
	t.Helper()
	identity, err := accountcore.NewNativeSubjectIdentity("cline", "user_cline_1")
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(
		identity,
		nativePayload(t, token),
		accountcore.NativeGeneration{Scope: "cline.access.iat", Value: 1_700_000_000_000},
	)
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	return credential
}

func replaceToken(document string, token string) string {
	return strings.ReplaceAll(document, "TOKEN", token)
}

func TestPolicyShape(t *testing.T) {
	policy := Policy()
	if policy.Provider != "cline" || policy.Mode != accountprojection.ModeConfigDir {
		t.Fatalf("policy = %s/%s", policy.Provider, policy.Mode)
	}
	if len(policy.Env) != 2 || policy.Env[0].Key != "CLINE_DIR" || policy.Env[1].Key != "CLINE_DATA_DIR" {
		t.Fatalf("env = %#v", policy.Env)
	}
}

func TestMaterializeAndCapture(t *testing.T) {
	root := t.TempDir()
	request := accountprojection.Request{ProviderID: "cline", Credential: testCredential(t, tokenInitial)}
	writes, err := (Materializer{}).Materialize(context.Background(), request, Policy(), root)
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if len(writes) != 1 || writes[0].Path != filepath.Join(root, ".cline", "data", "settings", "providers.json") {
		t.Fatalf("writes = %#v", writes)
	}
	if err := os.MkdirAll(filepath.Dir(writes[0].Path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(writes[0].Path, writes[0].Data, 0o600); err != nil {
		t.Fatal(err)
	}
	next, changed, err := (Materializer{}).Capture(context.Background(), request, Policy(), root)
	if err != nil || !changed {
		t.Fatalf("Capture: changed=%v err=%v", changed, err)
	}
	if (Materializer{}).ShouldAdopt(request.Credential, next) {
		t.Fatal("同一份凭据不应回写")
	}
}

func TestCaptureAdoptsRefreshedToken(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, ".cline", "data", "settings")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	refreshed := []byte(replaceToken(string(authDocument(tokenRefreshed)), tokenRefreshed))
	if err := os.WriteFile(filepath.Join(directory, "providers.json"), refreshed, 0o600); err != nil {
		t.Fatal(err)
	}
	request := accountprojection.Request{ProviderID: "cline", Credential: testCredential(t, tokenInitial)}
	next, changed, err := (Materializer{}).Capture(context.Background(), request, Policy(), root)
	if err != nil || !changed {
		t.Fatalf("Capture: changed=%v err=%v", changed, err)
	}
	if !(Materializer{}).ShouldAdopt(request.Credential, next) {
		t.Fatal("更晚的 iat 应回写")
	}
}
