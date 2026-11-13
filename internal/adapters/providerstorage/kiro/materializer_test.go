package kirostorage

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/application/accountprojection"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/kirodb"

	_ "modernc.org/sqlite"
)

const (
	region   = "us-east-1"
	endpoint = "https://codewhisperer.us-east-1.amazonaws.com"
	subject  = "kiro-user-1"
)

func writeDatabase(t *testing.T, path string, access string, refresh string) {
	t.Helper()
	database, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	if _, err := database.Exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)"); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec("CREATE TABLE migrations (id TEXT PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}
	token := map[string]any{"access_token": access, "refresh_token": refresh, "region": region, "expires_at": "2099-01-02T03:04:05.000Z"}
	encoded, err := json.Marshal(token)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec("INSERT INTO auth_kv(key, value) VALUES(?, ?)", "kirocli:odic:token", string(encoded)); err != nil {
		t.Fatal(err)
	}
}

func buildPayload(t *testing.T, databasePath string, access string, refresh string) []byte {
	t.Helper()
	token := map[string]any{"access_token": access, "refresh_token": refresh, "region": region}
	raw, err := json.Marshal(token)
	if err != nil {
		t.Fatal(err)
	}
	var authObject map[string]json.RawMessage
	if err := json.Unmarshal(raw, &authObject); err != nil {
		t.Fatal(err)
	}
	binding := kirodb.TokenBinding(authObject)
	if binding == "" {
		t.Fatal("tokenBinding 为空")
	}
	databaseBytes, err := os.ReadFile(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{
		"auth": json.RawMessage(raw),
		"identityEvidence": map[string]any{
			"version":      1,
			"source":       "aws-codewhisperer:GetUsageLimits",
			"endpoint":     endpoint,
			"subject":      subject,
			"tokenBinding": binding,
			"observedAtMs": 1_700_000_000_000,
		},
		"database": base64.StdEncoding.EncodeToString(databaseBytes),
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func testCredential(t *testing.T, payload []byte) *accountcore.NativeCredential {
	t.Helper()
	identity, err := accountcore.NewNativeKiroIdentity(endpoint, subject)
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, payload)
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	return credential
}

func TestPolicyShape(t *testing.T) {
	policy := Policy()
	if policy.Provider != "kiro" || policy.Mode != accountprojection.ModeConfigDir {
		t.Fatalf("policy = %s/%s", policy.Provider, policy.Mode)
	}
	if len(policy.Env) != 1 || policy.Env[0].Key != "KIRO_TEST_DB_PATH" {
		t.Fatalf("env = %#v", policy.Env)
	}
}

func TestMaterializeAndCapture(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(t.TempDir(), "source.sqlite3")
	writeDatabase(t, source, "access-1", "refresh-1")
	payload := buildPayload(t, source, "access-1", "refresh-1")
	request := accountprojection.Request{ProviderID: "kiro", Credential: testCredential(t, payload)}
	writes, err := (Materializer{}).Materialize(context.Background(), request, Policy(), root)
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}
	for _, write := range writes {
		if err := os.MkdirAll(filepath.Dir(write.Path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(write.Path, write.Data, write.Mode); err != nil {
			t.Fatal(err)
		}
	}
	projected, err := os.ReadFile(filepath.Join(root, databaseName))
	if err != nil || len(projected) == 0 {
		t.Fatalf("投影数据库缺失: %v", err)
	}
	next, changed, err := (Materializer{}).Capture(context.Background(), request, Policy(), root)
	if err != nil || !changed {
		t.Fatalf("Capture: changed=%v err=%v", changed, err)
	}
	if (Materializer{}).ShouldAdopt(request.Credential, next) {
		t.Fatal("同一份 grant 不应回写")
	}
}

func TestCaptureAdoptsNewGrant(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	writeDatabase(t, filepath.Join(root, databaseName), "access-2", "refresh-1")
	source := filepath.Join(t.TempDir(), "source.sqlite3")
	writeDatabase(t, source, "access-1", "refresh-1")
	payload := buildPayload(t, source, "access-1", "refresh-1")
	request := accountprojection.Request{ProviderID: "kiro", Credential: testCredential(t, payload)}
	next, changed, err := (Materializer{}).Capture(context.Background(), request, Policy(), root)
	if err != nil || !changed {
		t.Fatalf("Capture: changed=%v err=%v", changed, err)
	}
	if !(Materializer{}).ShouldAdopt(request.Credential, next) {
		t.Fatal("新 grant 应回写")
	}
}
