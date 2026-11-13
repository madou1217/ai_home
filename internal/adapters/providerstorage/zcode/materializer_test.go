package zcodestorage

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/application/accountprojection"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const payloadInitial = `{"credentials":{"oauth:zai:user_info":"{\"user_id\":\"zcode-user-1\"}","zcodejwttoken":"eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ6Y29kZS11c2VyLTEiLCJpYXQiOjE3MDAwMDAwMDB9.sig","oauth:zai:access_token":"zai-access-1"},"config":{"endpoint":"https://zcode.example.test"}}`
const credentialsRefreshed = `{"oauth:zai:user_info":"{\"user_id\":\"zcode-user-1\"}","zcodejwttoken":"eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ6Y29kZS11c2VyLTEiLCJpYXQiOjE3MDAwMDM2MDB9.sig","oauth:zai:access_token":"zai-access-1"}`

func testCredential(t *testing.T) *accountcore.NativeCredential {
	t.Helper()
	identity, err := accountcore.NewNativeSubjectIdentity("zcode", "zcode-user-1")
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(
		identity,
		[]byte(payloadInitial),
		accountcore.NativeGeneration{Scope: "zcode.access.iat", Value: 1_700_000_000_000},
	)
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	return credential
}

func TestPolicyShape(t *testing.T) {
	policy := Policy()
	if policy.Provider != "zcode" || policy.Mode != accountprojection.ModeFakeHome {
		t.Fatalf("policy = %s/%s", policy.Provider, policy.Mode)
	}
	if len(policy.Env) != 2 || policy.Env[0].Key != "HOME" || policy.Env[1].Key != "ZCODE_DATA_BASE_DIR" {
		t.Fatalf("env = %#v", policy.Env)
	}
	if !policy.AuthArtifacts[0].LiveStore {
		t.Fatal("credentials 必须声明 liveStore")
	}
}

func TestMaterializeAndCapture(t *testing.T) {
	root := t.TempDir()
	request := accountprojection.Request{ProviderID: "zcode", Credential: testCredential(t)}
	writes, err := (Materializer{}).Materialize(context.Background(), request, Policy(), root)
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if len(writes) != 2 {
		t.Fatalf("writes = %d, want credentials+config", len(writes))
	}
	for _, write := range writes {
		if err := os.MkdirAll(filepath.Dir(write.Path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(write.Path, write.Data, write.Mode); err != nil {
			t.Fatal(err)
		}
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
	directory := filepath.Join(root, ".zcode", "v2")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "credentials.json"), []byte(credentialsRefreshed), 0o600); err != nil {
		t.Fatal(err)
	}
	request := accountprojection.Request{ProviderID: "zcode", Credential: testCredential(t)}
	next, changed, err := (Materializer{}).Capture(context.Background(), request, Policy(), root)
	if err != nil || !changed {
		t.Fatalf("Capture: changed=%v err=%v", changed, err)
	}
	if !(Materializer{}).ShouldAdopt(request.Credential, next) {
		t.Fatal("更晚的 iat 应回写")
	}
}
