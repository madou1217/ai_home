package opencodestorage

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/application/accountprojection"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const authInitial = `{"opencode":{"type":"oauth","access":"eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJvcGVuY29kZS11c2VyLTEiLCJpYXQiOjE3MDAwMDAwMDB9.sig","refresh":"refresh-1","account_id":"opencode-user-1"}}`

func testCredential(t *testing.T) *accountcore.NativeCredential {
	t.Helper()
	identity, err := accountcore.NewNativeOpenCodeIdentity([]accountcore.NativeOpenCodeGrant{
		{Upstream: "opencode", Type: "oauth", Subject: "opencode-user-1"},
	})
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	payload := []byte(`{"auth":` + authInitial + `}`)
	credential, err := accountcore.NewNativeCredential(identity, payload, accountcore.NativeGeneration{Scope: "opencode-go.iat", Value: 1_700_000_000_000})
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	return credential
}

func TestPolicyShape(t *testing.T) {
	policy := Policy()
	if policy.Provider != "opencode" || policy.Mode != accountprojection.ModeConfigDir {
		t.Fatalf("policy = %s/%s", policy.Provider, policy.Mode)
	}
	if len(policy.Env) != 3 || policy.Env[0].Key != "XDG_DATA_HOME" {
		t.Fatalf("env = %#v", policy.Env)
	}
	if len(policy.SharedHostCaches) != 1 || len(policy.SharedHostCaches[0].Exclude) == 0 {
		t.Fatalf("shared = %#v", policy.SharedHostCaches)
	}
}

func TestMaterializeWriteBridgeAndCapture(t *testing.T) {
	root := t.TempDir()
	request := accountprojection.Request{ProviderID: "opencode", Credential: testCredential(t)}
	writes, err := (Materializer{}).Materialize(context.Background(), request, Policy(), root)
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if len(writes) != 1 {
		t.Fatalf("writes = %d", len(writes))
	}
	for _, write := range writes {
		if err := os.MkdirAll(filepath.Dir(write.Path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(write.Path, write.Data, write.Mode); err != nil {
			t.Fatal(err)
		}
	}
	bridge := filepath.Join(root, bridgeAuthFile)
	target, err := os.Readlink(bridge)
	if err != nil || target != filepath.Join(root, accountAuthFile) {
		t.Fatalf("bridge link = %q err=%v", target, err)
	}
	next, changed, err := (Materializer{}).Capture(context.Background(), request, Policy(), root)
	if err != nil || !changed {
		t.Fatalf("Capture: changed=%v err=%v", changed, err)
	}
	if (Materializer{}).ShouldAdopt(request.Credential, next) {
		t.Fatal("同一份凭据不应回写")
	}
}
