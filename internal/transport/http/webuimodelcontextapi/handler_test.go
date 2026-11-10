package webuimodelcontextapi

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
	_ "modernc.org/sqlite"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

type fakeMetadata struct{ values map[string]int }

func (fake fakeMetadata) LookupContextWindow(providerID string, modelID string) (int, bool) {
	value, ok := fake.values[modelID]
	return value, ok
}

const (
	mainRef   = "acct_0123456789abcdef0123"
	oauthRef  = "acct_0123456789abcdef0456"
	apiKeyRef = "acct_0123456789abcdef0789"
)

func seedAppState(t *testing.T, aiHomeDir string) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(aiHomeDir, "app-state.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = db.Close() }()
	for _, statement := range []string{
		"CREATE TABLE account_refs (account_ref TEXT PRIMARY KEY, provider TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
		"CREATE TABLE account_state (account_ref TEXT PRIMARY KEY, provider TEXT NOT NULL, status TEXT, configured INTEGER, display_name TEXT)",
		"CREATE TABLE account_credentials (account_ref TEXT PRIMARY KEY, env_json TEXT NOT NULL DEFAULT '{}', native_auth_json TEXT NOT NULL DEFAULT '{}', env_updated_at INTEGER NOT NULL DEFAULT 0, native_auth_updated_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)",
		"CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("schema: %v", err)
		}
	}
	for _, ref := range []string{mainRef, oauthRef, apiKeyRef} {
		if _, err := db.Exec("INSERT INTO account_refs VALUES (?, 'codex', 1, 1)", ref); err != nil {
			t.Fatalf("account_refs: %v", err)
		}
	}
	if _, err := db.Exec("INSERT INTO account_state VALUES (?, 'codex', 'up', 1, 'Main')", mainRef); err != nil {
		t.Fatalf("account_state: %v", err)
	}
	if _, err := db.Exec("INSERT INTO account_state VALUES (?, 'codex', 'up', 1, 'Second')", oauthRef); err != nil {
		t.Fatalf("account_state: %v", err)
	}
	if _, err := db.Exec("INSERT INTO account_state VALUES (?, 'codex', 'up', 1, 'Keyed')", apiKeyRef); err != nil {
		t.Fatalf("account_state: %v", err)
	}
	if _, err := db.Exec("INSERT INTO account_credentials VALUES (?, '{}', '{}', 0, 0, 1)", mainRef); err != nil {
		t.Fatalf("credentials: %v", err)
	}
	if _, err := db.Exec("INSERT INTO account_credentials VALUES (?, '{}', '{}', 0, 0, 1)", oauthRef); err != nil {
		t.Fatalf("credentials: %v", err)
	}
	if _, err := db.Exec("INSERT INTO account_credentials VALUES (?, '{\"OPENAI_API_KEY\":\"sk-key\"}', '{}', 0, 0, 1)", apiKeyRef); err != nil {
		t.Fatalf("credentials: %v", err)
	}
	overrides := "{\"" + mainRef + "\":{\"gpt-5\":64000},\"unknown-ref\":{\"gpt-5\":1000}}"
	if _, err := db.Exec("INSERT INTO app_kv VALUES (?, ?, 1)", overrideKey, overrides); err != nil {
		t.Fatalf("overrides: %v", err)
	}
	snapshot := "{\"contextLimits\":{\"" + mainRef + "\":{\"gpt-5-mini\":32000}}}"
	if _, err := db.Exec("INSERT INTO app_kv VALUES (?, ?, 1)", snapshotKey, snapshot); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
}

func newTestHandler(t *testing.T, aiHomeDir string, metadata Metadata) http.Handler {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: true},
		AIHomeDir:  aiHomeDir,
		Catalog:    catalog,
		Metadata:   metadata,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET "+Path+"/{provider}/{accountRef}/model-context", handler)
	mux.Handle("POST "+Path+"/{provider}/{accountRef}/model-context", handler)
	mux.Handle("DELETE "+Path+"/{provider}/{accountRef}/model-context", handler)
	mux.Handle("POST "+Path+"/{provider}/model-context/bulk", http.HandlerFunc(handler.ServeBulkHTTP))
	return mux
}

func requestModelContext(t *testing.T, handler http.Handler, provider string, accountRef string, query string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path+"/"+provider+"/"+accountRef+"/model-context"+query, nil))
	var payload map[string]any
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatalf("decode %q: %v", recorder.Body.String(), err)
		}
	}
	return recorder, payload
}

func TestResolutionOrderAndSiblings(t *testing.T) {
	aiHomeDir := t.TempDir()
	seedAppState(t, aiHomeDir)
	handler := newTestHandler(t, aiHomeDir, fakeMetadata{values: map[string]int{"gpt-5-nano": 128000}})

	recorder, payload := requestModelContext(t, handler, "codex", mainRef, "?models=gpt-5,gpt-5-mini,gpt-5-nano,unknown")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	rows := payload["models"].([]any)
	want := []struct {
		model    string
		tokens   float64
		source   string
		override float64
	}{
		{"gpt-5", 64000, "override", 64000},
		{"gpt-5-mini", 32000, "probed", 0},
		{"gpt-5-nano", 128000, "catalog", 0},
		{"unknown", 0, "unknown", 0},
	}
	for index, expected := range want {
		row := rows[index].(map[string]any)
		if row["model"] != expected.model || row["tokens"] != expected.tokens || row["source"] != expected.source || row["override"] != expected.override {
			t.Fatalf("row %d = %#v", index, row)
		}
	}
	limits := payload["limits"].(map[string]any)
	if limits["min"] != float64(minContextTokens) || limits["max"] != float64(maxContextTokens) {
		t.Fatalf("limits = %#v", limits)
	}
	if payload["credentialType"] != "oauth" {
		t.Fatalf("credentialType = %#v", payload["credentialType"])
	}
	siblings := payload["sameTypeAccounts"].([]any)
	if len(siblings) != 1 {
		t.Fatalf("siblings = %#v", siblings)
	}
	sibling := siblings[0].(map[string]any)
	if sibling["accountRef"] != oauthRef || sibling["credentialType"] != "oauth" || sibling["displayName"] != "Second" || sibling["disabled"] != false {
		t.Fatalf("sibling = %#v", sibling)
	}
}

func TestDefaultModelsUseOverrideKeys(t *testing.T) {
	aiHomeDir := t.TempDir()
	seedAppState(t, aiHomeDir)
	handler := newTestHandler(t, aiHomeDir, fakeMetadata{})

	_, payload := requestModelContext(t, handler, "codex", mainRef, "")
	rows := payload["models"].([]any)
	if len(rows) != 1 || rows[0].(map[string]any)["model"] != "gpt-5" {
		t.Fatalf("rows = %#v", rows)
	}
}

func TestErrorsAndAuth(t *testing.T) {
	aiHomeDir := t.TempDir()
	seedAppState(t, aiHomeDir)
	handler := newTestHandler(t, aiHomeDir, fakeMetadata{})

	recorder, _ := requestModelContext(t, handler, "claude", mainRef, "")
	if recorder.Code != http.StatusConflict {
		t.Fatalf("mismatch status = %d", recorder.Code)
	}
	recorder, _ = requestModelContext(t, handler, "codex", "acct_ffffffffffffffffffff", "")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("unknown status = %d", recorder.Code)
	}
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPut, Path+"/codex/"+mainRef+"/model-context", nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("PUT status = %d", recorder.Code)
	}

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("catalog: %v", err)
	}
	unauthorized, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{}, AIHomeDir: aiHomeDir, Catalog: catalog, Metadata: fakeMetadata{}})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle("GET "+Path+"/{provider}/{accountRef}/model-context", unauthorized)
	recorder = httptest.NewRecorder()
	mux.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path+"/codex/"+mainRef+"/model-context", nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", recorder.Code)
	}
}
