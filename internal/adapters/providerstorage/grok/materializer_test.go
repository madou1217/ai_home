package grokstorage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/application/accountprojection"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const grokPayload = `{"auth":{"user_id":"grok-user-1","key":"xai-key-value","refresh_token":"xai-refresh-value"}}`

func testCredential(t *testing.T) *accountcore.NativeCredential {
	t.Helper()
	identity, err := accountcore.NewNativeGrokIdentity([]string{"grok-user-1"})
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, []byte(grokPayload))
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	return credential
}

func TestPolicyShape(t *testing.T) {
	policy := Policy()
	if policy.Provider != "grok" || policy.Mode != accountprojection.ModeConfigDir {
		t.Fatalf("policy = %s/%s", policy.Provider, policy.Mode)
	}
	if len(policy.Env) != 1 || policy.Env[0].Key != "GROK_HOME" {
		t.Fatalf("env = %#v", policy.Env)
	}
	if len(policy.SharedEntries) != 3 || policy.SharedEntries[0] != "sessions" {
		t.Fatalf("shared = %v", policy.SharedEntries)
	}
}

func TestMaterializeAndCapture(t *testing.T) {
	root := t.TempDir()
	request := accountprojection.Request{ProviderID: "grok", Credential: testCredential(t)}
	writes, err := (Materializer{}).Materialize(context.Background(), request, Policy(), root)
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if len(writes) != 1 || writes[0].Path != filepath.Join(root, ".grok", "auth.json") {
		t.Fatalf("writes = %#v", writes)
	}
	// Provisioner 负责落盘；这里模拟它，再验证 Capture 能读回。
	if err := os.MkdirAll(filepath.Join(root, ".grok"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(writes[0].Path, writes[0].Data, writes[0].Mode); err != nil {
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

func TestMaterializeKeepsNewerDiskFile(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, ".grok")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	refreshed := `{"user_id":"grok-user-1","key":"xai-refreshed-key","refresh_token":"xai-refresh-value"}`
	if err := os.WriteFile(filepath.Join(directory, "auth.json"), []byte(refreshed), 0o600); err != nil {
		t.Fatal(err)
	}
	request := accountprojection.Request{ProviderID: "grok", Credential: testCredential(t)}
	writes, err := (Materializer{}).Materialize(context.Background(), request, Policy(), root)
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if len(writes) != 0 {
		t.Fatalf("writes = %d，磁盘续期结果被旧快照覆盖", len(writes))
	}
}

func TestCaptureRejectsIdentityMismatch(t *testing.T) {
	root := t.TempDir()
	request := accountprojection.Request{ProviderID: "grok", Credential: testCredential(t)}
	if err := os.MkdirAll(filepath.Join(root, ".grok"), 0o700); err != nil {
		t.Fatal(err)
	}
	otherIdentity := `{"user_id":"grok-user-2","key":"xai-key-value","refresh_token":"xai-refresh-value"}`
	if err := os.WriteFile(filepath.Join(root, ".grok", "auth.json"), []byte(otherIdentity), 0o600); err != nil {
		t.Fatal(err)
	}
	_, _, err := (Materializer{}).Capture(context.Background(), request, Policy(), root)
	if !errors.Is(err, ErrIdentityMismatch) {
		t.Fatalf("err = %v，想要 ErrIdentityMismatch", err)
	}
}
