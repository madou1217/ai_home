package geministorage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/accountprojection"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const initialPayload = `{"googleAccounts":{"active":"gemini.test@example.com","old":[]},"oauthCreds":{"access_token":"ya29.gemini-token-value","refresh_token":"1//gemini-refresh-value","token_type":"Bearer","expiry_date":4070903045000}}`
const refreshedPayload = `{"googleAccounts":{"active":"gemini.test@example.com","old":[]},"oauthCreds":{"access_token":"ya29.gemini-refreshed-value","refresh_token":"1//gemini-refresh-value","token_type":"Bearer","expiry_date":4070903046000}}`

func testCredential(t *testing.T, payload string, expiryMS int64) *accountcore.NativeCredential {
	t.Helper()
	identity, err := accountcore.NewNativeEmailIdentity("gemini", "gemini.test@example.com")
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(
		identity,
		[]byte(payload),
		accountcore.NativeGeneration{Scope: "google.expiry_date", Value: expiryMS},
	)
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	return credential
}

func TestPolicyShape(t *testing.T) {
	policy := Policy()
	if policy.Provider != "gemini" || policy.Mode != accountprojection.ModeConfigDir {
		t.Fatalf("policy = %#v", policy)
	}
	if len(policy.NativeRoot) != 1 || policy.NativeRoot[0] != ".gemini" {
		t.Fatalf("native root = %v", policy.NativeRoot)
	}
	if len(policy.Env) != 2 || policy.Env[0].Key != "GEMINI_CLI_HOME" || policy.Env[1].Key != "GEMINI_CLI_SYSTEM_SETTINGS_PATH" {
		t.Fatalf("env = %#v", policy.Env)
	}
	if len(policy.AuthArtifacts) != 2 || policy.AuthArtifacts[0].Field != "oauthCreds" || !policy.AuthArtifacts[1].Optional {
		t.Fatalf("artifacts = %#v", policy.AuthArtifacts)
	}
	if len(policy.SharedEntries) != 3 || policy.SharedEntries[0] != "history" {
		t.Fatalf("shared = %v", policy.SharedEntries)
	}
}

func TestMaterializeWritesOfficialFiles(t *testing.T) {
	root := t.TempDir()
	request := accountprojection.Request{ProviderID: "gemini", Credential: testCredential(t, initialPayload, 4070903045000)}
	writes, err := Materializer{}.Materialize(context.Background(), request, Policy(), root)
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if len(writes) != 2 {
		t.Fatalf("writes = %d, want 2", len(writes))
	}
	oauthPath := filepath.Join(root, ".gemini", "oauth_creds.json")
	if writes[0].Path != oauthPath {
		t.Fatalf("path = %q, want %q", writes[0].Path, oauthPath)
	}
	if writes[0].Mode != 0o600 || writes[1].Mode != 0o600 {
		t.Fatalf("mode = %v/%v", writes[0].Mode, writes[1].Mode)
	}
	if !strings.Contains(string(writes[0].Data), "ya29.gemini-token-value") {
		t.Fatalf("oauth data = %s", writes[0].Data)
	}
	if !strings.Contains(string(writes[1].Data), "gemini.test@example.com") {
		t.Fatalf("accounts data = %s", writes[1].Data)
	}
}

func TestMaterializeKeepsExistingOAuthCreds(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, ".gemini")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	oauthPath := filepath.Join(directory, "oauth_creds.json")
	if err := os.WriteFile(oauthPath, []byte(refreshedPayloadExtract), 0o600); err != nil {
		t.Fatal(err)
	}
	request := accountprojection.Request{ProviderID: "gemini", Credential: testCredential(t, initialPayload, 4070903045000)}
	writes, err := Materializer{}.Materialize(context.Background(), request, Policy(), root)
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	if len(writes) != 0 {
		t.Fatalf("writes = %d, want 0（磁盘上的续期结果不能被旧快照覆盖）", len(writes))
	}
}

func TestCaptureReadsRefreshedCredential(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, ".gemini")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "oauth_creds.json"), []byte(refreshedOAuthCreds), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "google_accounts.json"), []byte(googleAccountsDocument), 0o600); err != nil {
		t.Fatal(err)
	}
	current := testCredential(t, initialPayload, 4070903045000)
	request := accountprojection.Request{ProviderID: "gemini", Credential: current}
	next, changed, err := Materializer{}.Capture(context.Background(), request, Policy(), root)
	if err != nil {
		t.Fatalf("Capture: %v", err)
	}
	if !changed || next == nil {
		t.Fatalf("changed = %v next = %v", changed, next)
	}
	if !(Materializer{}).ShouldAdopt(current, next) {
		t.Fatal("ShouldAdopt 应接受更晚的 expiry_date")
	}
}

func TestCaptureRejectsIdentityMismatch(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, ".gemini")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "oauth_creds.json"), []byte(refreshedOAuthCreds), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "google_accounts.json"), []byte(otherAccountsDocument), 0o600); err != nil {
		t.Fatal(err)
	}
	request := accountprojection.Request{ProviderID: "gemini", Credential: testCredential(t, initialPayload, 4070903045000)}
	_, _, err := Materializer{}.Capture(context.Background(), request, Policy(), root)
	if !errors.Is(err, ErrIdentityMismatch) {
		t.Fatalf("err = %v，想要 ErrIdentityMismatch", err)
	}
}

func TestCaptureWithoutGoogleAccountsIsNoChange(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, ".gemini")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "oauth_creds.json"), []byte(refreshedOAuthCreds), 0o600); err != nil {
		t.Fatal(err)
	}
	request := accountprojection.Request{ProviderID: "gemini", Credential: testCredential(t, initialPayload, 4070903045000)}
	_, changed, err := Materializer{}.Capture(context.Background(), request, Policy(), root)
	if err != nil || changed {
		t.Fatalf("changed = %v err = %v", changed, err)
	}
}

const refreshedPayloadExtract = `{"access_token":"ya29.disk-token-value","refresh_token":"1//gemini-refresh-value","token_type":"Bearer","expiry_date":4070903049000}`
const refreshedOAuthCreds = refreshedPayloadExtract
const googleAccountsDocument = `{"active":"gemini.test@example.com","old":[]}`
const otherAccountsDocument = `{"active":"other.user@example.com","old":[]}`
