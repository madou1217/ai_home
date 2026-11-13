package qoderstorage

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/application/accountprojection"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const payloadInitial = `{"credentials":"opaque-blob-1","machineId":"machine-1","dnsCache":{"host":"1.2.3.4"},"userInfo":{"uid":"qoderuser1","security_oauth_token":"eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJxb2Rlci11c2VyLTEiLCJpYXQiOjE3MDAwMDAwMDB9.sig"}}`

func testCredential(t *testing.T) *accountcore.NativeCredential {
	t.Helper()
	identity, err := accountcore.NewNativeQoderIdentity("qoder", "qoderuser1")
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(
		identity,
		[]byte(payloadInitial),
		accountcore.NativeGeneration{Scope: "qoder.access.iat", Value: 1_700_000_000_000},
	)
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	return credential
}

func TestPolicyShape(t *testing.T) {
	policy, ok := Policy("qoder")
	if !ok {
		t.Fatal("缺少 qoder 策略")
	}
	if policy.Mode != accountprojection.ModeConfigDir || len(policy.NativeRoot) != 0 {
		t.Fatalf("policy = %s/%v", policy.Mode, policy.NativeRoot)
	}
	if len(policy.AuthArtifacts) != 3 {
		t.Fatalf("artifacts = %d", len(policy.AuthArtifacts))
	}
	if _, ok := Policy("codex"); ok {
		t.Fatal("codex 不应命中 qoder 策略")
	}
}

func TestMaterializeAndCapture(t *testing.T) {
	root := t.TempDir()
	materializer, ok := NewMaterializer("qoder")
	if !ok {
		t.Fatal("缺少 materializer")
	}
	policy, _ := Policy("qoder")
	request := accountprojection.Request{ProviderID: "qoder", Credential: testCredential(t)}
	writes, err := materializer.Materialize(context.Background(), request, policy, root)
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if len(writes) != 3 {
		t.Fatalf("writes = %d, want credentials+machine+dns", len(writes))
	}
	for _, write := range writes {
		if err := os.MkdirAll(filepath.Dir(write.Path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(write.Path, write.Data, write.Mode); err != nil {
			t.Fatal(err)
		}
	}
	next, changed, err := materializer.Capture(context.Background(), request, policy, root)
	if err != nil || !changed {
		t.Fatalf("Capture: changed=%v err=%v", changed, err)
	}
	if materializer.ShouldAdopt(request.Credential, next) {
		t.Fatal("同一份凭据不应回写")
	}
}

func TestCaptureAdoptsRewrittenCredentials(t *testing.T) {
	root := t.TempDir()
	materializer, _ := NewMaterializer("qoder")
	policy, _ := Policy("qoder")
	request := accountprojection.Request{ProviderID: "qoder", Credential: testCredential(t)}
	if _, err := materializer.Materialize(context.Background(), request, policy, root); err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(root, ".auth"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".auth", "user"), []byte("opaque-blob-2"), 0o600); err != nil {
		t.Fatal(err)
	}
	next, changed, err := materializer.Capture(context.Background(), request, policy, root)
	if err != nil || !changed {
		t.Fatalf("Capture: changed=%v err=%v", changed, err)
	}
	if !materializer.ShouldAdopt(request.Credential, next) {
		t.Fatal("CLI 改写的 credentials 应回写")
	}
}
