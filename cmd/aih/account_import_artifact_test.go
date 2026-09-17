package main

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExplicitNativeArtifactImportUsesSelectedFileAndRemoteControlPlane(t *testing.T) {
	file := filepath.Join(t.TempDir(), "native.json")
	document := `{"native_auth_json":{"googleAccounts":{"active":"fixture@example.invalid"},"oauthCreds":{"access_token":"fixture-not-real"}}}`
	if err := os.WriteFile(file, []byte(document), 0o600); err != nil {
		t.Fatal(err)
	}
	output := &bytes.Buffer{}
	runtime := testCommandRuntime(t, map[string]string{"AIH_SERVER_BASE_URL": "http://127.0.0.1:19527", "AIH_SERVER_MANAGEMENT_KEY": commandTestManagementKey})
	transport := &accountCatalogCommandHTTPClient{t: t, responses: []string{`{"data":{"account_ref":"acct_11111111111111111111","provider_id":"gemini","cli_account_id":1,"enabled":true,"has_credential":true,"auth_kind":"oauth","auth_mode":"native_auth_json","has_profile":false,"created_at":"2026-08-10T08:00:00Z","updated_at":"2026-08-10T08:00:00Z"}}`}}
	runtime.stdout = output
	runtime.managementAPI = transport
	if err := run(context.Background(), []string{"account", "import", "gemini", "--artifact-file", file}, runtime); err != nil {
		t.Fatal(err)
	}
	if transport.calls != 1 || !strings.Contains(transport.bodies[0], `"native_auth_json"`) {
		t.Fatal("native envelope was not submitted exactly once")
	}
	if strings.Contains(output.String(), "fixture-not-real") || strings.Contains(output.String(), document) {
		t.Fatal("CLI printed credentials")
	}
	bytes, err := os.ReadFile(file)
	if err != nil || string(bytes) != document {
		t.Fatal("input file was modified")
	}
}

func TestExplicitNativeArtifactRejectsSymbolicLinkAndInvalidIdentity(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "native.json")
	if err := os.WriteFile(file, []byte(`{"native_auth_json":{"auth":{"refresh_token":"opaque"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "linked.json")
	if err := os.Symlink(file, link); err == nil {
		if _, err := readExplicitNativeArtifact(link); err == nil {
			t.Fatal("symlink artifact accepted")
		}
	}
	runtime := testCommandRuntime(t, map[string]string{"AIH_SERVER_BASE_URL": "http://127.0.0.1:19527", "AIH_SERVER_MANAGEMENT_KEY": commandTestManagementKey})
	runtime.managementAPI = &unexpectedAccountCatalogHTTPClient{t: t}
	if err := run(context.Background(), []string{"account", "import", "kiro", "--artifact-file", file}, runtime); err == nil {
		t.Fatal("unverifiable identity submitted")
	}
}
