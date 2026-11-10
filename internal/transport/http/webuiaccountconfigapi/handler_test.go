package webuiaccountconfigapi

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
	_ "modernc.org/sqlite"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

func newTestHandler(t *testing.T, aiHomeDir string) http.Handler {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: true},
		AIHomeDir:  aiHomeDir,
		Catalog:    catalog,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET "+Path+"/{provider}/{accountRef}/config-files", handler)
	return mux
}

func seedAppState(t *testing.T, aiHomeDir string, accountRef string, provider string, envJSON string, nativeJSON string, updatedAt int64) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(aiHomeDir, "app-state.db"))
	if err != nil {
		t.Fatalf("open app-state: %v", err)
	}
	defer func() { _ = db.Close() }()
	statements := []string{
		"CREATE TABLE IF NOT EXISTS account_refs (account_ref TEXT PRIMARY KEY, provider TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
		"CREATE TABLE IF NOT EXISTS account_credentials (account_ref TEXT PRIMARY KEY, env_json TEXT NOT NULL DEFAULT '{}', native_auth_json TEXT NOT NULL DEFAULT '{}', env_updated_at INTEGER NOT NULL DEFAULT 0, native_auth_updated_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("exec %q: %v", statement, err)
		}
	}
	if _, err := db.Exec("INSERT OR REPLACE INTO account_refs (account_ref, provider, created_at, updated_at) VALUES (?, ?, 1, 1)", accountRef, provider); err != nil {
		t.Fatalf("insert account_refs: %v", err)
	}
	if _, err := db.Exec("INSERT OR REPLACE INTO account_credentials (account_ref, env_json, native_auth_json, env_updated_at, native_auth_updated_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
		accountRef, envJSON, nativeJSON, updatedAt, updatedAt, updatedAt); err != nil {
		t.Fatalf("insert credentials: %v", err)
	}
}

func writeProjectionFile(t *testing.T, aiHomeDir string, provider string, accountRef string, relativePath string, content string) {
	t.Helper()
	root := filepath.Join(aiHomeDir, "run", "auth-projections", provider, accountRef)
	absolute := filepath.Join(root, filepath.FromSlash(relativePath))
	if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(absolute, []byte(content), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func getConfigFiles(t *testing.T, handler http.Handler, provider string, accountRef string, query string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path+"/"+provider+"/"+accountRef+"/config-files"+query, nil))
	var payload map[string]any
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode %q: %v", recorder.Body.String(), err)
		}
	}
	return recorder, payload
}

func filesByID(t *testing.T, payload map[string]any) map[string]map[string]any {
	t.Helper()
	result := map[string]map[string]any{}
	list, _ := payload["files"].([]any)
	for _, item := range list {
		file, _ := item.(map[string]any)
		id, _ := file["id"].(string)
		result[id] = file
	}
	return result
}

func TestCodexConfigFilesRedactedAndRaw(t *testing.T) {
	aiHomeDir := t.TempDir()
	accountRef := "acct_0123456789abcdef0123"
	seedAppState(t, aiHomeDir, accountRef, "codex", "{\"OPENAI_API_KEY\":\"sk-env-secret\",\"OPENAI_BASE_URL\":\"https://api\"}", "{}", 1700000000000)
	writeProjectionFile(t, aiHomeDir, "codex", accountRef, ".codex/auth.json", "{\"OPENAI_API_KEY\":\"sk-json-secret\"}")
	writeProjectionFile(t, aiHomeDir, "codex", accountRef, ".codex/config.toml", "model = \"gpt-5\"\napi_key = \"sk-proj-secret\"\n")
	handler := newTestHandler(t, aiHomeDir)

	recorder, payload := getConfigFiles(t, handler, "codex", accountRef, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	if payload["runtimeDirExists"] != true || payload["mode"] != "redacted" {
		t.Fatalf("payload = %#v", payload)
	}
	files := filesByID(t, payload)
	for _, id := range []string{"store:credentials", "projection:.codex/auth.json", "projection:.codex/config.toml"} {
		if _, ok := files[id]; !ok {
			t.Fatalf("missing %s in %#v", id, payload["files"])
		}
	}
	all := ""
	for _, file := range files {
		all += file["content"].(string)
	}
	if strings.Contains(all, "sk-env-secret") || strings.Contains(all, "sk-json-secret") || strings.Contains(all, "sk-proj-secret") {
		t.Fatalf("secret leaked: %s", all)
	}
	if !strings.Contains(all, "OPENAI_API_KEY") {
		t.Fatalf("expected redacted keys to remain visible: %s", all)
	}

	_, rawPayload := getConfigFiles(t, handler, "codex", accountRef, "?mode=raw")
	rawFiles := filesByID(t, rawPayload)
	if rawPayload["mode"] != "raw" {
		t.Fatalf("raw mode = %#v", rawPayload["mode"])
	}
	if !strings.Contains(rawFiles["projection:.codex/config.toml"]["content"].(string), "sk-proj-secret") {
		t.Fatalf("raw projection should keep secret: %#v", rawFiles["projection:.codex/config.toml"])
	}
	storeRaw := rawFiles["store:credentials"]["content"].(string)
	if !strings.Contains(storeRaw, "sk-env-secret") {
		t.Fatalf("raw store should keep secret: %s", storeRaw)
	}
}

func TestKiroEmbeddedDatabaseAndProjection(t *testing.T) {
	aiHomeDir := t.TempDir()
	accountRef := "acct_fedcba98765432100123"

	seedPath := filepath.Join(aiHomeDir, "seed.sqlite3")
	db, err := sql.Open("sqlite", seedPath)
	if err != nil {
		t.Fatalf("open seed: %v", err)
	}
	for _, statement := range []string{
		"CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)",
		"CREATE TABLE state (key TEXT PRIMARY KEY, value BLOB)",
		"CREATE TABLE history (id INTEGER)",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("seed schema: %v", err)
		}
	}
	if _, err := db.Exec("INSERT INTO auth_kv VALUES (?, ?)", "kirocli:social:token", "{\"access_token\":\"AT-SECRET\",\"refresh_token\":\"RT-SECRET\",\"provider\":\"google\",\"region\":\"us-east-1\"}"); err != nil {
		t.Fatalf("seed auth_kv: %v", err)
	}
	if _, err := db.Exec("INSERT INTO state VALUES (?, ?)", "api.codewhisperer.profile", []byte("{\"arn\":\"arn:aws:codewhisperer:profile/X\",\"profile_name\":\"Default\"}")); err != nil {
		t.Fatalf("seed state: %v", err)
	}
	_ = db.Close()
	databaseBytes, err := os.ReadFile(seedPath)
	if err != nil {
		t.Fatalf("read seed: %v", err)
	}
	databaseBase64 := base64.StdEncoding.EncodeToString(databaseBytes)

	nativeJSON := "{\"database\":\"" + databaseBase64 + "\",\"auth\":{\"access_token\":\"AT-SECRET\",\"region\":\"us-east-1\"},\"flavor\":\"desktop\"}"
	seedAppState(t, aiHomeDir, accountRef, "kiro", "{}", nativeJSON, 1700000000000)
	writeProjectionFile(t, aiHomeDir, "kiro", accountRef, ".kiro/settings/cli.json", "{\"chat.defaultModel\":\"claude\"}")
	writeProjectionFile(t, aiHomeDir, "kiro", accountRef, ".aih-kiro-auth-binding", strings.Repeat("a1b2c3d4", 8)+"\n")
	handler := newTestHandler(t, aiHomeDir)

	recorder, payload := getConfigFiles(t, handler, "kiro", accountRef, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	files := filesByID(t, payload)
	if _, ok := files["store:database"]; !ok {
		t.Fatalf("missing store:database: %#v", payload["files"])
	}
	store := files["store:credentials"]["content"].(string)
	if !strings.Contains(store, "<sqlite ") || !strings.Contains(store, "us-east-1") {
		t.Fatalf("store content = %s", store)
	}
	databaseJSON := files["store:database"]["content"].(string)
	if strings.Contains(databaseJSON, "AT-SECRET") || strings.Contains(databaseJSON, "RT-SECRET") {
		t.Fatalf("database secret leaked: %s", databaseJSON)
	}
	var database map[string]any
	if err := json.Unmarshal([]byte(databaseJSON), &database); err != nil {
		t.Fatalf("database json: %v", err)
	}
	authKV := database["auth_kv"].(map[string]any)["kirocli:social:token"].(map[string]any)
	if authKV["access_token"] != "<redacted>" || authKV["provider"] != "google" {
		t.Fatalf("auth_kv = %#v", authKV)
	}
	if database["history"].(map[string]any)["<rows>"] != float64(0) {
		t.Fatalf("history = %#v", database["history"])
	}
	binding := files["projection:.aih-kiro-auth-binding"]["content"].(string)
	if strings.Contains(binding, "a1b2c3d4") || !strings.Contains(binding, "<redacted>") {
		t.Fatalf("binding = %q", binding)
	}
	if !strings.Contains(files["projection:.kiro/settings/cli.json"]["content"].(string), "claude") {
		t.Fatalf("cli.json = %#v", files["projection:.kiro/settings/cli.json"])
	}
}

func TestErrorsAndAuth(t *testing.T) {
	aiHomeDir := t.TempDir()
	accountRef := "acct_0123456789abcdef0123"
	seedAppState(t, aiHomeDir, accountRef, "codex", "{}", "{}", 1700000000000)
	handler := newTestHandler(t, aiHomeDir)

	recorder, _ := getConfigFiles(t, handler, "claude", accountRef, "")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("mismatched provider status = %d", recorder.Code)
	}
	recorder, _ = getConfigFiles(t, handler, "codex", "acct_ffffffffffffffffffff", "")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("unknown account status = %d", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path+"/codex/"+accountRef+"/config-files", nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d", recorder.Code)
	}

	unauthorized, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{}, AIHomeDir: aiHomeDir})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET "+Path+"/{provider}/{accountRef}/config-files", unauthorized)
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path+"/codex/"+accountRef+"/config-files", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", recorder.Code)
	}
}
