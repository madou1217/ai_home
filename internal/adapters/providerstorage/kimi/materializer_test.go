package kimistorage

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/accountprojection"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const payloadInitial = `{"credentials":{"access_token":"eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJraW1pLXVzZXItMSIsImlhdCI6MTcwMDAwMDAwMH0.sig","refresh_token":"kimi-refresh-1","user_id":"kimi-user-1"},"deviceId":"device-abc"}`
const credentialsRefreshed = `{"access_token":"eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJraW1pLXVzZXItMSIsImlhdCI6MTcwMDAwMzYwMH0.sig","refresh_token":"kimi-refresh-1","user_id":"kimi-user-1"}`

func testCredential(t *testing.T) *accountcore.NativeCredential {
	t.Helper()
	identity, err := accountcore.NewNativeSubjectIdentity("kimi", "kimi-user-1")
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(
		identity,
		[]byte(payloadInitial),
		accountcore.NativeGeneration{Scope: "kimi.access.iat", Value: 1_700_000_000_000},
	)
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	return credential
}

func TestPolicyShape(t *testing.T) {
	policy := Policy()
	if policy.Provider != "kimi" || policy.Mode != accountprojection.ModeConfigDir {
		t.Fatalf("policy = %s/%s", policy.Provider, policy.Mode)
	}
	if len(policy.Env) != 1 || policy.Env[0].Key != "KIMI_CODE_HOME" {
		t.Fatalf("env = %#v", policy.Env)
	}
	if len(policy.AuthArtifacts) != 2 || policy.AuthArtifacts[1].Field != "deviceId" {
		t.Fatalf("artifacts = %#v", policy.AuthArtifacts)
	}
}

func TestMaterializeAndCapture(t *testing.T) {
	root := t.TempDir()
	request := accountprojection.Request{ProviderID: "kimi", Credential: testCredential(t)}
	writes, err := (Materializer{}).Materialize(context.Background(), request, Policy(), root)
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if len(writes) != 3 {
		t.Fatalf("writes = %d, want config+credentials+device", len(writes))
	}
	for _, write := range writes {
		if err := os.MkdirAll(filepath.Dir(write.Path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(write.Path, write.Data, write.Mode); err != nil {
			t.Fatal(err)
		}
	}
	configRaw, err := os.ReadFile(filepath.Join(root, ".kimi-code", "config.toml"))
	if err != nil || !strings.Contains(string(configRaw), "managed:kimi-code") {
		t.Fatalf("config = %s err=%v", configRaw, err)
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
	directory := filepath.Join(root, ".kimi-code", "credentials")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "kimi-code.json"), []byte(credentialsRefreshed), 0o600); err != nil {
		t.Fatal(err)
	}
	request := accountprojection.Request{ProviderID: "kimi", Credential: testCredential(t)}
	next, changed, err := (Materializer{}).Capture(context.Background(), request, Policy(), root)
	if err != nil || !changed {
		t.Fatalf("Capture: changed=%v err=%v", changed, err)
	}
	if !(Materializer{}).ShouldAdopt(request.Credential, next) {
		t.Fatal("更晚的 iat 应回写")
	}
}
